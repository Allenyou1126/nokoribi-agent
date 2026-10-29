import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { TerminalSessionSnapshot } from "@deepseek-ai/dsh-terminal";
import { createLogger, type LogFields } from "@nokoribi/shared";

/** Total bound for one cleanup pass before the caller continues. */
export const TERMINAL_CLEANUP_TIMEOUT_MS: number = 5000;

/** Cleanup reason recorded by the terminal registry. */
export const TERMINAL_CLEANUP_REASON: string = "cleanup";

/** Minimal logger surface used by terminal cleanup. */
export interface CleanupLogger {
    debug(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
}

/** Minimal live-agent lookup used to resolve a session owner. */
export interface TerminalCleanupAgents {
    get(id: SessionId): Agent | undefined;
}

/**
 * Minimal terminal-registry surface needed for owner cleanup.
 * A `TerminalSessionService` satisfies it without exposing the service class.
 */
export interface TerminalCleanupTerminals {
    list(owner: Agent): readonly TerminalSessionSnapshot[];
    kill(
        owner: Agent,
        id: TerminalSessionSnapshot["sessionId"],
        reason?: string
    ): Promise<boolean>;
}

/**
 * Minimal Cordis context surface needed by terminal cleanup. A real `Context`
 * satisfies it; tests can pass a plain `{ get }` object.
 */
export interface TerminalCleanupContext {
    get(name: "terminals"): TerminalCleanupTerminals | undefined;
    get(name: "agents"): TerminalCleanupAgents | undefined;
}

/** Optional bounds and sinks for one cleanup pass. */
export interface TerminalCleanupOptions {
    /** Total wait bound; defaults to {@link TERMINAL_CLEANUP_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
    /** Logger; defaults to the `agent-app` module logger. */
    readonly logger?: CleanupLogger;
}

const defaultLogger = createLogger("agent-app");

/** Marker for a cleanup step that exceeded its share of the total bound. */
class TerminalCleanupTimeoutError extends Error {
    constructor() {
        super("terminal cleanup wait exceeded its bound");
        this.name = "TerminalCleanupTimeoutError";
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new TerminalCleanupTimeoutError());
        }, timeoutMs);
        work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

function cleanupLogger(options: TerminalCleanupOptions): CleanupLogger {
    return options.logger ?? defaultLogger;
}

/**
 * Kill every terminal session owned by one exact agent, bounded as a whole.
 * Individual failures and timeouts only warn: callers must never block on
 * terminal cleanup.
 * @param ctx - context with optional `terminals` and `agents` services.
 * @param agent - exact owner whose sessions should be closed.
 * @param options - total wait bound and logger override.
 * @returns a promise settling after cleanup or its total bound.
 */
export async function killTerminalsForAgent(
    ctx: TerminalCleanupContext,
    agent: Agent,
    options: TerminalCleanupOptions = {}
): Promise<void> {
    const logger = cleanupLogger(options);
    try {
        const terminals = ctx.get("terminals");
        if (terminals === undefined) return;
        const snapshots = terminals.list(agent);
        if (snapshots.length === 0) return;
        await killSnapshots(terminals, agent, snapshots, options);
    } catch (error) {
        logger.warn("terminal cleanup failed", {
            agent: agent.id,
            error: errorMessage(error),
        });
    }
}

/**
 * Kill every terminal session owned by the live agent of one session id.
 * A no-op unless both terminals and a live owner exist.
 * @param ctx - context with optional `terminals` and `agents` services.
 * @param sessionId - session whose live owner should be cleaned up.
 * @param options - total wait bound and logger override.
 * @returns a promise settling after cleanup or its total bound.
 */
export async function killTerminalsForSession(
    ctx: TerminalCleanupContext,
    sessionId: string,
    options: TerminalCleanupOptions = {}
): Promise<void> {
    const logger = cleanupLogger(options);
    try {
        const agent = ctx.get("agents")?.get(SessionId(sessionId));
        if (agent === undefined) return;
        await killTerminalsForAgent(ctx, agent, options);
    } catch (error) {
        logger.warn("terminal cleanup failed", {
            session: sessionId,
            error: errorMessage(error),
        });
    }
}

async function killSnapshots(
    terminals: TerminalCleanupTerminals,
    agent: Agent,
    snapshots: readonly TerminalSessionSnapshot[],
    options: TerminalCleanupOptions
): Promise<void> {
    const logger = cleanupLogger(options);
    const timeoutMs = options.timeoutMs ?? TERMINAL_CLEANUP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let killed = 0;
    for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index];
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            warnTimeout(logger, agent, killed, snapshots.length - index);
            return;
        }
        try {
            await withTimeout(
                terminals.kill(
                    agent,
                    snapshot.sessionId,
                    TERMINAL_CLEANUP_REASON
                ),
                remaining
            );
            killed += 1;
        } catch (error) {
            if (error instanceof TerminalCleanupTimeoutError) {
                warnTimeout(logger, agent, killed, snapshots.length - index);
                return;
            }
            logger.warn("failed to kill terminal session", {
                agent: agent.id,
                session: snapshot.sessionId,
                error: errorMessage(error),
            });
        }
    }
    logger.debug("terminals cleaned up", { agent: agent.id, killed });
}

function warnTimeout(
    logger: CleanupLogger,
    agent: Agent,
    killed: number,
    pending: number
): void {
    logger.warn("terminal cleanup timed out", {
        agent: agent.id,
        killed,
        pending,
    });
}
