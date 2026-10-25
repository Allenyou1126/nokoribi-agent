import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";

/** Result of resolving one host-owned session for a consumer. */
export type ResolvedHostSession =
    | { readonly agent: Agent }
    | { readonly error: Error };

interface Binding {
    readonly agent: Agent;
    readonly ready: Promise<void>;
    readonly markReady: () => void;
}

declare module "@deepseek-ai/cordis" {
    interface Context {
        /** Minimal host-session resolver used by dsh-schedule. */
        sessionController: HostSessionController;
    }
}

/**
 * Minimal `sessionController` adapter for the headless composition.
 *
 * `dsh-schedule` only calls `resolveAgent()`. The Web controller is deliberately
 * not mounted: this bridge resolves the current main session and waits until
 * the daemon has installed its session listeners and released buffered ingress.
 * Tasks bound to an older main session are deleted by `/clear`; they are not
 * cold-resumed here.
 */
export class HostSessionController extends Service {
    private binding: Binding | undefined;
    private readonly waiting = new Set<() => void>();

    /** Install the `sessionController` service. */
    constructor(ctx: Context) {
        super(ctx, "sessionController");
    }

    /**
     * Bind the current main agent and its readiness gate.
     * @param agent - live main agent.
     * @param ready - resolves once the daemon is ready to mirror its turns.
     */
    bind(agent: Agent, ready: Promise<void>): void {
        let markReady: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            markReady = resolve;
        });
        this.binding = {
            agent,
            ready: Promise.all([ready, gate]).then(() => undefined),
            markReady: () => markReady?.(),
        };
        const waiters = [...this.waiting];
        this.waiting.clear();
        for (const wake of waiters) wake();
    }

    /** Release waiters once the daemon is fully ready for model turns. */
    markReady(): void {
        this.binding?.markReady();
    }

    /** Whether a main agent is currently bound. */
    get boundSessionId(): SessionId | null {
        return this.binding?.agent.id ?? null;
    }

    /**
     * Resolve the current main session after readiness.
     * @param sessionId - durable session identity requested by the scheduler.
     * @returns the live agent, or a stable error for stale/unknown sessions.
     */
    async resolveAgent(sessionId: SessionId): Promise<ResolvedHostSession> {
        const binding = this.binding ?? (await this.waitForBinding());
        await binding.ready;
        if (this.binding !== binding) {
            return {
                error: new Error(
                    `session ${String(sessionId)} is no longer the current host session`
                ),
            };
        }
        if (binding.agent.id !== sessionId) {
            return {
                error: new Error(
                    `session ${String(sessionId)} is not the current host session`
                ),
            };
        }
        return { agent: binding.agent };
    }

    private waitForBinding(): Promise<Binding> {
        if (this.binding !== undefined) {
            return Promise.resolve(this.binding);
        }
        return new Promise<Binding>((resolve) => {
            this.waiting.add(() => {
                const binding = this.binding;
                if (binding !== undefined) resolve(binding);
            });
        });
    }
}

/** Loader plugin label. */
export const name: string = "session-bridge";

/** The bridge has no service dependencies of its own. */
export const inject: string[] = [];

/** Install the minimal session controller used by the scheduler. */
export function apply(ctx: Context): void {
    new HostSessionController(ctx);
}
