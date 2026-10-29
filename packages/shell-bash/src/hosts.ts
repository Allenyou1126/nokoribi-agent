import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type {
    DshEnvironment,
    ShellExecRequest,
    ShellExecution,
    ShellExpiryPolicy,
    ShellRunResult,
} from "@deepseek-ai/dsh-shell";

/** Host families accepted by the router (07.2). */
export type ShellHostKind = "local" | "sandbox" | "ssh" | "client";

/** Every host family the v1 router understands. */
export const SHELL_HOST_KINDS: readonly ShellHostKind[] = [
    "local",
    "sandbox",
    "ssh",
    "client",
];

/** Interactive shell arguments shared by every host terminal launch. */
export const TERMINAL_BASH_ARGS: readonly string[] = [
    "--noprofile",
    "--norc",
    "-i",
];

/** Capabilities a host advertises to the model-facing tool layer. */
export interface ShellHostCapabilities {
    /** Whether `run_in_background` is supported. */
    readonly background: boolean;
    /** DSH permission-sandbox semantics; every v1 host reports false. */
    readonly sandbox: false;
    /** Whether `workdir` values are host-local or remote paths. */
    readonly workdir: "local" | "remote";
    /** Whether the host can launch a persistent interactive terminal. */
    readonly terminal: boolean;
}

/** One execution request routed through `ctx.shellHosts`. */
export interface ShellHostExecRequest {
    /** Shell command line, interpreted by the host's shell. */
    readonly command: string;
    /** Working directory override; host defaults apply when omitted. */
    readonly workdir?: string | undefined;
    /** Timeout override in milliseconds; the executor caps it. */
    readonly timeoutMs?: number | undefined;
    /** Deadline policy at expiry; sandbox background calls use `none`. */
    readonly onExpiry?: ShellExpiryPolicy | undefined;
    /** Cancellation signal owned by the caller. */
    readonly signal?: AbortSignal | undefined;
    /** Ordinary environment entries the host may extend (for example PATH). */
    readonly env?: Readonly<Record<string, string>> | undefined;
    /** Managed `DSH_*` facts; hosts may add their own keys. */
    readonly dshEnv?: DshEnvironment | undefined;
    /** Owning session used by per-session hosts such as sandbox. */
    readonly sessionId?: string | undefined;
    /** Whether the caller asked for a background job. */
    readonly runInBackground?: boolean | undefined;
}

/** Execute one request on a host; used by the registry's foreground path. */
export type ShellHostRunner = (
    request: ShellHostExecRequest
) => Promise<ShellRunResult>;

/** Start one request on a host; the handle is the background caller's view. */
export type ShellHostStarter = (
    request: ShellHostExecRequest
) => Promise<ShellExecution>;

/** One host-owned launch of a persistent interactive terminal. */
export interface ShellTerminalLaunchRequest {
    /** Owning session; required by per-session hosts such as sandbox. */
    readonly sessionId?: string | undefined;
    /** Initial working directory requested by the terminal tool. */
    readonly cwd?: string | undefined;
    /** Cancellation of the unpublished launch. */
    readonly signal?: AbortSignal | undefined;
}

/** Fully resolved terminal launch returned by a host provider. */
export interface ShellTerminalLaunch {
    /** Executable and arguments for the PTY; never a shell string. */
    readonly argv: readonly string[];
    /** Working directory in the host execution world. */
    readonly cwd: string;
    /** Host-owned environment entries merged after the upstream env. */
    readonly env?: Readonly<Record<string, string>> | undefined;
    /** Idempotent release of host-owned pins or leases after PTY teardown. */
    readonly release?: (() => void | Promise<void>) | undefined;
}

/**
 * A host provider registered with the router (07.2).
 *
 * Providers own execution for their environment. The router supplies
 * {@link ShellHostRegistry.spawnBash} so both built-in providers can reuse the
 * inherited local bash mechanics (deadlines, bounded output, spill files,
 * cancellation) with their own argv and environment.
 */
