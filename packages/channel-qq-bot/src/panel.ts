import type { ChannelCommand } from "@nokoribi/channel-core";
import type { Logger } from "@nokoribi/shared";

import { classifySendError, safeErrorFields } from "./errors.js";

/** Scenes the QQ command-panel API supports. */
export type QqPanelScope = "c2c" | "group";

/** One element rendered inside a QQ command panel. */
export interface QqPanelItem {
    readonly type: "command";
    readonly name: string;
    readonly desc: string;
}

/** Panel body accepted by the create/update endpoints. */
export interface QqPanelPayload {
    readonly items?: readonly QqPanelItem[];
    readonly remark?: string;
    readonly version?: number;
}

/** One panel record returned by `GET /v2/panels`. */
export interface QqPanelRecord {
    readonly panel_id: string;
    readonly scope: string;
    readonly target_type?: string;
    readonly panel?: QqPanelPayload;
}

/** Minimal QQ command-panel REST surface used by the synchronizer. */
export interface QqPanelClient {
    listPanels(scope: QqPanelScope): Promise<readonly QqPanelRecord[]>;
    createPanel(
        scope: QqPanelScope,
        panel: QqPanelPayload
    ): Promise<{ readonly panel_id: string }>;
    updatePanel(
        panelId: string,
        panel: QqPanelPayload
    ): Promise<{ readonly version: number }>;
}

/**
 * Marker stored in the panel remark so restarts can find the panel this
 * daemon owns. Panels without this remark are never touched.
 */
export const QQ_COMMAND_PANEL_REMARK = "nokoribi-agent:slash-commands";

/** The adapter only publishes a C2C panel (M18 scope decision). */
export const QQ_COMMAND_PANEL_SCOPES: readonly QqPanelScope[] = ["c2c"];

/** Platform cap: 20 elements per panel. */
export const MAX_PANEL_ITEMS = 20;

/** Platform cap: 14 characters for a command element name. */
export const MAX_PANEL_NAME_CHARS = 14;

/** Platform cap: 30 characters for a command element description. */
export const MAX_PANEL_DESC_CHARS = 30;

/** Delay before one retry of a retryable panel sync failure. */
const DEFAULT_RETRY_DELAY_MS = 30_000;

function characterCount(value: string): number {
    return Array.from(value).length;
}

/** Collapse whitespace and clamp one panel description to the platform cap. */
function clipDescription(description: string, fallback: string): string {
    const flat = description.replace(/\s+/g, " ").trim();
    const source = flat === "" ? fallback : flat;
    if (characterCount(source) <= MAX_PANEL_DESC_CHARS) return source;
    return `${Array.from(source)
        .slice(0, MAX_PANEL_DESC_CHARS - 1)
        .join("")}…`;
}

/**
 * Map registered commands onto QQ panel elements.
 *
 * Names are prefixed with `/` because QQ inserts the element name verbatim
 * into the chat input. A name that cannot fit is skipped instead of truncated:
 * a truncated command would no longer resolve.
 */
export function buildPanelItems(
    commands: readonly ChannelCommand[],
    logger: Logger
): QqPanelItem[] {
    const sorted = [...commands].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    const items: QqPanelItem[] = [];
    let warnedLimit = false;
    for (const command of sorted) {
        if (items.length >= MAX_PANEL_ITEMS) {
            if (!warnedLimit) {
                warnedLimit = true;
                logger.warn("qq bot command panel element limit reached", {
                    total: sorted.length,
                    limit: MAX_PANEL_ITEMS,
                });
            }
            break;
        }
        const name = `/${command.name}`;
        const nameLength = characterCount(name);
        if (nameLength > MAX_PANEL_NAME_CHARS) {
            logger.warn("qq bot command panel skipped long command name", {
                command: command.name,
                length: nameLength,
                limit: MAX_PANEL_NAME_CHARS,
            });
            continue;
        }
        items.push({
            type: "command",
            name,
            desc: clipDescription(command.description, command.name),
        });
    }
    return items;
}

function sameItems(
    existing: readonly QqPanelItem[] | undefined,
    desired: readonly QqPanelItem[]
): boolean {
    if (existing === undefined || existing.length !== desired.length) {
        return false;
    }
    return desired.every((item, index) => {
        const current = existing[index];
        return (
            current !== undefined &&
            current.type === "command" &&
            current.name === item.name &&
            current.desc === item.desc
        );
    });
}

/** Options for the command-panel synchronizer. */
export interface QqCommandPanelOptions {
    readonly client: QqPanelClient;
    readonly logger: Logger;
    /** Delay before the one retry of a retryable failure. */
    readonly retryDelayMs?: number;
}

/**
 * Idempotent QQ C2C command-panel synchronizer.
 *
 * Every sync lists existing panels first and claims the one carrying the
 * marker remark, so a restart updates instead of creating a duplicate. A
 * failed list never falls through to creation.
 */
