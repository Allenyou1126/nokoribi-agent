import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

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

function bash(
    command: string,
    description: string,
    extra: Record<string, unknown> = {}
): ScriptedResponse {
    return {
        kind: "tool-call",
        name: "bash",
        arguments: { command, description, ...extra },
    };
}

function findSetpriv(): string | undefined {
    try {
        const value = execFileSync("sh", ["-c", "command -v setpriv"], {
            encoding: "utf8",
        }).trim();
        return value === "" ? undefined : value;
    } catch {
        return undefined;
    }
}

const SETPRIV = findSetpriv();

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
    extraEnv: Record<string, string> = {},
    home?: string
): Promise<DaemonHandle> {
    const target = home ?? (await tempHome());
    if (home === undefined) homes.push(target);
    const handle = await startDaemon({
        home: target,
        token: `m3-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: server.baseURL,
        extraEnv: {
            NOKORIBI_MODEL: "main-model",
            NOKORIBI_DEFAULT_HOST: "local:workspace",
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
    timeoutSeconds = 20
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

describe("M3 process scenarios", () => {
    it("runs a foreground command on the local host", async () => {
        const server = await scripted((_request, index) =>
            index === 0
                ? bash("printf 'local-ok\\n'", "Print a local probe")
                : { kind: "text", text: "local done" }
        );
        const running = await daemon(server);
        expect(
            (await postInbound(running, "run local", "m3-local-1")).status
        ).toBe(202);
        await waitForText(running, 0, "local done");
        expect(await sessionText(running.home)).toContain("local-ok");
    });

    it.skipIf(SETPRIV === undefined)(
        "runs a foreground command in the sandbox with no sudo",
        async () => {
            const server = await scripted((_request, index) =>
                index === 0
                    ? bash(
                          "printf 'sandbox-ok\\n'; " +
                              "printf 'dir=%s\\n' \"$DSH_SANDBOX_DIR\"; " +
                              "pwd; sudo -n true 2>&1 || printf 'sudo-blocked\\n'",
                          "Probe the sandbox environment"
                      )
                    : { kind: "text", text: "sandbox done" }
            );
            const home = await tempHome();
            homes.push(home);
            await mkdir(join(home, "sandbox-env/bin"), { recursive: true });
            const running = await daemon(
                server,
                {
                    NOKORIBI_DEFAULT_HOST: "sandbox:default",
                    NOKORIBI_SANDBOX_BASE_ENV: join(home, "sandbox-env"),
                    NOKORIBI_SANDBOX_SETPRIV: SETPRIV ?? "setpriv",
                    NOKORIBI_SANDBOX_ALLOW_RUNTIME_PACKAGES: "false",
                    NOKORIBI_SANDBOX_SWEEP_MS: "60000",
                },
                home
            );
            expect(
                (await postInbound(running, "run sandbox", "m3-sandbox-1"))
                    .status
            ).toBe(202);
            await waitForText(running, 0, "sandbox done");
            const text = await sessionText(running.home);
            expect(text).toContain("sandbox-ok");
            expect(text).toContain(`dir=${join(home, "sandboxes", "main-")}`);
            expect(text).toContain("sudo-blocked");
            expect(text).toContain("privilege escalation is disabled");
            const statusValue = await status(running);
            const dir = join(
                home,
                "sandboxes",
                statusValue.mainSessionId ?? "missing"
            );
            await expect(readdir(dir)).resolves.toContain(".path-guard");
        }
    );

    it("rejects an unknown host and discovers the real hosts", async () => {
        const server = await scripted((_request, index) => {
            if (index === 0) {
                return bash("echo never", "Probe an unknown host", {
                    host: "bogus:missing",
                });
            }
            if (index === 1) {
                return {
                    kind: "tool-call",
                    name: "get_available_shell_host",
                    arguments: {},
                };
            }
            return { kind: "text", text: "hosts discovered" };
        });
        const running = await daemon(server);
        expect(
            (await postInbound(running, "discover hosts", "m3-discovery-1"))
                .status
        ).toBe(202);
        await waitForText(running, 0, "hosts discovered");
        const text = await sessionText(running.home);
        expect(text).toContain("unknown shell host");
        expect(text).toContain("sandbox:default");
        expect(text).toContain("local:workspace");
    });

    it("runs a background job and reads it with job_output", async () => {
        const server = await scripted((request, index) => {
            if (index === 0) {
                return bash("printf 'bg-ok\\n'", "Print a background probe", {
                    run_in_background: true,
                });
            }
            const encoded = JSON.stringify(request.body.messages ?? []);
            const match = /started background job (bash-[A-Za-z0-9-]+)/.exec(
                encoded
            );
            if (index === 1 && match?.[1] !== undefined) {
                return {
                    kind: "tool-call",
                    name: "job_output",
                    arguments: {
                        job_id: match[1],
                        wait: true,
                        timeout_ms: 5000,
                    },
                };
            }
            return { kind: "text", text: "background done" };
        });
        const running = await daemon(server);
        expect(
            (await postInbound(running, "run background", "m3-background-1"))
                .status
        ).toBe(202);
        await waitForText(running, 0, "background done");
        const text = await sessionText(running.home);
        expect(text).toContain("started background job bash-");
        expect(text).toContain("bg-ok");
    });

    it.skipIf(SETPRIV === undefined)(
        "deletes the old session's sandbox on /clear",
        async () => {
            const server = await scripted((_request, index) =>
                index === 0
                    ? bash("printf 'sandbox-clear\\n'", "Create a sandbox")
                    : { kind: "text", text: "clear probe done" }
            );
            const home = await tempHome();
            homes.push(home);
            await mkdir(join(home, "sandbox-env/bin"), { recursive: true });
            const running = await daemon(
                server,
                {
                    NOKORIBI_DEFAULT_HOST: "sandbox:default",
                    NOKORIBI_SANDBOX_BASE_ENV: join(home, "sandbox-env"),
                    NOKORIBI_SANDBOX_SETPRIV: SETPRIV ?? "setpriv",
                    NOKORIBI_SANDBOX_ALLOW_RUNTIME_PACKAGES: "false",
                },
                home
            );
            expect(
                (await postInbound(running, "make sandbox", "m3-clear-1"))
                    .status
            ).toBe(202);
            await waitForText(running, 0, "clear probe done");
            const before = await status(running);
            const oldSession = before.mainSessionId;
            expect(oldSession).not.toBeNull();
            const oldDir = join(home, "sandboxes", oldSession ?? "missing");
            await expect(readdir(oldDir)).resolves.toBeDefined();

            expect(
                (await postInbound(running, "/clear", "m3-clear-2")).status
            ).toBe(202);
            await waitForText(running, 0, "已新建会话");
            const after = await status(running);
            expect(after.mainSessionId).not.toBe(oldSession);
            await expect(readdir(oldDir)).rejects.toMatchObject({
                code: "ENOENT",
            });
        }
    );
});
