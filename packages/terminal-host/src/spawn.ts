import type { Context } from "@deepseek-ai/cordis";
import type {
    SubprocessTerminalHandle,
    SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { createLogger } from "@nokoribi/shared";
import type { LogFields } from "@nokoribi/shared";
import type { ShellTerminalLaunch } from "@nokoribi/shell-bash";

/** Minimal logger surface for warn-only release failures. */
export interface SpawnLogger {
    warn(message: string, fields?: LogFields): void;
}

/** Host-aware terminal spawner injected into one `BashTerminalBackend`. */
export type HostTerminalSpawner = (
    spec: SubprocessTerminalSpawnSpec,
    sessionId: string
) => Promise<SubprocessTerminalHandle>;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Validate one host launch before it is allowed to reach the PTY primitive.
 * @param launch - host-provided launch, or `undefined` for a misbehaving host.
 * @param hostId - host id used in the diagnostic.
 * @returns the validated launch.
 * @throws when the host returned no usable argv or cwd.
 */
function requireLaunch(
    launch: ShellTerminalLaunch | undefined,
    hostId: string
): ShellTerminalLaunch {
    if (launch === undefined) {
        throw new Error(
            `shell host "${hostId}" returned no terminal launch ` +
                "(missing terminal implementation)"
        );
    }
    const executable = launch.argv[0];
    if (executable === undefined || executable.length === 0) {
        throw new Error(
            `shell host "${hostId}" returned an empty terminal argv`
        );
    }
    if (launch.cwd.length === 0) {
        throw new Error(
            `shell host "${hostId}" returned an empty terminal cwd`
        );
    }
    return launch;
}

/**
 * Run one host release hook, downgrading failures to a warning.
 * @param launch - launch whose host-owned pin or lease is released.
 * @param log - warn sink.
 * @param hostId - host id used in the diagnostic.
 */
async function releaseLaunch(
    launch: ShellTerminalLaunch,
    log: SpawnLogger,
    hostId: string
): Promise<void> {
    const release = launch.release;
    if (release === undefined) return;
    try {
        await release();
    } catch (error) {
        log.warn("terminal launch release failed", {
            host: hostId,
            error: errorMessage(error),
        });
    }
}

/**
 * Idempotent release wrapper: concurrent teardown paths share one release.
 * @param launch - launch whose host-owned resources are released.
 * @param log - warn sink.
 * @param hostId - host id used in the diagnostic.
 * @returns a release function that runs the hook at most once.
 */
function createRelease(
    launch: ShellTerminalLaunch,
    log: SpawnLogger,
    hostId: string
): () => Promise<void> {
    let pending: Promise<void> | undefined;
    return () => {
        if (pending === undefined) {
            pending = releaseLaunch(launch, log, hostId);
        }
        return pending;
    };
}

/**
 * Wrap one PTY handle so every teardown path releases the host resources.
 *
 * `done` is delegated unchanged: the release fallback is attached beside it so
 * observers keep the original outcome and rejection behavior.
 * @param handle - provider-owned PTY handle.
 * @param release - idempotent host release.
 * @returns the wrapped handle.
 */
function wrapHandle(
    handle: SubprocessTerminalHandle,
    release: () => Promise<void>
): SubprocessTerminalHandle {
    void handle.done.then(release, release);
    return {
        pid: handle.pid,
        output: handle.output,
        done: handle.done,
        write: (data: string): Promise<void> => handle.write(data),
        resize: (cols: number, rows: number): Promise<void> =>
            handle.resize(cols, rows),
        inspectForeground: () => handle.inspectForeground(),
        inspectActivity: () => handle.inspectActivity(),
        signalForeground: (signal) => handle.signalForeground(signal),
        terminate: async (): Promise<void> => {
            try {
                await handle.terminate();
            } finally {
                await release();
            }
        },
    };
}

/**
 * Build the `spawnTerminal` injection for one host.
 *
 * The upstream backend keeps readiness, scrollback, and signalling; this seam
 * only replaces argv/cwd/env with the host launch and releases host-owned
 * resources on teardown. Upstream env entries such as `PS1`,
 * `PROMPT_COMMAND`, and `DSH_*` survive; the launch env is layered after them
 * and only overrides PATH and sandbox keys.
 * @param ctx - context carrying `ctx.shellHosts` and `ctx.subprocess`.
 * @param hostId - terminal-capable host id.
 * @param log - warn sink for release failures.
 * @returns the injected spawner.
 */
export function createHostTerminalSpawner(
    ctx: Context,
    hostId: string,
    log: SpawnLogger = createLogger("terminal-host")
): HostTerminalSpawner {
    return async (
        spec: SubprocessTerminalSpawnSpec,
        sessionId: string
    ): Promise<SubprocessTerminalHandle> => {
        const requested = await ctx.shellHosts.terminalLaunch(hostId, {
            sessionId,
            cwd: spec.cwd,
            signal: spec.signal,
        });
        const launch = requireLaunch(requested, hostId);
        const release = createRelease(launch, log, hostId);
        let handle: SubprocessTerminalHandle;
        try {
            handle = await ctx.subprocess.spawnTerminal({
                ...spec,
                argv: launch.argv,
                cwd: launch.cwd,
                env:
                    launch.env === undefined
                        ? spec.env
                        : { ...spec.env, ...launch.env },
            });
        } catch (error) {
            await release();
            throw error;
        }
        return wrapHandle(handle, release);
    };
}
