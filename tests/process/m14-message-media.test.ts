import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    cleanupHome,
    startDaemon,
    tempHome,
    waitForOutbound,
    type DaemonHandle,
} from "./harness.js";
import { findSessionFiles } from "./paths.js";
import { c2cEvent, FakeQqBot } from "./support/fake-qq-bot.js";
import {
    startScriptedLlm,
    type ScriptedLlmServer,
    type ScriptedResponse,
} from "./support/scripted-llm.js";

/** 1x1 transparent PNG. */
const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const daemons: DaemonHandle[] = [];
const homes: string[] = [];
const servers: ScriptedLlmServer[] = [];
const fakes: FakeQqBot[] = [];
const imageServers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        daemons.splice(0).map(async (handle) => {
            await handle.stop().catch(() => undefined);
        })
    );
    await Promise.all(
        fakes.splice(0).map(async (fake) => {
            await fake.close().catch(() => undefined);
        })
    );
    await Promise.all(
        servers.splice(0).map(async (server) => {
            await server.close().catch(() => undefined);
        })
    );
    await new Promise<void>((resolve) => {
        for (const server of imageServers.splice(0)) {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }
        resolve();
    });
    await Promise.all(homes.splice(0).map((home) => cleanupHome(home)));
});

/** Serve one PNG from a loopback URL for QQ inbound image tests. */
async function startImageServer(): Promise<string> {
    const png = Buffer.from(TINY_PNG_BASE64, "base64");
    const server = createServer((_request, response) => {
        response.writeHead(200, {
            "content-type": "image/png",
            "content-length": png.length,
        });
        response.end(png);
    });
    imageServers.push(server);
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("image server did not bind a TCP port");
    }
    return `http://127.0.0.1:${String(address.port)}/image.png`;
}

interface Scenario {
    readonly running: DaemonHandle;
    readonly llm: ScriptedLlmServer;
    readonly home: string;
}

async function startScenario(
    main: (
        request: Parameters<Parameters<typeof startScriptedLlm>[0]["main"]>[0],
        index: number
    ) => ScriptedResponse,
    options: {
        readonly home?: string;
        readonly prepare?: (home: string) => Promise<void>;
    } = {}
): Promise<Scenario> {
    const llm = await startScriptedLlm({ main });
    servers.push(llm);
    const home = options.home ?? (await tempHome());
    if (options.home === undefined) homes.push(home);
    await mkdir(join(home, "workspace"), { recursive: true });
    await options.prepare?.(home);
    const running = await startDaemon({
        home,
        token: `m14-${Math.random().toString(36).slice(2)}`,
        mockBaseUrl: llm.baseURL,
        extraEnv: { NOKORIBI_MODEL: "main-model" },
    });
    daemons.push(running);
    return { running, llm, home };
}

