import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const LAUNCHER = resolve(REPO_ROOT, "packages/launcher/dist/index.js");
export const SOUL = resolve(REPO_ROOT, "SOUL.md");
export const TEMPLATES = resolve(REPO_ROOT, "templates");

export interface DaemonOptions {
    readonly home: string;
    readonly token: string;
    readonly mockBaseUrl: string;
    readonly model?: string;
    readonly extraEnv?: Record<string, string>;
}

export interface DaemonHandle {
    readonly child: ChildProcess;
    readonly home: string;
    readonly token: string;
    readonly port: number;
    readonly output: () => string;
    stop(): Promise<number | null>;
    signal(signal: NodeJS.Signals): void;
    exited: Promise<number | null>;
}

export interface OutboundItem {
    seq: number;
    kind: string;
    chatId: string;
    text: string;
    interactionId?: string;
}

export interface StatusDetails {
    workspace: string;
    state: string;
    lock: string;
    storage: string;
    dshVersion: string;
    appVersion: string;
    model: { provider: string; model: string };
    reviewer: unknown;
    goals: unknown[];
    schedules: unknown[];
    sandboxes: unknown[];
    memory: {
        activeEntries: number;
        archivedEntries: number;
        invalidEntries: number;
        bytes: number;
    };
    recentErrors: unknown[];
}

export interface FullStatus extends Status {
    details: StatusDetails;
}

export interface Status {
    version: string;
    uptimeSec: number;
    mainSessionId: string | null;
    agentStatus: string;
    goals: unknown[];
    pendingInteractions: number;
    outboxLength: number;
    lastRestartReason: string | null;
    ready: boolean;
    channels?: readonly unknown[];
    deferredNotices?: number;
}

export async function tempHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "nokoribi-process-"));
}

export async function startDaemon(
    options: DaemonOptions
): Promise<DaemonHandle> {
    const logs: string[] = [];
    const child = spawn(process.execPath, [LAUNCHER], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            DSH_HOME: options.home,
            NOKORIBI_TEST_TOKEN: options.token,
            NOKORIBI_TEST_PORT: "0",
            NOKORIBI_VERSION: "0.1.0",
            NOKORIBI_MODEL: options.model ?? "deepseek-flash",
            NOKORIBI_SOUL_FILE: SOUL,
            NOKORIBI_TEMPLATES_DIR: TEMPLATES,
            NOKORIBI_SHUTDOWN_GRACE_MS: "3000",
            DEEPSEEK_BASE_URL: `${options.mockBaseUrl}/v1`,
            DEEPSEEK_API_KEY: "mock-key",
            ...options.extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    const exited = new Promise<number | null>((resolveExit) => {
        child.once("exit", (code) => resolveExit(code));
    });
    const output = (): string => logs.join("");
    const ready = await waitForReady(options.home, child, exited, output);
    return {
        child,
        home: options.home,
        token: options.token,
        port: ready.port,
        output,
        exited,
        async stop(): Promise<number | null> {
            if (child.exitCode !== null) return child.exitCode;
            child.kill("SIGTERM");
            return await exited;
        },
        signal(signal: NodeJS.Signals): void {
            child.kill(signal);
        },
    };
}

async function waitForReady(
    home: string,
    child: ChildProcess,
    exited: Promise<number | null>,
    output: () => string
): Promise<{ port: number }> {
    const readyPath = join(home, "run/ready.json");
    const errorPath = join(home, "run/startup-error.json");
    const discoveryPath = join(home, "run/test-channel.json");
    const deadline = Date.now() + 30_000;
    let exitedCode: number | null | undefined;
    void exited.then((code) => {
        exitedCode = code;
    });
    for (;;) {
        if (exitedCode !== undefined) {
            throw new Error(
                `daemon exited before ready (code ${String(exitedCode)}):\n${output()}`
            );
        }
        try {
            const raw = await readFile(errorPath, "utf8");
            const error = JSON.parse(raw) as { message?: string };
            throw new Error(
                `daemon startup failed: ${error.message ?? "unknown"}`
            );
        } catch (error) {
            if (
                error instanceof Error &&
                error.message.startsWith("daemon startup failed")
            ) {
                throw error;
            }
        }
        try {
            const ready = JSON.parse(await readFile(readyPath, "utf8")) as {
                pid?: number;
            };
            const discovery = JSON.parse(
                await readFile(discoveryPath, "utf8")
            ) as { pid?: number; port?: number };
            if (
                ready.pid === child.pid &&
                discovery.pid === child.pid &&
                typeof discovery.port === "number"
            ) {
                return { port: discovery.port };
            }
        } catch {
            // still starting
        }
        if (Date.now() > deadline) {
            throw new Error(
                `daemon did not become ready within 30s:\n${output()}`
            );
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
}

export async function postInbound(
    daemon: DaemonHandle,
    text: string,
    messageId: string,
    extra: Record<string, unknown> = {}
): Promise<Response> {
    return await fetch(`http://127.0.0.1:${daemon.port}/v1/inbound`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${daemon.token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ text, messageId, ...extra }),
    });
}

export async function outbound(
    daemon: DaemonHandle,
    after: number,
    timeoutSeconds = 1
): Promise<{ items: OutboundItem[]; nextSeq: number }> {
    const response = await fetch(
        `http://127.0.0.1:${daemon.port}/v1/outbound?after=${after}&timeout=${timeoutSeconds}`,
        { headers: { authorization: `Bearer ${daemon.token}` } }
    );
    if (!response.ok) {
        throw new Error(`outbound failed: ${response.status}`);
    }
    return (await response.json()) as {
        items: OutboundItem[];
        nextSeq: number;
    };
}

export async function waitForOutbound(
    daemon: DaemonHandle,
    after: number,
    timeoutSeconds = 10
): Promise<{ items: OutboundItem[]; nextSeq: number }> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
        const remaining = Math.max(0.5, (deadline - Date.now()) / 1000);
        const result = await outbound(daemon, after, Math.min(5, remaining));
        if (result.items.length > 0) return result;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for outbound after seq ${after}`
            );
        }
    }
}

export async function status(daemon: DaemonHandle): Promise<Status> {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/status`, {
        headers: { authorization: `Bearer ${daemon.token}` },
    });
    return (await response.json()) as Status;
}