export class QqCommandPanel {
    private readonly client: QqPanelClient;
    private readonly logger: Logger;
    private readonly retryDelayMs: number;
    private closed = false;
    private running = false;
    private pending: readonly ChannelCommand[] | undefined;
    private latest: readonly ChannelCommand[] | undefined;
    private lastSignature: string | undefined;
    private retryTimer: NodeJS.Timeout | undefined;
    private retried = false;
    private active: Promise<void> | undefined;

    constructor(options: QqCommandPanelOptions) {
        this.client = options.client;
        this.logger = options.logger;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    }

    /** Queue one catalog; concurrent calls coalesce onto the latest list. */
    sync(commands: readonly ChannelCommand[]): void {
        if (this.closed) return;
        this.latest = commands;
        this.pending = commands;
        this.retried = false;
        this.clearRetry();
        if (!this.running) this.startDrain();
    }

    /** Stop future syncs, cancel retries, and wait for the in-flight pass. */
    async stop(): Promise<void> {
        this.closed = true;
        this.pending = undefined;
        this.clearRetry();
        const active = this.active;
        if (active !== undefined) {
            await active.catch(() => undefined);
        }
    }

    private startDrain(): void {
        if (this.running) return;
        this.running = true;
        this.active = this.drain()
            .catch((error: unknown) => {
                this.logger.warn(
                    "qq bot command panel sync crashed",
                    safeErrorFields(error)
                );
            })
            .finally(() => {
                this.running = false;
                this.active = undefined;
            });
    }

    private async drain(): Promise<void> {
        for (;;) {
            const next = this.pending;
            if (next === undefined || this.closed) return;
            this.pending = undefined;
            const retry = await this.apply(next);
            if (retry && !this.closed && !this.retried) {
                this.retried = true;
                this.scheduleRetry();
            }
        }
    }

    /**
     * Apply one catalog to every configured scope.
     * @returns true when a retryable failure should be retried once.
     */
    private async apply(commands: readonly ChannelCommand[]): Promise<boolean> {
        const items = buildPanelItems(commands, this.logger);
        if (items.length === 0) {
            this.logger.debug("qq bot command panel skipped: no commands");
            return false;
        }
        const signature = JSON.stringify(items);
        if (signature === this.lastSignature) {
            this.logger.debug("qq bot command panel unchanged");
            return false;
        }
        let failed = false;
        let retry = false;
        for (const scope of QQ_COMMAND_PANEL_SCOPES) {
            if (this.closed) return false;
            try {
                await this.syncScope(scope, items);
            } catch (error) {
                failed = true;
                const kind = classifySendError(error);
                if (kind === "retry" || kind === "auth") retry = true;
                this.logger.warn("qq bot command panel sync failed", {
                    scope,
                    ...safeErrorFields(error),
                });
            }
        }
        if (!failed) this.lastSignature = signature;
        return retry;
    }

    /** Reconcile one scope: create only when no marked panel exists. */
    private async syncScope(
        scope: QqPanelScope,
        items: readonly QqPanelItem[]
    ): Promise<void> {
        const records = await this.client.listPanels(scope);
        const matches = records.filter(
            (record) =>
                record.scope === scope &&
                record.panel?.remark === QQ_COMMAND_PANEL_REMARK
        );
        if (matches.length > 1) {
            this.logger.warn("qq bot command panel duplicate remark", {
                scope,
                count: matches.length,
                panelId: matches[0]?.panel_id,
            });
        }
        const existing = matches[0];
        const panel: QqPanelPayload = {
            items,
            remark: QQ_COMMAND_PANEL_REMARK,
        };
        if (existing === undefined) {
            const created = await this.client.createPanel(scope, panel);
            this.logger.info("qq bot command panel created", {
                scope,
                panelId: created.panel_id,
                items: items.length,
            });
            return;
        }
        if (existing.target_type !== "all") {
            this.logger.warn("qq bot command panel target is not all", {
                scope,
                panelId: existing.panel_id,
                targetType: existing.target_type,
            });
        }
        if (sameItems(existing.panel?.items, items)) {
            this.logger.debug("qq bot command panel already in sync", {
                scope,
                panelId: existing.panel_id,
            });
            return;
        }
        const updated = await this.client.updatePanel(existing.panel_id, panel);
        this.logger.info("qq bot command panel updated", {
            scope,
            panelId: existing.panel_id,
            items: items.length,
            version: updated.version,
        });
    }

    private scheduleRetry(): void {
        this.clearRetry();
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            if (this.closed) return;
            this.pending = this.latest;
            if (!this.running) this.startDrain();
        }, this.retryDelayMs);
        this.retryTimer.unref();
    }

    private clearRetry(): void {
        if (this.retryTimer === undefined) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
    }
}
