import { AsyncLocalStorage } from "node:async_hooks";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
    TerminalBackend,
    TerminalBackendSession,
    TerminalBackendSpawnSpec,
    TerminalSessionSnapshot,
} from "@deepseek-ai/dsh-terminal";
import {
    BashTerminalBackend,
    Config as BashTerminalConfig,
} from "@deepseek-ai/dsh-terminal-bash";
import { createLogger } from "@nokoribi/shared";
import { TERMINAL_BASH_ARGS } from "@nokoribi/shell-bash";
import type { ShellHostInfo } from "@nokoribi/shell-bash";

import type { ResolvedConfig } from "./config.js";
import { createHostTerminalSpawner } from "./spawn.js";
import type { SpawnLogger } from "./spawn.js";

/** Fully resolved configuration accepted by one `BashTerminalBackend`. */
type BashTerminalResolvedConfig = ConstructorParameters<
    typeof BashTerminalBackend
>[1];

/** Reason recorded on terminals closed because their host disappeared. */
const HOST_REMOVED_REASON: string = "shell host removed";

/** One registered host backend plus the owners seen on that host. */
interface HostBackendEntry {
    readonly owners: Set<Agent>;
    readonly dispose: () => void;
}

/** Minimal `ctx.terminals` surface used for host-removal cleanup. */
interface TerminalKillSurface {
    list(owner: Agent): readonly TerminalSessionSnapshot[];
    kill(
        owner: Agent,
        sessionId: TerminalSessionSnapshot["sessionId"],
        reason?: string
    ): Promise<boolean>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * One `BashTerminalBackend` per terminal-capable shell host.
 *
 * The controller owns the host-to-backend diff: it registers a backend when a
 * host advertises `capabilities.terminal`, removes it (closing that host's
 * terminals first) when the host disappears or loses the capability, and
 * closes everything on plugin disposal. Registry changes are serialized so a
 * burst of host registrations cannot interleave a backend add with a removal.
 */
export class TerminalHostController {
    private readonly ctx: Context;
    private readonly config: ResolvedConfig;
    private readonly log: SpawnLogger;
    private readonly backends: Map<string, HostBackendEntry> = new Map();
    private chain: Promise<void> = Promise.resolve();
    private offChange: (() => void) | undefined;
    private closed: boolean = false;

    /**
     * Build the controller without touching the registries yet.
     * @param ctx - Cordis context with the terminal and host services.
     * @param config - resolved plugin configuration.
     * @param log - warn sink for release and cleanup failures.
     */
    constructor(
        ctx: Context,
        config: ResolvedConfig,
        log: SpawnLogger = createLogger("terminal-host")
    ) {
        this.ctx = ctx;
        this.config = config;
        this.log = log;
    }

    /**
     * Register backends for the hosts already present, then follow registry
     * changes for the rest of the plugin lifetime.
     */
    start(): void {
        if (this.closed) return;
        for (const host of this.terminalHosts()) this.addHost(host.id);
        this.offChange = this.ctx.shellHosts.onChange(() => {
            void this.sync().catch((error: unknown) => {
                this.log.warn("terminal host sync failed", {
                    error: errorMessage(error),
                });
            });
        });
    }

