import type { Context } from "@deepseek-ai/cordis";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import type { Config as BashConfig } from "@deepseek-ai/dsh-bash-local";
import type {
    ShellExecRequest,
    ShellExecSpec,
    ShellExecution,
    ShellExecutor,
} from "@deepseek-ai/dsh-shell";

import { ShellHostRegistry } from "./hosts.js";
import type { ShellHostExecRequest } from "./hosts.js";

/** Router configuration: bash-local budgets plus the default host id. */
export interface ShellRouterConfig extends BashConfig {
    /** Host id used when a caller does not name one. */
    readonly defaultHost: string;
}

/**
 * The composition's only `ctx.shell` provider.
 *
 * It extends the local bash executor so host providers can reuse real
 * execution mechanics, and it provides `ctx.shellHosts` for host discovery and
 * routing (D24). `sandboxMode` reports `danger-full-access` because the real
 * security gate is Auto review, not a DSH permission sandbox (07.11).
 *
 * The `ctx.shell` façade is intentionally sessionless. A local default host
 * can serve it; a sandbox default host cannot, because sandbox execution is
 * bound to an agent session. Model-facing tools always use `ctx.shellHosts`.
 */
export class ShellRouter extends LocalBashExecutor {
    private readonly hosts: ShellHostRegistry;

    /**
     * Create the router and its host registry.
     * @param ctx - Cordis context that owns both services.
     * @param config - bash budgets and the configured default host.
     */
    constructor(ctx: Context, config: ShellRouterConfig) {
        super(ctx, config);
        this.hosts = new ShellHostRegistry(ctx, {
            defaultHost: config.defaultHost,
            spawnBash: (request) => this.spawnBashInternal(request),
        });
    }

    /**
     * The permission-sandbox mode this executor advertises.
     *
     * Permission presets require a provider that reports a mode; ours runs
     * unconfined and the reviewer is the boundary (M2).
     */
    override get sandboxMode(): ShellExecutor["sandboxMode"] {
        return "danger-full-access";
    }

    /**
     * Resolve one request for the default host's local executor.
     * @param request - caller request with optional overrides.
     * @returns the fully specified local execution spec.
     * @throws when the configured default host is not registered.
     */
    override resolve(request: ShellExecRequest): ShellExecSpec {
        this.hosts.requireDefaultHost();
        return super.resolve(request);
    }

    /**
     * Serve the sessionless `ctx.shell` façade.
     *
     * A local default host can execute without a session. A sandbox default
     * host cannot be bound safely here, so this fails closed instead of
     * silently executing on the host; model tools use `ctx.shellHosts`.
     * @param spec - resolved local spec from {@link resolve}.
     * @returns the prepared execution handle.
     * @throws when the default host needs a session or is not local.
     */
    override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
        const host = this.hosts.requireDefaultHost();
        if (host.kind !== "local") {
            throw new Error(
                `ctx.shell cannot execute the default "${host.id}" host ` +
                    "without a session; use the bash tool (host-aware) " +
                    "or select a local default host"
            );
        }
        const providerId = host.id;
        const request: ShellHostExecRequest = {
            command: spec.command,
            workdir: spec.workdir,
            timeoutMs: spec.timeoutMs,
            onExpiry: spec.onExpiry,
            ...(spec.signal === undefined ? {} : { signal: spec.signal }),
            ...(spec.env === undefined ? {} : { env: spec.env }),
            ...(spec.dshEnv === undefined ? {} : { dshEnv: spec.dshEnv }),
        };
        if (this.hosts.hasStart(providerId)) {
            return await this.hosts.start(request, providerId);
        }
        return await super.execute(spec);
    }

    /** Resolve and spawn an explicit argv/environment through the executor. */
    private async spawnBashInternal(
        request: ShellExecRequest
    ): Promise<ShellExecution> {
        return await super.execute(super.resolve(request));
    }
}
