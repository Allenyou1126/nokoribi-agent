import { spawn } from "node:child_process";

import { createLogger, type Logger } from "./log.js";

/** Default command used to speak the systemd notification protocol. */
export const DEFAULT_SYSTEMD_NOTIFY_COMMAND: string = "systemd-notify";

/** Upper bound for one notification helper invocation. */
export const SYSTEMD_NOTIFY_TIMEOUT_MS: number = 5000;

/** Injectable executor for one notification helper invocation. */
export type SystemdNotifyRunner = (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv
) => Promise<void>;

/** Construction options for {@link SystemdNotifier}. */
export interface SystemdNotifierOptions {
    /** Environment to inspect; defaults to `process.env`. */
    readonly env?: NodeJS.ProcessEnv;
    /** Logger for non-fatal watchdog and shutdown failures. */
    readonly logger?: Pick<Logger, "warn" | "debug">;
    /** Test seam replacing the real helper subprocess. */
    readonly run?: SystemdNotifyRunner;
}

/**
 * Parse the watchdog interval supplied by systemd.
 *
 * systemd sets `WATCHDOG_USEC` only for units with `WatchdogSec`; the interval
 * is one third of that budget so a single failed attempt does not consume the
 * whole window. `WATCHDOG_PID`, when present, must name this process.
 * @param env - process environment to inspect.
 * @returns the interval in milliseconds, or undefined when no watchdog applies.
 */
export function resolveWatchdogIntervalMs(
    env: NodeJS.ProcessEnv = process.env
): number | undefined {
    const raw = env.WATCHDOG_USEC?.trim();
    if (raw === undefined || raw === "") return undefined;
    const usec = Number(raw);
    if (!Number.isSafeInteger(usec) || usec <= 0) return undefined;
    const watchdogPid = env.WATCHDOG_PID?.trim();
    if (
        watchdogPid !== undefined &&
        watchdogPid !== "" &&
        watchdogPid !== String(process.pid)
    ) {
        return undefined;
    }
    return Math.max(100, Math.floor(usec / 3000));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function runSystemdNotify(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let stderr = "";
        let timer: NodeJS.Timeout | undefined;
        const child = spawn(command, [...args], {
            env,
            stdio: ["ignore", "ignore", "pipe"],
        });
        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            if (error === undefined) resolve();
            else reject(error);
        };
        timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(
                new Error(
                    `${command} did not finish within ` +
                        `${String(SYSTEMD_NOTIFY_TIMEOUT_MS)}ms`
                )
            );
        }, SYSTEMD_NOTIFY_TIMEOUT_MS);
        timer.unref?.();
        child.stderr?.on("data", (chunk: Buffer) => {
            if (stderr.length < 4096) stderr += chunk.toString();
        });
        child.once("error", (error) => {
            finish(new Error(`${command}: ${error.message}`));
        });
        child.once("close", (code, signal) => {
            if (code === 0) {
                finish();
                return;
            }
            const detail = stderr.trim();
            finish(
                new Error(
                    `${command} failed ` +
                        `(code=${String(code)}, signal=${String(signal)})` +
                        (detail === "" ? "" : `: ${detail}`)
                )
            );
        });
    });
}

/**
 * Minimal `sd_notify` bridge implemented through the systemd helper binary.
 *
 * Node's `dgram` has no Unix-domain datagram support, so a tiny helper process
 * is the least invasive dependency-free implementation. The service unit must
 * permit helper notifications with `NotifyAccess=all`.
 */
export class SystemdNotifier {
    private readonly env: NodeJS.ProcessEnv;
    private readonly logger: Pick<Logger, "warn" | "debug">;
    private readonly run: SystemdNotifyRunner;
    private readonly command: string;
    private readonly socket: string | undefined;
    private watchdogTimer: NodeJS.Timeout | undefined;
    private watchdogIntervalMsValue: number | undefined;
    private readySent = false;
    private stopped = false;

    /**
     * Create a notifier for the current service.
     * @param options - environment, logger, and test runner overrides.
     */
    constructor(options: SystemdNotifierOptions = {}) {
        this.env = options.env ?? process.env;
        this.logger = options.logger ?? createLogger("systemd");
        this.run = options.run ?? runSystemdNotify;
        const command = this.env.NOKORIBI_SYSTEMD_NOTIFY?.trim();
        this.command =
            command === undefined || command === ""
                ? DEFAULT_SYSTEMD_NOTIFY_COMMAND
                : command;
        const socket = this.env.NOTIFY_SOCKET?.trim();
        this.socket =
            socket === undefined || socket === "" ? undefined : socket;
    }

    /** Whether a systemd notification socket is available. */
    get enabled(): boolean {
        return this.socket !== undefined;
    }

    /** Active watchdog interval, if a timer is running. */
    get watchdogIntervalMs(): number | undefined {
        return this.watchdogIntervalMsValue;
    }

    /**
     * Report readiness and arm the watchdog loop.
     * @param status - short human-readable status for `systemctl status`.
     * @throws when the helper is present but cannot report readiness.
     */
    async ready(status: string = "ready"): Promise<void> {
        await this.invoke(["--ready", `--status=${status}`], true);
        this.readySent = true;
        this.startWatchdog();
    }

    /** Send one watchdog heartbeat. Failures are logged but not fatal. */
    async watchdog(): Promise<void> {
        await this.invoke(["WATCHDOG=1"], false);
    }

    /**
     * Tell systemd the service is stopping and stop watchdog heartbeats.
     * @param status - short human-readable status for `systemctl status`.
     */
    async stopping(status: string = "stopping"): Promise<void> {
        this.stopWatchdog();
        if (!this.readySent) return;
        await this.invoke(["--stopping", `--status=${status}`], false);
    }

    /** Stop the watchdog timer. Safe to call repeatedly. */
    stopWatchdog(): void {
        if (this.watchdogTimer !== undefined) {
            clearTimeout(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }
        this.watchdogIntervalMsValue = undefined;
    }

    /** Stop all notifier activity. */
    stop(): void {
        this.stopped = true;
        this.stopWatchdog();
    }

    private startWatchdog(): void {
        if (
            this.stopped ||
            this.watchdogTimer !== undefined ||
            this.socket === undefined
        ) {
            return;
        }
        const interval = resolveWatchdogIntervalMs(this.env);
        if (interval === undefined) return;
        this.watchdogIntervalMsValue = interval;
        const tick = (): void => {
            this.watchdogTimer = undefined;
            if (this.stopped) return;
            void this.invoke(["WATCHDOG=1"], false).finally(() => {
                if (this.stopped || this.socket === undefined) return;
                this.watchdogTimer = setTimeout(tick, interval);
                this.watchdogTimer.unref?.();
            });
        };
        this.watchdogTimer = setTimeout(tick, interval);
        this.watchdogTimer.unref?.();
    }

    private async invoke(
        args: readonly string[],
        fatal: boolean
    ): Promise<void> {
        const socket = this.socket;
        if (socket === undefined) return;
        try {
            await this.run(this.command, args, {
                ...this.env,
                NOTIFY_SOCKET: socket,
            });
        } catch (error) {
            if (fatal) {
                throw new Error(
                    `systemd notification failed: ${errorMessage(error)}`
                );
            }
            this.logger.warn("systemd notification failed", {
                command: this.command,
                error: errorMessage(error),
            });
        }
    }
}
