import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { AssembleContext } from "@deepseek-ai/dsh-system-prompt";
import { isNodeError, type Logger } from "@nokoribi/shared";

import { renderMemorySnapshot } from "./snapshot.js";
import type { MemoryService } from "./store.js";
import { ENTRIES_DIR_NAME } from "./store.js";

/** Runtime-context name of the automatic memory snapshot (M16/D172). */
export const MEMORY_CONTEXT_NAME: string = "nokoribi:memory";

/** Placement after subagent delegation context and before harness context. */
export const MEMORY_CONTEXT_ORDER: number = 130;

/** Default for `inject.enable`. */
export const DEFAULT_INJECT_ENABLE: boolean = true;

/** Default character budget of the injected snapshot. */
export const DEFAULT_INJECT_MAX_CHARS: number = 3000;

/** Default entry budget of the injected snapshot. */
export const DEFAULT_INJECT_MAX_ENTRIES: number = 20;

/** Default for `inject.mainOnly`: inject only in root main sessions. */
export const DEFAULT_INJECT_MAIN_ONLY: boolean = true;

/** Default tags whose entries are included automatically. */
export const DEFAULT_INJECT_AUTO_TAGS: readonly string[] = [
    "type:person",
    "type:preference",
];

/** Resolved configuration of automatic snapshot injection. */
export interface MemoryInjectConfig {
    /** Register the runtime context and refresh per turn (default true). */
    readonly enable: boolean;
    /** Hard upper bound for the whole snapshot text. */
    readonly maxChars: number;
    /** Hard upper bound for rendered entries. */
    readonly maxEntries: number;
    /** Inject only in root (non-child) sessions. */
    readonly mainOnly: boolean;
    /** Tags whose entries are included automatically. */
    readonly autoTags: readonly string[];
}

/** One frozen snapshot for an open turn. */
interface FrozenSnapshot {
    readonly turn: number;
    readonly text: string;
}

/** Return an error message without a stack trace. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Read one optional boolean with a default. */
function resolveBoolean(
    value: boolean | undefined,
    fallback: boolean,
    field: string
): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
        throw new Error(
            `memory inject ${field} must be a boolean (got ${String(value)})`
        );
    }
    return value;
}

/** Read one optional positive integer with a default. */
function resolvePositiveInteger(
    value: number | undefined,
    fallback: number,
    field: string
): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(
            `memory inject ${field} must be a positive integer ` +
                `(got ${String(value)})`
        );
    }
    return value;
}

/** Normalize optional automatic-inclusion tags. */
function resolveAutoTags(
    tags: readonly string[] | undefined
): readonly string[] {
    if (tags === undefined) return [...DEFAULT_INJECT_AUTO_TAGS];
    const normalized: string[] = [];
    for (const raw of tags) {
        const tag = raw.trim();
        if (tag === "" || normalized.includes(tag)) continue;
        normalized.push(tag);
    }
    return normalized;
}

/**
 * Resolve the plugin's `inject` configuration, filling every default.
 * @param config - optional partial configuration from the deployment row.
 * @returns the resolved inject configuration.
 * @throws when a configured value is out of range.
 */
export function resolveInjectConfig(
    config: Partial<MemoryInjectConfig> | undefined
): MemoryInjectConfig {
    return {
        enable: resolveBoolean(config?.enable, DEFAULT_INJECT_ENABLE, "enable"),
        maxChars: resolvePositiveInteger(
            config?.maxChars,
            DEFAULT_INJECT_MAX_CHARS,
            "maxChars"
        ),
        maxEntries: resolvePositiveInteger(
            config?.maxEntries,
            DEFAULT_INJECT_MAX_ENTRIES,
            "maxEntries"
        ),
        mainOnly: resolveBoolean(
            config?.mainOnly,
            DEFAULT_INJECT_MAIN_ONLY,
            "mainOnly"
        ),
        autoTags: resolveAutoTags(config?.autoTags),
    };
}

/**
 * Owns the automatic memory snapshot: renders it once per turn, freezes it
 * for that turn, and pins the frozen text as a runtime-context contribution.
 *
 * The renderer output is cached; a `stat` of the entries directory on every
 * pre-step picks up external edits, and store mutations invalidate the cache
 * directly. Rendering and refresh failures are only logged: they never block
 * the turn or fail the daemon.
 */
export class MemorySnapshotInjector {
    private readonly service: MemoryService;
    private readonly config: MemoryInjectConfig;
    private readonly logger: Logger;
    private readonly entriesDir: string;
    private readonly frozen = new Map<string, FrozenSnapshot>();
    private currentText: string = "";
    private dirty: boolean = true;
    private signature: string | undefined;

    /**
     * Create an injector for one store; call {@link initialize} once and
     * {@link install} to register runtime-context contributions.
     * @param service - memory store providing entries and mutation events.
     * @param config - resolved inject configuration.
     * @param logger - structured logger for refresh/render failures.
     */
    constructor(
        service: MemoryService,
        config: MemoryInjectConfig,
        logger: Logger
    ) {
        this.service = service;
        this.config = config;
        this.logger = logger;
        this.entriesDir = join(service.root, ENTRIES_DIR_NAME);
    }