export interface ShellHostProvider {
    /** Full host id, `<kind>:<instance>`. */
    readonly id: string;
    /** Host family; must match the id prefix. */
    readonly kind: ShellHostKind;
    /** Short human-readable title. */
    readonly title: string;
    /** Short model-facing description (07.4). */
    readonly description: string;
    /** Advertised capabilities. */
    readonly capabilities: ShellHostCapabilities;
    /** Foreground execution; at least one of `run`/`start` is required. */
    readonly run?: ShellHostRunner | undefined;
    /** Background-capable execution; required when `background` is true. */
    readonly start?: ShellHostStarter | undefined;
    /** Reset a per-session host instance (sandbox). */
    readonly reset?: ((sessionId: string) => Promise<void>) | undefined;
    /** Inspect a per-session host instance (sandbox). */
    readonly status?: ((sessionId: string) => Promise<unknown>) | undefined;
    /** Release all resources of one session (for `/clear` and goal archive). */
    readonly disposeSession?:
        | ((sessionId: string) => Promise<void>)
        | undefined;
    /** Launch a persistent interactive terminal; requires `capabilities.terminal`. */
    readonly terminal?:
        | ((
              request: ShellTerminalLaunchRequest
          ) => Promise<ShellTerminalLaunch>)
        | undefined;
    /**
     * Default working directory when a request omits one.
     *
     * The router applies it to local execution; it is deliberately absent from
     * {@link ShellHostInfo} so discovery output stays short.
     */
    readonly defaultWorkdir?: string | undefined;
}

/** Public host metadata returned by {@link ShellHostRegistry.list}. */
export interface ShellHostInfo {
    readonly id: string;
    readonly kind: ShellHostKind;
    readonly title: string;
    readonly description: string;
    readonly capabilities: ShellHostCapabilities;
}

/** Construction options for the registry service. */
export interface ShellHostRegistryOptions {
    /** Host id used when a caller does not name one. */
    readonly defaultHost: string;
    /**
     * The router's bash mechanics, used by host providers to spawn their own
     * argv/environment with DSH-consistent limits and output handling.
     */
    readonly spawnBash?:
        | ((request: ShellExecRequest) => Promise<ShellExecution>)
        | undefined;
}

declare module "@deepseek-ai/cordis" {
    interface Context {
        shellHosts: ShellHostRegistry;
    }
}

const HOST_ID_PATTERN: RegExp = /^([a-z]+):([A-Za-z0-9][A-Za-z0-9._-]*)$/;

function hostKindOfId(id: string): ShellHostKind {
    const match = HOST_ID_PATTERN.exec(id);
    const kind = match?.[1];
    if (match === null || kind === undefined) {
        throw new Error(
            `invalid shell host id "${id}": expected "<kind>:<instance>"`
        );
    }
    if (!SHELL_HOST_KINDS.includes(kind as ShellHostKind)) {
        throw new Error(
            `invalid shell host id "${id}": unknown kind "${kind}" ` +
                `(expected one of ${SHELL_HOST_KINDS.join(", ")})`
        );
    }
    return kind as ShellHostKind;
}

function requireText(id: string, field: string, value: string): void {
    if (value.trim() === "") {
        throw new Error(`shell host "${id}" must declare a non-empty ${field}`);
    }
}

function validateCapabilities(
    id: string,
    capabilities: ShellHostCapabilities
): void {
    if (typeof capabilities.background !== "boolean") {
        throw new Error(
            `shell host "${id}" must declare ` +
                "capabilities.background as a boolean"
        );
    }
    if (capabilities.sandbox !== false) {
        throw new Error(
            `shell host "${id}" must declare sandbox: false ` +
                "(v1 hosts are not DSH permission sandboxes)"
        );
    }
    if (capabilities.workdir !== "local" && capabilities.workdir !== "remote") {
        throw new Error(
            `shell host "${id}" must declare capabilities.workdir ` +
                'as "local" or "remote"'
        );
    }
    if (typeof capabilities.terminal !== "boolean") {
        throw new Error(
            `shell host "${id}" must declare capabilities.terminal ` +
                "as a boolean"
        );
    }
}

function presentHost(provider: ShellHostProvider): ShellHostInfo {
    return {
        id: provider.id,
        kind: provider.kind,
        title: provider.title,
        description: provider.description,
        capabilities: { ...provider.capabilities },
    };
}

function describeIds(ids: readonly string[]): string {
    return ids.length === 0 ? "none" : ids.join(", ");
}

/**
 * Registry (`ctx.shellHosts`) of executable shell hosts.
 *
 * The router owns this service and is the only `ctx.shell` provider (D24):
 * hosts register execution here, model-facing tools select a host, and the
 * router supplies the shared bash mechanics through {@link spawnBash}. The
 * registry validates id uniqueness, the `<kind>:` prefix, and that the
 * configured default host exists before a caller can use it.
 */
export class ShellHostRegistry extends Service {
    private readonly hosts: Map<string, ShellHostProvider> = new Map();
    private readonly changeListeners: Set<() => void> = new Set();
    private readonly defaultHostId: string;
    private readonly bashSpawner:
        | ((request: ShellExecRequest) => Promise<ShellExecution>)
        | undefined;