async function postInbound(
    running: DaemonHandle,
    body: Record<string, unknown>
): Promise<Response> {
    return await fetch(`http://127.0.0.1:${running.port}/v1/inbound`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${running.token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

async function sessionText(home: string): Promise<string> {
    const files = await findSessionFiles(home);
    let text = "";
    for (const file of files) {
        text += await readFile(file, "utf8");
    }
    return text;
}

async function outbound(
    running: DaemonHandle,
    after: number,
    timeoutSeconds = 10
): Promise<{
    items: {
        seq: number;
        kind: string;
        text: string;
        files?: {
            attachmentId: string;
            name: string;
            bytes: number;
            mime: string;
        }[];
    }[];
    nextSeq: number;
}> {
    return (await waitForOutbound(
        running,
        after,
        timeoutSeconds
    )) as unknown as {
        items: {
            seq: number;
            kind: string;
            text: string;
            files?: {
                attachmentId: string;
                name: string;
                bytes: number;
                mime: string;
            }[];
        }[];
        nextSeq: number;
    };
}

/** Poll the attachment endpoint until the driver has delivered the file. */
async function waitForAttachment(
    running: DaemonHandle,
    attachmentId: string,
    timeoutMs = 10000
): Promise<Response> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const response = await fetch(
            `http://127.0.0.1:${running.port}/v1/attachments/${encodeURIComponent(attachmentId)}`,
            { headers: { authorization: `Bearer ${running.token}` } }
        );
        if (response.status === 200) return response;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for attachment ${attachmentId} (status ${String(
                    response.status
                )})`
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe("M14 inbound image process scenarios", () => {
    it("stores an inbound image and delivers it to the model request", async () => {
        const scenario = await startScenario(() => ({
            kind: "text",
            text: "image received",
        }));
        const response = await postInbound(scenario.running, {
            messageId: "img-1",
            text: "look at this",
            images: [{ mime: "image/png", data: TINY_PNG_BASE64 }],
        });
        expect(response.status).toBe(202);
        await outbound(scenario.running, 0);
        const text = await sessionText(scenario.home);
        expect(text).toContain('"type":"image"');
        expect(text).toContain('"mediaType":"image/png"');
        expect(text).toContain("look at this");
        // The text-only route projects the image to text, never raw bytes.
        const request = JSON.stringify(scenario.llm.requests);
        expect(request).toContain("look at this");
        expect(request.toLowerCase()).toContain("image");
    });

    it("degrades to text only when the image cannot be stored", async () => {
        const scenario = await startScenario(() => ({
            kind: "text",
            text: "text received",
        }));
        const response = await postInbound(scenario.running, {
            messageId: "img-bad",
            text: "broken image",
            images: [
                {
                    mime: "image/png",
                    data: Buffer.from("not a png").toString("base64"),
                },
            ],
        });
        expect(response.status).toBe(202);
        await outbound(scenario.running, 0);
        const text = await sessionText(scenario.home);
        expect(text).toContain("broken image");
        expect(text).not.toContain('"type":"image"');
    });
});

describe("M14 QQ inbound image process scenario", () => {
    it("downloads a QQ image attachment and forwards it to the model", async () => {
        const fake = await FakeQqBot.start({ heartbeatMs: 200 });
        fakes.push(fake);
        const llm = await startScriptedLlm({
            main: () => ({ kind: "text", text: "qq image received" }),
        });
        servers.push(llm);
        const home = await tempHome();
        homes.push(home);
        await mkdir(join(home, "workspace"), { recursive: true });
        const imageUrl = await startImageServer();
        const running = await startDaemon({
            home,
            token: `m14-qq-${Math.random().toString(36).slice(2)}`,
            mockBaseUrl: llm.baseURL,
            extraEnv: {
                NOKORIBI_MODEL: "main-model",
                NOKORIBI_QQ_BOT_ENABLED: "true",
                NOKORIBI_QQ_BOT_APP_ID: "app-1",
                NOKORIBI_QQ_BOT_CLIENT_SECRET: "qq-secret",
                NOKORIBI_QQ_BOT_API_BASE: fake.apiUrl,
                NOKORIBI_QQ_BOT_TOKEN_BASE: fake.apiUrl,
                NOKORIBI_QQ_BOT_GATEWAY_URL: fake.wsUrl,
                NOKORIBI_QQ_BOT_REQUEST_TIMEOUT_MS: "2000",
                NOKORIBI_QQ_BOT_CONNECT_TIMEOUT_MS: "3000",
                NOKORIBI_QQ_BOT_RECONNECT_BASE_MS: "50",
                NOKORIBI_QQ_BOT_RECONNECT_MAX_MS: "100",
            },
        });
        daemons.push(running);
        await fake.waitForIdentify();
        fake.pushEvent("C2C_MESSAGE_CREATE", {
            ...c2cEvent({
                id: "qq-img-1",
                userId: "user-1",
                content: "look at my image",
            }),
            attachments: [{ content_type: "image/png", url: imageUrl }],
        });
        const reply = await fake.waitForSend(
            (send) => JSON.stringify(send.body).includes("qq image received"),
            15000
        );
        expect(reply.path).toBe("/v2/users/user-1/messages");
        const text = await sessionText(home);
        expect(text).toContain('"type":"image"');
        expect(text).toContain("look at my image");
    });
});

describe("M14 outbound file process scenarios", () => {
    it("sends a workspace file through send_to_user and serves its bytes", async () => {
        const fileContent = "deliverable body\n";
        const scenario = await startScenario(
            (_request, index) =>
                index === 0
                    ? {
                          kind: "tool-call",
                          name: "send_to_user",
                          arguments: {
                              text: "artifact ready",
                              path: "artifact.txt",
                          },
                      }
                    : { kind: "text", text: "sent" },
            {
                prepare: async (home) => {
                    await writeFile(
                        join(home, "workspace/artifact.txt"),
                        fileContent
                    );
                },
            }
        );
        const response = await postInbound(scenario.running, {
            messageId: "file-1",
            text: "send me the artifact",
        });
        expect(response.status).toBe(202);
        const first = await outbound(scenario.running, 0);
        const textItem = first.items.find(
            (item) => item.text === "artifact ready"
        );
        expect(textItem).toBeDefined();
        const fileItem = first.items.find(
            (item) => item.files !== undefined && item.files.length > 0
        );
        expect(fileItem).toBeDefined();
        const file = fileItem?.files?.[0];
        expect(file).toMatchObject({
            name: "artifact.txt",
            bytes: Buffer.byteLength(fileContent),
            mime: "text/plain; charset=utf-8",
        });
        const attachmentId = file?.attachmentId ?? "";
        expect(attachmentId).not.toBe("");
        const bytes = await waitForAttachment(scenario.running, attachmentId);
        expect(await bytes.text()).toBe(fileContent);
        const requests = JSON.stringify(scenario.llm.requests);
        expect(requests).toContain("artifact ready");
        expect(requests).toContain('"is_error":false');
    });
});