export async function statusFull(daemon: DaemonHandle): Promise<FullStatus> {
    const response = await fetch(
        `http://127.0.0.1:${daemon.port}/v1/status?full=1`,
        { headers: { authorization: `Bearer ${daemon.token}` } }
    );
    return (await response.json()) as FullStatus;
}

export async function readState(
    home: string
): Promise<Record<string, unknown>> {
    return JSON.parse(
        await readFile(join(home, "state/agent-state.json"), "utf8")
    ) as Record<string, unknown>;
}

export async function appendPendingOutbox(
    home: string,
    text: string
): Promise<void> {
    const { readFile: read } = await import("node:fs/promises");
    const path = join(home, "state/outbox.json");
    const document = JSON.parse(await read(path, "utf8")) as {
        version: 1;
        nextSeq: number;
        items: unknown[];
    };
    const item = {
        seq: document.nextSeq,
        channelId: "local-test",
        chatId: "local",
        kind: "reply",
        text,
        interactionId: null,
        state: "pending",
        attempts: 0,
        nextAttemptAt: null,
        createdAt: new Date().toISOString(),
        sentAt: null,
    };
    document.items.push(item);
    document.nextSeq += 1;
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

export async function appendPendingInteraction(
    home: string,
    text: string,
    interactionId: string
): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "state"), { recursive: true });
    const path = join(home, "state/outbox.json");
    let document: {
        version: 1;
        nextSeq: number;
        items: unknown[];
    };
    try {
        document = JSON.parse(await readFile(path, "utf8")) as typeof document;
    } catch {
        document = { version: 1, nextSeq: 1, items: [] };
    }
    document.items.push({
        seq: document.nextSeq,
        channelId: "local-test",
        chatId: "local",
        kind: "interaction",
        text,
        interactionId,
        state: "pending",
        attempts: 0,
        nextAttemptAt: null,
        createdAt: new Date().toISOString(),
        sentAt: null,
    });
    document.nextSeq += 1;
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

export async function cleanupHome(home: string): Promise<void> {
    await rm(home, { recursive: true, force: true });
}