    /**
     * Create and install the `ctx.shellHosts` service.
     * @param ctx - Cordis context that owns the service.
     * @param options - default host id and the router bash spawner.
     */
    constructor(ctx: Context, options: ShellHostRegistryOptions) {
        super(ctx, "shellHosts");
        hostKindOfId(options.defaultHost);
        this.defaultHostId = options.defaultHost;
        this.bashSpawner = options.spawnBash;
    }

    /** Host id used when a caller does not name one. */
    get defaultHost(): string {
        return this.defaultHostId;
    }

    /**
     * Register one host provider. The registration is disposed with the
     * calling plugin fiber when the returned disposer is not invoked.
     * @param provider - host metadata, capabilities, and execution.
     * @returns the exact disposer that unregisters the provider.
     */
    register(provider: ShellHostProvider): () => void {
        const kindOfId = hostKindOfId(provider.id);
        if (provider.kind !== kindOfId) {
            throw new Error(
                `shell host "${provider.id}" declares kind ` +
                    `"${provider.kind}" but its id prefix is ` +
                    `"${kindOfId}"`
            );
        }
        requireText(provider.id, "title", provider.title);
        requireText(provider.id, "description", provider.description);
        validateCapabilities(provider.id, provider.capabilities);
        if (provider.capabilities.background && provider.start === undefined) {
            throw new Error(
                `shell host "${provider.id}" declares background support ` +
                    "but does not implement start()"
            );
        }
        if (provider.capabilities.terminal && provider.terminal === undefined) {
            throw new Error(
                `shell host "${provider.id}" declares terminal support ` +
                    "but does not implement terminal()"
            );
        }
        if (
            !provider.capabilities.terminal &&
            provider.terminal !== undefined
        ) {
            throw new Error(
                `shell host "${provider.id}" implements terminal() but ` +
                    "declares capabilities.terminal: false"
            );
        }
        if (this.hosts.has(provider.id)) {
            throw new Error(
                `duplicate shell host id "${provider.id}"; ` +
                    "already registered by another plugin"
            );
        }
        this.hosts.set(provider.id, provider);
        this.notifyChange();
        return () => {
            if (this.hosts.get(provider.id) === provider) {
                this.hosts.delete(provider.id);
                this.notifyChange();
            }
        };
    }