    /** Whether automatic injection is configured on. */
    get enabled(): boolean {
        return this.config.enable;
    }

    /** Snapshot text frozen for the latest rendered turn (tests/status). */
    get snapshotText(): string {
        return this.currentText;
    }

    /**
     * Render the first snapshot at startup and publish its observation.
     * Failures only log a warning; the injector keeps working with an empty
     * snapshot until the next turn retries.
     */
    async initialize(): Promise<void> {
        if (!this.config.enable) {
            this.service.setRuntimeStatus({
                enabled: false,
                snapshotChars: 0,
            });
            return;
        }
        try {
            await this.renderIfNeeded();
        } catch (error) {
            this.logger.warn("memory snapshot initial render failed", {
                error: errorMessage(error),
            });
        }
        this.publishStatus();
    }

    /**
     * Register the runtime context, the per-turn refresh listener, and the
     * mutation-cache invalidation. A disabled injector registers nothing, so
     * the agent loop clears a previously retained snapshot.
     * @param ctx - Cordis context that owns the registrations.
     */
    install(ctx: Context): void {
        if (!this.config.enable) return;
        ctx.effect(() =>
            this.service.onChange(() => {
                this.dirty = true;
            })
        );
        ctx.effect(() =>
            ctx.systemPrompt.context({
                name: MEMORY_CONTEXT_NAME,
                order: MEMORY_CONTEXT_ORDER,
                required: true,
                interpolate: false,
                text: (context: AssembleContext) => this.contextText(context),
            })
        );
        ctx.effect(() =>
            ctx.on("agent/pre-step", async (payload, next) => {
                try {
                    await this.refresh(payload.agent, payload.turn);
                } catch (error) {
                    this.logger.warn("memory snapshot refresh failed", {
                        error: errorMessage(error),
                    });
                }
                return next();
            })
        );
    }

    /**
     * Invalidate the rendered cache (used after mutations and by tests).
     * The frozen snapshot of the current turn is intentionally kept.
     */
    invalidate(): void {
        this.dirty = true;
    }

    /**
     * Freeze one snapshot for a new turn, or check freshness within a turn.
     *
     * The first pre-step of each turn re-renders when the cache is dirty or
     * the entries directory changed; later steps of the same turn only update
     * freshness so external edits are picked up by the next turn.
     * @param agent - agent owning the turn.
     * @param turn - durable turn number.
     */
    async refresh(agent: Agent, turn: number): Promise<void> {
        if (!this.eligible(agent)) return;
        await this.checkFreshness();
        const frozen = this.frozen.get(agent.id);
        if (frozen !== undefined && frozen.turn === turn) return;
        try {
            await this.renderIfNeeded();
        } catch (error) {
            this.logger.warn("memory snapshot refresh failed", {
                error: errorMessage(error),
            });
            this.frozen.set(agent.id, {
                turn,
                text: this.currentText,
            });
            return;
        }
        this.frozen.set(agent.id, { turn, text: this.currentText });
        this.publishStatus();
    }

    /** Resolve the runtime-context text for one assembly. */
    private contextText(context: AssembleContext): string {
        const agent = context.agent;
        if (agent === undefined || !this.eligible(agent)) return "";
        const frozen = this.frozen.get(agent.id);
        return frozen?.text ?? this.currentText;
    }

    /** Whether this agent receives the snapshot under `mainOnly`. */
    private eligible(agent: Agent): boolean {
        if (!this.config.enable) return false;
        const header = agent.session.header;
        const root =
            header.origin !== "subagent" && header.parentSession === undefined;
        return root || !this.config.mainOnly;
    }

    /** Re-render the cached snapshot when dirty or externally changed. */
    private async renderIfNeeded(): Promise<void> {
        await this.checkFreshness();
        if (!this.dirty) return;
        const entries = await this.service.listActive();
        const snapshot = renderMemorySnapshot(entries, {
            maxChars: this.config.maxChars,
            maxEntries: this.config.maxEntries,
            autoTags: this.config.autoTags,
        });
        this.currentText = snapshot.text;
        this.dirty = false;
    }

    /** Compare the entries directory signature with the cached one. */
    private async checkFreshness(): Promise<void> {
        let signature: string;
        try {
            const info = await stat(this.entriesDir);
            signature = `${String(info.mtimeMs)}:${String(info.size)}`;
        } catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT") throw error;
            signature = "missing";
        }
        if (signature === this.signature) return;
        this.signature = signature;
        this.dirty = true;
    }

    /** Publish the latest observation for `/status full`. */
    private publishStatus(): void {
        this.service.setRuntimeStatus({
            enabled: this.config.enable,
            snapshotChars: this.currentText.length,
        });
    }
}
