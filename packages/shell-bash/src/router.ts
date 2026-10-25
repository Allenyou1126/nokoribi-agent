import type { Context } from "@deepseek-ai/cordis";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import type { Config as BashConfig } from "@deepseek-ai/dsh-bash-local";
import type {
    ShellExecRequest,
    ShellExecSpec,
    ShellExecution,
    ShellExecutor,
    ShellRunResult,
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
 * It extends the local bash executor so the default local host owns real
 * execution, and it provides `ctx.shellHosts` for host discovery and future
 * host routing (D24). `sandboxMode` reports `danger-full-access` because the
 * real security gate is Auto review, not a DSH permission sandbox (07.11).
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
            runLocal: (request) => this.runLocal(request),
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
     * Execute one resolved spec on the local executor.
     * @param spec - resolved spec from {@link resolve}.
     * @returns the prepared execution handle.
     * @throws when the configured default host is not registered.
     */
    override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
        this.hosts.requireDefaultHost();
        return super.execute(spec);
    }

    /** Run one host request through the inherited local bash capability. */
    private async runLocal(
        request: ShellHostExecRequest
    ): Promise<ShellRunResult> {
        const spec = super.resolve({
            command: request.command,
            workdir: request.workdir,
            timeoutMs: request.timeoutMs,
            signal: request.signal,
        });
        const execution = await super.execute(spec);
        return execution.result();
    }
}