    /**
     * Observe host registrations and unregistrations.
     * @param listener - called after every successful registry change.
     * @returns disposer that removes exactly this listener.
     */
    onChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => {
            this.changeListeners.delete(listener);
        };
    }

    /**
     * Launch one persistent terminal through a host provider.
     * @param hostId - target host id.
     * @param request - session, directory, and cancellation.
     * @returns the host-owned terminal launch.
     * @throws when the host is unknown or does not implement terminals.
     */
    async terminalLaunch(
        hostId: string,
        request: ShellTerminalLaunchRequest
    ): Promise<ShellTerminalLaunch> {
        const provider = this.hosts.get(hostId);
        if (provider === undefined) {
            throw new Error(
                `unknown shell host "${hostId}" (registered: ` +
                    `${describeIds(this.list().map((host) => host.id))})`
            );
        }
        if (
            !provider.capabilities.terminal ||
            provider.terminal === undefined
        ) {
            const capable = this.list()
                .filter((host) => host.capabilities.terminal)
                .map((host) => host.id);
            throw new Error(
                `shell host "${hostId}" does not support persistent ` +
                    `terminals (terminal-capable: ${describeIds(capable)})`
            );
        }
        return await provider.terminal(request);
    }

    /**
     * Enumerate registered hosts, sorted by id so model-visible output is
     * deterministic.
     * @returns metadata snapshots of every registered host.
     */
    list(): ShellHostInfo[] {
        return [...this.hosts.values()]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(presentHost);
    }

    /**
     * Look one host up by id.
     * @param id - full host id.
     * @returns the host metadata, or `undefined` when it is not registered.
     */
    get(id: string): ShellHostInfo | undefined {
        const provider = this.hosts.get(id);
        return provider === undefined ? undefined : presentHost(provider);
    }

    /**
     * Require the configured default host to be registered.
     * @returns the default host metadata.
     * @throws when the default host plugin is not loaded.
     */
    requireDefaultHost(): ShellHostInfo {
        const provider = this.hosts.get(this.defaultHostId);
        if (provider !== undefined) return presentHost(provider);
        const registered = this.list().map((host) => host.id);
        throw new Error(
            `default shell host "${this.defaultHostId}" is not ` +
                `registered (registered: ${describeIds(registered)}); ` +
                "load a host plugin such as @nokoribi/shell-host-local"
        );
    }

    /**
     * Resolve and execute one request on a host.
     * @param request - the host-agnostic execution request.
     * @param hostId - target host; the default host when omitted.
     * @returns the executor's foreground result.
     * @throws when the host is unknown or cannot execute.
     */
    async execute(
        request: ShellHostExecRequest,
        hostId?: string
    ): Promise<ShellRunResult> {
        const provider = this.requireProvider(hostId);
        if (provider.run !== undefined) return await provider.run(request);
        if (provider.start !== undefined) {
            return await (await provider.start(request)).result();
        }
        throw new Error(
            `shell host "${provider.id}" does not implement execution`
        );
    }

    /**
     * Resolve and start one request on a host without waiting for completion.
     * @param request - the host-agnostic execution request.
     * @param hostId - target host; the default host when omitted.
     * @returns the live execution handle.
     * @throws when the host is unknown or does not support background work.
     */
    async start(
        request: ShellHostExecRequest,
        hostId?: string
    ): Promise<ShellExecution> {
        const provider = this.requireProvider(hostId);
        if (provider.start === undefined) {
            throw new Error(
                `shell host "${provider.id}" does not support background jobs`
            );
        }
        return await provider.start(request);
    }

    /**
     * Spawn arbitrary bash mechanics through the router. Host providers use
     * this to keep DSH deadlines, bounded output, spill files, and cancellation
     * semantics while replacing argv and environment for their environment.
     * @param request - fully resolved caller request.
     * @returns the live execution handle.
     * @throws when the router did not install a bash spawner.
     */
    async spawnBash(request: ShellExecRequest): Promise<ShellExecution> {
        if (this.bashSpawner === undefined) {
            throw new Error(
                "shell router did not install a bash spawner; " +
                    "host providers cannot execute"
            );
        }
        return await this.bashSpawner(request);
    }

    /**
     * Whether one host implements background execution.
     * @param hostId - target host id.
     * @returns true when `start()` is available.
     */
    hasStart(hostId: string): boolean {
        return this.hosts.get(hostId)?.start !== undefined;
    }

    /**
     * Whether one host exposes per-session status.
     * @param hostId - target host id.
     * @returns true when `status()` is available.
     */
    hasStatus(hostId: string): boolean {
        return this.hosts.get(hostId)?.status !== undefined;
    }

    /**
     * Reset one per-session host instance.
     * @param hostId - target host.
     * @param sessionId - owning session.
     */
    async reset(hostId: string, sessionId: string): Promise<void> {
        const provider = this.hosts.get(hostId);
        if (provider?.reset === undefined) {
            throw new Error(`shell host "${hostId}" does not support reset`);
        }
        await provider.reset(sessionId);
    }

    /**
     * Inspect one per-session host instance.
     * @param hostId - target host.
     * @param sessionId - owning session.
     * @returns the provider-owned status value.
     */
    async status(hostId: string, sessionId: string): Promise<unknown> {
        const provider = this.hosts.get(hostId);
        if (provider?.status === undefined) {
            throw new Error(`shell host "${hostId}" does not expose status`);
        }
        return await provider.status(sessionId);
    }

    /**
     * Release one session across every host that owns per-session resources.
     * Used by `/clear` and goal archive; failures are aggregated after every
     * provider had a chance to clean up.
     * @param sessionId - session being released.
     */
    async disposeSession(sessionId: string): Promise<void> {
        const failures: unknown[] = [];
        for (const provider of this.hosts.values()) {
            if (provider.disposeSession === undefined) continue;
            try {
                await provider.disposeSession(sessionId);
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                `failed to dispose shell host sessions for "${sessionId}"`
            );
        }
    }

    private notifyChange(): void {
        for (const listener of Array.from(this.changeListeners)) {
            try {
                listener();
            } catch {
                // Host registration stays atomic even when an observer fails.
            }
        }
    }

    private requireProvider(hostId?: string): ShellHostProvider {
        const target = hostId ?? this.requireDefaultHost().id;
        const provider = this.hosts.get(target);
        if (provider === undefined) {
            const registered = this.list().map((host) => host.id);
            throw new Error(
                `unknown shell host "${target}" (registered: ` +
                    `${describeIds(registered)})`
            );
        }
        return provider;
    }
}
