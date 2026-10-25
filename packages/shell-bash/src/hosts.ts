import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { ShellRunResult } from "@deepseek-ai/dsh-shell";

/** Host families accepted by the router (07.2). */
export type ShellHostKind = "local" | "sandbox" | "ssh" | "client";

/** Every host family the v1 router understands. */
export const SHELL_HOST_KINDS: readonly ShellHostKind[] = [
    "local",
    "sandbox",
    "ssh",
    "client",
];

/** Capabilities a host advertises to the model-facing tool layer. */
export interface ShellHostCapabilities {
    /** Whether `run_in_background` is supported; M1 hosts report false. */
    readonly background: boolean;
    /** DSH permission-sandbox semantics; every v1 host reports false. */
    readonly sandbox: false;
    /** Whether `workdir` values are host-local or remote paths. */
    readonly workdir: "local" | "remote";
}

/** One execution request routed through `ctx.shellHosts`. */
export interface ShellHostExecRequest {
    /** Shell command line, interpreted by the host's shell. */
    readonly command: string;
    /** Working directory override; host defaults apply when omitted. */
    readonly workdir?: string | undefined;
    /** Timeout override in milliseconds; the executor caps it. */
    readonly timeoutMs?: number | undefined;
    /** Cancellation signal owned by the caller. */
    readonly signal?: AbortSignal | undefined;
}

/** Execute one request on a host; used by future model-facing tools. */
export type ShellHostRunner = (
    request: ShellHostExecRequest
) => Promise<ShellRunResult>;

/**
 * A host provider registered with the router (07.2, M1 subset).
 *
 * The v1 protocol keeps metadata and execution together. A local provider may
 * omit `run`; the router then serves it through its inherited local bash
 * capability, which keeps the local host on one shared executor.
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
    /** Host-specific execution; local hosts may omit it. */
    readonly run?: ShellHostRunner | undefined;
    /**
     * Default working directory when a request omits one.
     *
     * The router applies it to the local execution a host routes to; it is
     * deliberately absent from {@link ShellHostInfo} so discovery output stays
     * short.
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
    /** Fallback runner for local providers that do not implement `run`. */
    readonly runLocal?: ShellHostRunner | undefined;
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

/**
 * Registry (`ctx.shellHosts`) of executable shell hosts.
 *
 * The router owns this service and is the only `ctx.shell` provider (D24):
 * hosts register metadata here, model-facing tools select a host, and the
 * router executes the default local host through its inherited bash
 * capability. The registry validates id uniqueness, the `<kind>:` prefix, and
 * that the configured default host exists before a caller can use it.
 */
export class ShellHostRegistry extends Service {
    private readonly hosts: Map<string, ShellHostProvider> = new Map();
    private readonly defaultHostId: string;
    private readonly runLocal: ShellHostRunner | undefined;

    /**
     * Create and install the `ctx.shellHosts` service.
     * @param ctx - Cordis context that owns the service.
     * @param options - default host id and the local fallback runner.
     */
    constructor(ctx: Context, options: ShellHostRegistryOptions) {
        super(ctx, "shellHosts");
        hostKindOfId(options.defaultHost);
        this.defaultHostId = options.defaultHost;
        this.runLocal = options.runLocal;
    }

    /** Host id used when a caller does not name one. */
    get defaultHost(): string {
        return this.defaultHostId;
    }

    /**
     * Register one host provider. The registration is disposed with the
     * calling plugin fiber when the returned disposer is not invoked.
     * @param provider - host metadata, capabilities, and optional runner.
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
        if (this.hosts.has(provider.id)) {
            throw new Error(
                `duplicate shell host id "${provider.id}"; ` +
                    "already registered by another plugin"
            );
        }
        this.hosts.set(provider.id, provider);
        return () => {
            if (this.hosts.get(provider.id) === provider) {
                this.hosts.delete(provider.id);
            }
        };
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
     *
     * M1 only supplies the local host, so the router's inherited local bash
     * capability is the runner; a provider that implements `run` owns its
     * execution instead (the seam the sandbox/SSH hosts will use).
     * @param request - the host-agnostic execution request.
     * @param hostId - target host; the default host when omitted.
     * @returns the executor's foreground result.
     * @throws when the host is unknown or cannot execute yet.
     */
    async execute(
        request: ShellHostExecRequest,
        hostId?: string
    ): Promise<ShellRunResult> {
        const target = hostId ?? this.requireDefaultHost().id;
        const provider = this.hosts.get(target);
        if (provider === undefined) {
            throw new Error(
                `unknown shell host "${target}" (registered: ` +
                    `${describeIds(this.list().map((host) => host.id))})`
            );
        }
        if (provider.run !== undefined) return provider.run(request);
        if (provider.kind === "local" && this.runLocal !== undefined) {
            return this.runLocal({
                ...request,
                workdir: request.workdir ?? provider.defaultWorkdir,
            });
        }
        throw new Error(
            `shell host "${provider.id}" does not implement execution; ` +
                "M1 only routes the local host through the router"
        );
    }
}

function describeIds(ids: readonly string[]): string {
    return ids.length === 0 ? "none" : ids.join(", ");
}
