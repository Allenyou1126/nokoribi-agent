import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import type {
    DshEnvironment,
    ShellExecRequest,
    ShellExecution,
    ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import type { Logger } from "@nokoribi/shared";
import type {
    ShellHostCapabilities,
    ShellHostExecRequest,
    ShellHostProvider,
} from "@nokoribi/shell-bash";

import { buildSandboxCommand, shellQuote } from "./command.js";
import { ensurePathGuard } from "./guard.js";
import type { SandboxMeta } from "./meta.js";
import {
    backupSandboxMeta,
    createSandboxMeta,
    readSandboxMeta,
    writeSandboxMeta,
} from "./meta.js";
import { assertSessionId, sandboxPaths } from "./paths.js";

/** Runtime configuration for the sandbox host. */
export interface SandboxHostConfig {
    readonly id: string;
    /** `$DSH_HOME/sandboxes`. */
    readonly root: string;
    /** Persistent workspace exposed as DSH_WORKSPACE_DIR. */
    readonly workspace: string;
    /** Absolute Nix buildEnv store path; empty disables execution. */
    readonly baseEnvironment: string;
    /** Trusted shellHook evaluated before each command. */
    readonly shellHook: string;
    /** Idle time before a sandbox is reclaimed. */
    readonly idleTtlMs: number;
    /** Interval between TTL sweeps. */
    readonly sweepIntervalMs: number;
    /** Whether sandbox_packages may add runtime packages. */
    readonly allowRuntimePackages: boolean;
    /** Nix binary used for temporary package layers. */
    readonly nixBinary: string;
    /** Timeout for nix package-validation commands. */
    readonly nixTimeoutMs: number;
    /** Empty resolves `setpriv` from PATH; otherwise an absolute or bare name. */
    readonly noNewPrivilegesCommand: string;
}

/** Public status of one session's sandbox. */
export interface SandboxStatus {
    readonly host: string;
    readonly sessionId: string;
    readonly dir: string;
    readonly exists: boolean;
    readonly generation: number;
    readonly packages: readonly string[];
    readonly createdAt: string | null;
    readonly lastUsedAt: string | null;
    readonly idleTtlMs: number;
    readonly activeCommands: number;
    readonly backgroundCommands: number;
    readonly allowRuntimePackages: boolean;
}

/** Injectable execution and clock dependencies for tests. */
export interface SandboxHostDeps {
    readonly spawnBash: (request: ShellExecRequest) => Promise<ShellExecution>;
    readonly resolveExecutable: (
        command: string,
        env?: NodeJS.ProcessEnv
    ) => Promise<string>;
    readonly now?: (() => number) | undefined;
    readonly logger?: Pick<Logger, "info" | "warn" | "error"> | undefined;
}

interface Instance {
    meta: SandboxMeta;
    dir: string;
    active: number;
    background: number;
    readonly handles: Set<ShellExecution>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function statusText(status: SandboxStatus): SandboxStatus {
    return status;
}

/**
 * Per-session sandbox host: clean Nix environment, disposable temp directory,
 * TTL reclaim, runtime package overlay and no_new_privs execution.
 */
export class SandboxHost implements ShellHostProvider {
    readonly kind = "sandbox" as const;
    readonly id: string;
    readonly title: string = "Sandbox";
    readonly description: string =
        "干净、可重置的 Nix 临时环境；与 workspace 隔离，不能 sudo。";
    readonly capabilities: ShellHostCapabilities = {
        background: true,
        sandbox: false,
        workdir: "local",
    };

    private readonly config: SandboxHostConfig;
    private readonly deps: SandboxHostDeps;
    private readonly now: () => number;
    private readonly logger: Pick<Logger, "info" | "warn" | "error">;
    private readonly instances = new Map<string, Instance>();
    private readonly locks = new Map<string, Promise<unknown>>();
    private readonly binaries = new Map<string, string>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private sweeping = false;

    /**
     * Create the provider and start the TTL sweeper.
     * @param config - sandbox configuration.
     * @param deps - subprocess/bash, executable resolution, clock, logger.
     */
    constructor(config: SandboxHostConfig, deps: SandboxHostDeps) {
        this.config = config;
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.id = config.id;
        this.logger = deps.logger ?? {
            info: () => {},
            warn: () => {},
            error: () => {},
        };
        this.timer = setInterval(() => {
            void this.sweep();
        }, config.sweepIntervalMs);
        this.timer.unref?.();
    }

    /** Stop the TTL sweeper; the subprocess service owns running processes. */
    dispose(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** Run one TTL sweep immediately (used by tests and diagnostics). */
    async sweepNow(): Promise<void> {
        await this.sweep();
    }

    /** Execute one command in the foreground. */
    async run(request: ShellHostExecRequest): Promise<ShellRunResult> {
        const execution = await this.start({
            ...request,
            runInBackground: false,
        });
        return await execution.result();
    }

    /** Start one command and return its live handle. */
    async start(request: ShellHostExecRequest): Promise<ShellExecution> {
        const sessionId = request.sessionId;
        if (sessionId === undefined || sessionId === "") {
            throw new Error(
                `sandbox host "${this.id}" requires an agent session`
            );
        }
        return await this.withLock(sessionId, async () => {
            const instance = await this.ensureLocked(sessionId);
            const execution = await this.spawn(instance, request);
            this.track(instance, execution, request.runInBackground === true);
            return execution;
        });
    }

    /** Reset one session's sandbox; refuses while commands are active. */
    async reset(sessionId: string): Promise<void> {
        assertSessionId(sessionId);
        await this.withLock(sessionId, async () => {
            const instance = this.instances.get(sessionId);
            if (instance !== undefined && instance.active > 0) {
                throw new Error(
                    `sandbox for "${sessionId}" has active commands; ` +
                        "stop them before reset"
                );
            }
            const paths = sandboxPaths(this.config.root, sessionId);
            const previous = await this.loadMeta(sessionId);
            const stamp = new Date(this.now()).toISOString();
            const next: SandboxMeta = {
                version: 1,
                sessionId,
                generation: (previous?.generation ?? 0) + 1,
                packages: [],
                createdAt: stamp,
                lastUsedAt: stamp,
            };
            this.instances.delete(sessionId);
            await rm(paths.dir, { recursive: true, force: true });
            await writeSandboxMeta(paths.meta, next);
            await this.ensureLocked(sessionId);
        });
    }

    /** Inspect one session's sandbox without creating it. */
    async status(sessionId: string): Promise<SandboxStatus> {
        assertSessionId(sessionId);
        return await this.withLock(sessionId, async () => {
            const paths = sandboxPaths(this.config.root, sessionId);
            const meta = await this.loadMeta(sessionId);
            return await this.statusValue(
                sessionId,
                paths.dir,
                meta,
                this.instances.get(sessionId)
            );
        });
    }

    /** Release all resources of one session (used by `/clear`). */
    async disposeSession(sessionId: string): Promise<void> {
        assertSessionId(sessionId);
        await this.withLock(sessionId, async () => {
            const paths = sandboxPaths(this.config.root, sessionId);
            const instance = this.instances.get(sessionId);
            this.instances.delete(sessionId);
            if (instance !== undefined) {
                for (const handle of instance.handles) {
                    try {
                        handle.kill();
                    } catch {
                        // the handle may already be settled
                    }
                }
                await Promise.allSettled(
                    [...instance.handles].map((handle) => handle.done)
                );
            }
            await rm(paths.dir, { recursive: true, force: true });
            await rm(paths.meta, { force: true });
        });
    }

    /** Add temporary Nix packages after validating them. */
    async addPackages(
        sessionId: string,
        packages: readonly string[]
    ): Promise<string[]> {
        if (!this.config.allowRuntimePackages) {
            throw new Error(
                "runtime packages are disabled in this deployment " +
                    "(hosts.sandbox.allowRuntimePackages = false)"
            );
        }
        const requested = normalizePackages(packages);
        if (requested.length === 0) {
            throw new Error(
                "sandbox_packages add requires at least one package"
            );
        }
        assertSessionId(sessionId);
        return await this.withLock(sessionId, async () => {
            const instance = await this.ensureLocked(sessionId);
            const base = await this.requireBaseEnvironment();
            await this.validatePackages(base, requested);
            instance.meta = {
                ...instance.meta,
                packages: [
                    ...new Set([...instance.meta.packages, ...requested]),
                ],
            };
            await this.persist(instance);
            return [...instance.meta.packages];
        });
    }

    /** Remove temporary packages and return the remaining list. */
    async removePackages(
        sessionId: string,
        packages: readonly string[]
    ): Promise<string[]> {
        const requested = new Set(normalizePackages(packages));
        assertSessionId(sessionId);
        return await this.withLock(sessionId, async () => {
            const instance = this.instances.get(sessionId);
            const meta = instance?.meta ?? (await this.loadMeta(sessionId));
            if (meta === undefined) return [];
            const next: SandboxMeta = {
                ...meta,
                packages: meta.packages.filter((item) => !requested.has(item)),
            };
            if (instance !== undefined) {
                instance.meta = next;
                await this.persist(instance);
            } else {
                await writeSandboxMeta(
                    sandboxPaths(this.config.root, sessionId).meta,
                    next
                );
            }
            return [...next.packages];
        });
    }

    /** List temporary packages for one session. */
    async listPackages(sessionId: string): Promise<string[]> {
        assertSessionId(sessionId);
        return await this.withLock(sessionId, async () => {
            const instance = this.instances.get(sessionId);
            const meta = instance?.meta ?? (await this.loadMeta(sessionId));
            return meta === undefined ? [] : [...meta.packages];
        });
    }

    private async ensureLocked(sessionId: string): Promise<Instance> {
        const paths = sandboxPaths(this.config.root, sessionId);
        await mkdir(this.config.root, { recursive: true, mode: 0o700 });
        const now = this.now();
        const existing = this.instances.get(sessionId);
        if (existing !== undefined && existing.active > 0) {
            existing.meta = {
                ...existing.meta,
                lastUsedAt: new Date(now).toISOString(),
            };
            await this.persist(existing);
            return existing;
        }
        let meta = await this.loadMeta(sessionId);
        if (meta !== undefined && this.isExpired(meta, now)) {
            meta = await this.reclaimLocked(sessionId, meta);
        }
        if (meta === undefined) {
            meta = createSandboxMeta(sessionId, now);
        } else {
            meta = { ...meta, lastUsedAt: new Date(now).toISOString() };
        }
        await mkdir(paths.dir, { recursive: true, mode: 0o700 });
        const hostBash = await this.requireBash();
        await ensurePathGuard(join(paths.dir, ".path-guard"), hostBash);
        if (existing === undefined) {
            const instance: Instance = {
                meta,
                dir: paths.dir,
                active: 0,
                background: 0,
                handles: new Set(),
            };
            this.instances.set(sessionId, instance);
            await this.persist(instance);
            return instance;
        }
        existing.meta = meta;
        existing.dir = paths.dir;
        await this.persist(existing);
        return existing;
    }

    private async spawn(
        instance: Instance,
        request: ShellHostExecRequest
    ): Promise<ShellExecution> {
        const base = await this.requireBaseEnvironment();
        const hostBash = await this.requireBash();
        const setpriv = await this.requireSetpriv();
        const packages = instance.meta.packages;
        const nix = packages.length > 0 ? await this.requireNix() : undefined;
        const guardDir = join(instance.dir, ".path-guard");
        const command = buildSandboxCommand({
            guardDir,
            shellHook: this.config.shellHook,
            hostBash,
            setpriv,
            ...(nix === undefined ? {} : { nix }),
            baseEnvironment: base,
            packages,
            command: request.command,
        });
        const path = `${guardDir}${delimiter}${join(base, "bin")}`;
        const dshEnv = {
            ...request.dshEnv,
            DSH_SANDBOX_DIR: instance.dir,
            DSH_WORKSPACE_DIR: this.config.workspace,
        } as DshEnvironment;
        return await this.deps.spawnBash({
            command,
            workdir: this.resolveWorkdir(instance, request.workdir),
            ...(request.timeoutMs === undefined
                ? {}
                : { timeoutMs: request.timeoutMs }),
            ...(request.onExpiry === undefined
                ? {}
                : { onExpiry: request.onExpiry }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            env: { ...request.env, PATH: path },
            dshEnv,
        });
    }

    private track(
        instance: Instance,
        execution: ShellExecution,
        background: boolean
    ): void {
        instance.active += 1;
        if (background) instance.background += 1;
        instance.handles.add(execution);
        void execution.done.finally(() => {
            instance.active = Math.max(0, instance.active - 1);
            if (background) {
                instance.background = Math.max(0, instance.background - 1);
            }
            instance.handles.delete(execution);
            void this.touch(instance);
        });
    }

    private async touch(instance: Instance): Promise<void> {
        if (this.instances.get(instance.meta.sessionId) !== instance) return;
        try {
            instance.meta = {
                ...instance.meta,
                lastUsedAt: new Date(this.now()).toISOString(),
            };
            await this.persist(instance);
        } catch (error) {
            this.logger.warn("failed to update sandbox lastUsed", {
                error: errorMessage(error),
            });
        }
    }

    private async persist(instance: Instance): Promise<void> {
        await writeSandboxMeta(
            sandboxPaths(this.config.root, instance.meta.sessionId).meta,
            instance.meta
        );
    }

    private async loadMeta(
        sessionId: string
    ): Promise<SandboxMeta | undefined> {
        const paths = sandboxPaths(this.config.root, sessionId);
        try {
            return await readSandboxMeta(paths.meta, sessionId);
        } catch (error) {
            try {
                const backup = await backupSandboxMeta(paths.meta);
                this.logger.warn("sandbox metadata corrupt; backed up", {
                    path: paths.meta,
                    backup,
                    error: errorMessage(error),
                });
            } catch {
                // missing file or backup failure: rebuild a fresh record
            }
            return undefined;
        }
    }

    private async reclaimLocked(
        sessionId: string,
        previous: SandboxMeta
    ): Promise<SandboxMeta> {
        const paths = sandboxPaths(this.config.root, sessionId);
        const stamp = new Date(this.now()).toISOString();
        const next: SandboxMeta = {
            ...previous,
            generation: previous.generation + 1,
            packages: [],
            createdAt: stamp,
            lastUsedAt: stamp,
        };
        this.instances.delete(sessionId);
        await rm(paths.dir, { recursive: true, force: true });
        await writeSandboxMeta(paths.meta, next);
        this.logger.info("sandbox reclaimed", {
            session: sessionId,
            generation: next.generation,
        });
        return next;
    }

    private isExpired(meta: SandboxMeta, now: number): boolean {
        const lastUsed = Date.parse(meta.lastUsedAt);
        if (Number.isNaN(lastUsed)) return false;
        return now - lastUsed >= this.config.idleTtlMs;
    }

    private async sweep(): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            const entries = await readdir(this.config.root, {
                withFileTypes: true,
            }).catch(() => []);
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith(".json")) {
                    continue;
                }
                const sessionId = entry.name.slice(0, -".json".length);
                assertSessionId(sessionId);
                const instance = this.instances.get(sessionId);
                if (instance !== undefined && instance.active > 0) continue;
                await this.withLock(sessionId, async () => {
                    const current = this.instances.get(sessionId);
                    if (current !== undefined && current.active > 0) {
                        return;
                    }
                    const meta = await this.loadMeta(sessionId);
                    if (meta === undefined) return;
                    if (!this.isExpired(meta, this.now())) return;
                    await this.reclaimLocked(sessionId, meta);
                });
            }
        } catch (error) {
            this.logger.warn("sandbox TTL sweep failed", {
                error: errorMessage(error),
            });
        } finally {
            this.sweeping = false;
        }
    }

    private async statusValue(
        sessionId: string,
        dir: string,
        meta: SandboxMeta | undefined,
        instance: Instance | undefined
    ): Promise<SandboxStatus> {
        const exists = await pathExists(dir);
        return statusText({
            host: this.id,
            sessionId,
            dir,
            exists,
            generation: meta?.generation ?? 1,
            packages: meta?.packages ?? [],
            createdAt: meta?.createdAt ?? null,
            lastUsedAt: meta?.lastUsedAt ?? null,
            idleTtlMs: this.config.idleTtlMs,
            activeCommands: instance?.active ?? 0,
            backgroundCommands: instance?.background ?? 0,
            allowRuntimePackages: this.config.allowRuntimePackages,
        });
    }

    private resolveWorkdir(
        instance: Instance,
        workdir: string | undefined
    ): string {
        if (workdir === undefined) return instance.dir;
        return isAbsolute(workdir) ? workdir : join(instance.dir, workdir);
    }

    private async requireBaseEnvironment(): Promise<string> {
        const configured = this.config.baseEnvironment.trim();
        if (configured === "") {
            throw new Error(
                "sandbox environment is not configured " +
                    "(hosts.sandbox.baseEnvironment is empty); " +
                    "set a Nix buildEnv store path"
            );
        }
        if (!isAbsolute(configured)) {
            throw new Error(
                `sandbox baseEnvironment must be an absolute store path, ` +
                    `got ${JSON.stringify(configured)}`
            );
        }
        try {
            const info = await stat(configured);
            if (!info.isDirectory()) throw new Error("not a directory");
        } catch (error) {
            throw new Error(
                `sandbox baseEnvironment ${JSON.stringify(configured)} ` +
                    `is not a readable directory: ${errorMessage(error)}`
            );
        }
        return configured;
    }

    private async requireBash(): Promise<string> {
        return await this.resolveBinary("bash", "bash", "bash");
    }

    private async requireSetpriv(): Promise<string> {
        const command = this.config.noNewPrivilegesCommand.trim() || "setpriv";
        return await this.resolveBinary("setpriv", command, "setpriv");
    }

    private async requireNix(): Promise<string> {
        const command = this.config.nixBinary.trim() || "nix";
        return await this.resolveBinary("nix", command, "nix");
    }

    private async resolveBinary(
        key: string,
        command: string,
        label: string
    ): Promise<string> {
        const cached = this.binaries.get(key);
        if (cached !== undefined) return cached;
        try {
            const resolved = await this.deps.resolveExecutable(
                command,
                process.env
            );
            this.binaries.set(key, resolved);
            return resolved;
        } catch (error) {
            throw new Error(
                `sandbox requires ${label} (${JSON.stringify(command)}): ` +
                    `${errorMessage(error)}`
            );
        }
    }

    private async validatePackages(
        base: string,
        packages: readonly string[]
    ): Promise<void> {
        const hostBash = await this.requireBash();
        const nix = await this.requireNix();
        const command =
            `exec ${shellQuote(nix)} shell ${shellQuote(base)} ` +
            `${packages.map((item) => shellQuote(item)).join(" ")} ` +
            `--command ${shellQuote(hostBash)} -c true`;
        const execution = await this.deps.spawnBash({
            command,
            workdir: this.config.root,
            timeoutMs: this.config.nixTimeoutMs,
        });
        const result = await execution.result();
        if (result.timedOut) {
            throw new Error(
                `timed out after ${result.timeoutMs}ms while realizing ` +
                    `sandbox packages: ${packages.join(", ")}`
            );
        }
        if (result.exitCode !== 0) {
            const stderr = result.stderr.text.trim();
            throw new Error(
                `failed to realize sandbox packages (${packages.join(", ")}): ` +
                    (stderr === "" ? "nix exited with an error" : stderr)
            );
        }
    }

    private async withLock<T>(
        sessionId: string,
        operation: () => Promise<T>
    ): Promise<T> {
        const previous = this.locks.get(sessionId) ?? Promise.resolve();
        const next = previous.then(operation, operation);
        this.locks.set(
            sessionId,
            next.then(
                () => undefined,
                () => undefined
            )
        );
        return await next;
    }
}

function normalizePackages(packages: readonly string[]): string[] {
    const seen = new Set<string>();
    for (const item of packages) {
        const value = item.trim();
        if (value === "") continue;
        if (value.startsWith("-")) {
            throw new Error(
                `invalid sandbox package ${JSON.stringify(item)}: ` +
                    "must not start with a nix option"
            );
        }
        if (
            value.includes("\u0000") ||
            value.includes("\n") ||
            value.includes("\r")
        ) {
            throw new Error(
                `invalid sandbox package ${JSON.stringify(item)}: ` +
                    "must not contain control characters"
            );
        }
        seen.add(value);
    }
    return [...seen];
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
