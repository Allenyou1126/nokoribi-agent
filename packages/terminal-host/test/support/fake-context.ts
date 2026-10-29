import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";
import type {
    TerminalBackend,
    TerminalSessionSnapshot,
} from "@deepseek-ai/dsh-terminal";
import type { ShellHostInfo } from "@nokoribi/shell-bash";
import { vi } from "vitest";
import type { Mock } from "vitest";

/** One terminal session owned by one fake agent. */
export interface FakeSession {
    readonly owner: Agent;
    readonly snapshot: TerminalSessionSnapshot;
}

/** Minimal fake Cordis context for terminal-host unit tests. */
export interface FakeContext {
    readonly ctx: Context;
    readonly hosts: ShellHostInfo[];
    readonly backends: Map<string, TerminalBackend>;
    readonly sessions: FakeSession[];
    readonly sections: PromptSection[];
    readonly effects: (() => unknown)[];
    readonly kill: Mock;
    /** Fire every registered `shellHosts.onChange` listener. */
    readonly shellsChanged: () => void;
    /** Run recorded plugin effects in registration order. */
    readonly disposeEffects: () => Promise<void>;
}

/** Build one fake agent; only its session id is used by the plugin. */
export function createAgent(id: string): Agent {
    return { id } as unknown as Agent;
}

/** Build one host snapshot as `ctx.shellHosts.list()` reports it. */
export function createHostInfo(
    id: string,
    terminal: boolean = true
): ShellHostInfo {
    const kind = id.startsWith("local:") ? "local" : "sandbox";
    return {
        id,
        kind,
        title: id,
        description: `${id} test host`,
        capabilities: {
            background: true,
            sandbox: false,
            workdir: "local",
            terminal,
        },
    };
}

/** Build one terminal session snapshot for a fake owner. */
export function createSnapshot(
    type: string,
    sessionId: string
): TerminalSessionSnapshot {
    return {
        sessionId: sessionId as TerminalSessionSnapshot["sessionId"],
        type,
        status: { kind: "running" },
    };
}

/**
 * Build the fake context used by controller and plugin tests.
 * @param initialHosts - hosts visible through `shellHosts.list()`.
 * @returns the fake context plus its mutable registries.
 */
export function createFakeContext(
    initialHosts: readonly ShellHostInfo[] = []
): FakeContext {
    const hosts: ShellHostInfo[] = [...initialHosts];
    const listeners = new Set<() => void>();
    const backends = new Map<string, TerminalBackend>();
    const sessions: FakeSession[] = [];
    const sections: PromptSection[] = [];
    const effects: (() => unknown)[] = [];
    const kill: Mock = vi.fn(async (): Promise<boolean> => true);
    const services: Record<string, unknown> = {};
    const terminals = {
        registerBackend: (backend: TerminalBackend): (() => void) => {
            backends.set(backend.type, backend);
            return () => {
                if (backends.get(backend.type) === backend) {
                    backends.delete(backend.type);
                }
            };
        },
        list: (owner: Agent): TerminalSessionSnapshot[] =>
            sessions
                .filter((session) => session.owner === owner)
                .map((session) => session.snapshot),
        kill,
    };
    const ctx = {
        shellHosts: {
            list: (): ShellHostInfo[] => [...hosts],
            onChange: (listener: () => void): (() => void) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        },
        terminals,
        systemPrompt: {
            section: (section: PromptSection): (() => void) => {
                sections.push(section);
                return () => {};
            },
        },
        effect: (execute: () => () => unknown): { dispose: () => void } => {
            effects.push(execute());
            return { dispose: (): void => {} };
        },
        get: (name: string): unknown => services[name],
    };
    services.terminals = terminals;
    return {
        ctx: ctx as unknown as Context,
        hosts,
        backends,
        sessions,
        sections,
        effects,
        kill,
        shellsChanged: (): void => {
            for (const listener of Array.from(listeners)) listener();
        },
        disposeEffects: async (): Promise<void> => {
            for (const effect of effects.splice(0)) await effect();
        },
    };
}
