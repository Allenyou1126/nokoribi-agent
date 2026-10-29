import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    outbound,
    postInbound,
    startDaemon,
    status,
    tempHome,
    type DaemonHandle,
} from "./harness.js";
import { findSessionFiles } from "./paths.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedResponse,
} from "./support/scripted-llm.js";

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];

function tool(name: string, args: Record<string, unknown>): ScriptedResponse {
    return { kind: "tool-call", name, arguments: args };
}

function sessionIdFrom(body: Record<string, unknown>): string {
    const serialized = JSON.stringify(body);
    const match = /started terminal session ([A-Za-z0-9_-]+)/.exec(serialized);
    const id = match?.[1];
    if (id === undefined) {
        throw new Error("terminal session id not found in the model request");
    }
    return id;
}

async function scripted(
    main: (
        request: { readonly body: Record<string, unknown> },
        index: number
    ) => ScriptedResponse
): Promise<ScriptedLlmServer> {
    const server = await startScriptedLlm({
        main: (request, index) => main(request, index),
    });
    servers.push(server);
    return server;
}

async function daemon(
    server: ScriptedLlmServer,
    extraEnv: Record<string, string> = {}
): Promise<DaemonHandle> {
    const home = await tempHome();
    homes.push(home);
    const handle = await startDaemon({
        home,
        token: `m10-terminal-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: server.baseURL,
        extraEnv: {
            NOKORIBI_DEFAULT_HOST: "local:workspace",
            NOKORIBI_TERMINAL_BASH_PATH: "bash",
            ...extraEnv,
        },
    });
    daemons.push(handle);
    return handle;
}

async function sessionText(home: string): Promise<string> {
    const files = await findSessionFiles(home);
    const contents = await Promise.all(
        files.map((path) => readFile(path, "utf8"))
    );
    return contents.join("\n");
}

async function waitForText(
    running: DaemonHandle,
    after: number,
    needle: string,
    timeoutSeconds = 30
): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let seq = after;
    for (;;) {
        const batch = await outbound(running, seq, 1);
        seq = batch.nextSeq;
        const found = batch.items.find((item) => item.text.includes(needle));
        if (found !== undefined) return found.text;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for outbound text ${JSON.stringify(needle)}`
            );
        }
    }
}

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("M10 terminal process scenarios", () => {
    it("keeps local terminal state across tool calls", async () => {
        const server = await scripted((request, index) => {
            if (index === 0) {
                return tool("terminal_open", { type: "local:workspace" });
            }
            const sessionId = sessionIdFrom(request.body);
            if (index === 1) {
                return tool("terminal_send", {
                    sessionId,
                    text: "cd /tmp && export M10=ok",
                });
            }
            if (index === 2) {
                return tool("terminal_send", {
                    sessionId,
                    text: 'printf \'%s:%s\\n\' "$PWD" "$M10"',
                });
            }
            if (index === 3) {
                return tool("terminal_list", {});
            }
            if (index === 4) {
                return tool("terminal_close", { sessionId });
            }
            return { kind: "text", text: "terminal done" };
        });
        const running = await daemon(server);
        expect(
            (await postInbound(running, "run terminal", "m10-terminal-1"))
                .status
        ).toBe(202);
        await waitForText(running, 0, "terminal done");
        const text = await sessionText(running.home);
        expect(text).toContain("started terminal session");
        expect(text).toContain("/tmp:ok");
        expect(text).toContain("local:workspace");
        expect((await status(running)).ready).toBe(true);
    });

    it("clears the previous agent terminal before /clear disposes it", async () => {
        const server = await scripted((_request, index) =>
            index === 0
                ? tool("terminal_open", { type: "local:workspace" })
                : { kind: "text", text: "terminal opened" }
        );
        const running = await daemon(server);
        await postInbound(running, "open terminal", "m10-clear-1");
        await waitForText(running, 0, "terminal opened");
        await postInbound(running, "/clear", "m10-clear-2");
        const cleared = await waitForText(running, 0, "已新建会话");
        expect(cleared).toContain("旧会话已归档");
        expect(running.output()).not.toContain(
            "open persistent terminal sessions"
        );
        expect((await status(running)).ready).toBe(true);
    });

    it("does not advertise terminal tools when disabled", async () => {
        const server = await scripted(() => ({
            kind: "text",
            text: "terminal disabled",
        }));
        const running = await daemon(server, {
            NOKORIBI_TERMINAL_ENABLED: "false",
        });
        await postInbound(running, "hello", "m10-disabled-1");
        await waitForText(running, 0, "terminal disabled");
        const system = server.requests[0]?.system ?? "";
        expect(system).not.toContain("terminal_open");
        expect(system).not.toContain("持久终端（terminal_*）");
        expect(system).toContain("get_available_shell_host");
    });

    it("closes terminals during SIGTERM shutdown", async () => {
        const server = await scripted((_request, index) =>
            index === 0
                ? tool("terminal_open", { type: "local:workspace" })
                : { kind: "text", text: "terminal opened" }
        );
        const running = await daemon(server);
        await postInbound(running, "open terminal", "m10-signal-1");
        await waitForText(running, 0, "terminal opened");
        expect(await running.stop()).toBe(0);
    });
});