    /**
     * Queue one registry diff and resolve after it finished.
     * @returns a promise that rejects when the diff itself failed.
     */
    sync(): Promise<void> {
        if (this.closed) return Promise.resolve();
        const run = this.chain.then(
            () => this.syncNow(),
            () => this.syncNow()
        );
        this.chain = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    /**
     * Close every managed terminal, dispose all backends, and stop syncing.
     *
     * Cleanup failures are logged and do not reject: a daemon shutdown must
     * not be blocked by one broken backend.
     */
    async dispose(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const offChange = this.offChange;
        this.offChange = undefined;
        if (offChange !== undefined) offChange();
        await this.chain;
        const terminals = this.ctx.get("terminals");
        const entries = [...this.backends.entries()];
        this.backends.clear();
        for (const [hostId, entry] of entries) {
            if (terminals !== undefined) {
                await this.killHostSessions(terminals, hostId, entry.owners);
            }
            try {
                entry.dispose();
            } catch (error) {
                this.log.warn("terminal backend dispose failed", {
                    host: hostId,
                    error: errorMessage(error),
                });
            }
        }
    }

    /**
     * Apply the current host set: add new terminal-capable hosts and remove
     * hosts that disappeared or lost the capability.
     */
    private async syncNow(): Promise<void> {
        if (this.closed) return;
        const current = new Set(this.terminalHosts().map((host) => host.id));
        for (const hostId of Array.from(this.backends.keys())) {
            if (!current.has(hostId)) await this.removeHost(hostId);
        }
        if (this.closed) return;
        for (const hostId of current) {
            if (!this.backends.has(hostId)) this.addHost(hostId);
        }
    }

    private terminalHosts(): ShellHostInfo[] {
        return this.ctx.shellHosts
            .list()
            .filter((host) => host.capabilities.terminal);
    }

    /**
     * Register one host backend and wire its injected spawner.
     *
     * The backend registry needs the owner of a spawn, while the injected
     * `spawnTerminal` seam receives only the subprocess spec. An
     * `AsyncLocalStorage` carries the accepted `TerminalBackendSpawnSpec`
     * across that async boundary, so the spawner can pass the owning agent
     * session to the host launch (sandbox hosts require it).
     * @param hostId - terminal-capable host id.
     */
    private addHost(hostId: string): void {
        const resolved = this.resolveBackendConfig(hostId);
        const owners = new Set<Agent>();
        const storage = new AsyncLocalStorage<TerminalBackendSpawnSpec>();
        const spawnTerminal = createHostTerminalSpawner(
            this.ctx,
            hostId,
            this.log
        );
        const inner = new BashTerminalBackend(
            this.ctx,
            resolved,
            async (spec) => {
                const current = storage.getStore();
                if (current === undefined) {
                    throw new Error(
                        `terminal-host: no owner context for backend ` +
                            `"${hostId}"`
                    );
                }
                return await spawnTerminal(spec, current.owner.id);
            }
        );
        const backend: TerminalBackend = {
            type: hostId,
            spawn: async (
                spec: TerminalBackendSpawnSpec
            ): Promise<TerminalBackendSession> => {
                return await storage.run(spec, async () => {
                    owners.add(spec.owner);
                    return await inner.spawn(spec);
                });
            },
        };
        const dispose = this.ctx.terminals.registerBackend(backend);
        this.backends.set(hostId, { owners, dispose });
    }

    private async removeHost(hostId: string): Promise<void> {
        const entry = this.backends.get(hostId);
        if (entry === undefined) return;
        this.backends.delete(hostId);
        const terminals = this.ctx.get("terminals");
        if (terminals !== undefined) {
            await this.killHostSessions(terminals, hostId, entry.owners);
        }
        try {
            entry.dispose();
        } catch (error) {
            this.log.warn("terminal backend dispose failed", {
                host: hostId,
                error: errorMessage(error),
            });
        }
    }

    /**
     * Close every terminal of one host type before its host resources go away.
     * A sandbox host keeps pins for open terminals, so this must finish before
     * `/clear` or goal archive releases the session.
     * @param terminals - terminal registry.
     * @param hostId - backend type being removed.
     * @param owners - agents that opened a terminal on this host.
     */
    private async killHostSessions(
        terminals: TerminalKillSurface,
        hostId: string,
        owners: ReadonlySet<Agent>
    ): Promise<void> {
        for (const owner of owners) {
            let snapshots: readonly TerminalSessionSnapshot[];
            try {
                snapshots = terminals.list(owner);
            } catch (error) {
                this.log.warn("terminal session list failed", {
                    host: hostId,
                    agent: owner.id,
                    error: errorMessage(error),
                });
                continue;
            }
            for (const snapshot of snapshots) {
                if (snapshot.type !== hostId) continue;
                try {
                    await terminals.kill(
                        owner,
                        snapshot.sessionId,
                        HOST_REMOVED_REASON
                    );
                } catch (error) {
                    this.log.warn("terminal session kill failed", {
                        host: hostId,
                        agent: owner.id,
                        error: errorMessage(error),
                    });
                }
            }
        }
    }

    /**
     * Build the upstream backend configuration: the bash dialect plus the
     * deployment's shell, size, and timeout budgets.
     *
     * rc.3 exports the schema but not `resolveConfig()`/`validateConfig()`, so
     * this seam materializes the schema defaults itself and resolves the two
     * dialect fields explicitly; every numeric field then comes from the
     * schema's positive defaults (the same values `apply()` would produce).
     * @param hostId - backend type, also the model-facing host id.
     * @returns the upstream configuration.
     */
    private resolveBackendConfig(hostId: string): BashTerminalResolvedConfig {
        const parsed = BashTerminalConfig({
            backendType: hostId,
            shellPath: this.config.bashPath,
            shellArgs: [...TERMINAL_BASH_ARGS],
            rows: this.config.rows,
            cols: this.config.cols,
            scrollbackLines: this.config.scrollbackLines,
            timeoutMs: this.config.sendTimeoutMs,
        });
        const shellDialect = parsed.shellDialect ?? "bash";
        return {
            ...parsed,
            shellDialect,
            shellPath: parsed.shellPath ?? this.config.bashPath,
            shellArgs:
                parsed.shellArgs !== undefined && parsed.shellArgs.length > 0
                    ? parsed.shellArgs
                    : [...TERMINAL_BASH_ARGS],
        } as BashTerminalResolvedConfig;
    }
}
