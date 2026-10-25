import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

import type {
    ChannelDriver,
    ChannelService,
    DeliveryMode,
    InboundMessage,
} from "@nokoribi/channel-core";
import {
    createLogger,
    ensureHomeDirs,
    resolveHomePaths,
    writeJsonAtomic,
    type Logger,
} from "@nokoribi/shared";

/** Resolved local test channel configuration. */
export interface LocalTestConfig {
    /** Whether the loopback HTTP surface should be mounted. */
    readonly enabled?: boolean;
    readonly host: string;
    readonly port: number;
    readonly token: string;
    readonly senderId: string;
    readonly chatId: string;
    readonly longPollTimeoutMs: number;
    readonly maxTextLength: number;
    readonly markdown: "none" | "basic" | "full";
    readonly maxBodyBytes: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

class HttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "HttpError";
        this.status = status;
    }
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}

function bearerMatches(header: string | undefined, token: string): boolean {
    if (header === undefined) return false;
    const expected = `Bearer ${token}`;
    return timingSafeEqual(digest(header), digest(expected));
}

function sendJson(
    response: ServerResponse,
    status: number,
    body: unknown
): void {
    const payload = `${JSON.stringify(body)}\n`;
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
    });
    response.end(payload);
}

async function readJson(
    request: IncomingMessage,
    maxBytes: number
): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) throw new HttpError(413, "request body too large");
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") throw new HttpError(400, "empty body");
    try {
        const value = JSON.parse(text) as unknown;
        if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value)
        ) {
            throw new HttpError(400, "body must be a JSON object");
        }
        return value as Record<string, unknown>;
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "invalid JSON body");
    }
}

/**
 * Loopback HTTP channel used for local acceptance.
 *
 * Inbound requests enter channel core's ingress pipeline. Outbound history is
 * read from channel core's durable outbox; this driver only acknowledges
 * delivery.
 */
export class LocalTestChannel implements ChannelDriver {
    readonly id = "local-test";
    readonly capabilities: ChannelDriver["capabilities"];
    private readonly config: LocalTestConfig;
    private readonly channels: ChannelService;
    private readonly logger: Logger;
    private readonly server: Server;
    private boundPort = 0;
    private stopped = false;

    constructor(config: LocalTestConfig, channels: ChannelService) {
        this.config = config;
        this.channels = channels;
        this.logger = createLogger("channel-local-test");
        this.capabilities = {
            markdown: config.markdown,
            maxTextLength: config.maxTextLength,
            inboundImages: false,
            outboundFiles: false,
        };
        this.server = createServer((request, response) => {
            void this.handle(request, response);
        });
    }

    /** Start listening on the configured loopback address. */
    async listen(): Promise<number> {
        if (!LOOPBACK_HOSTS.has(this.config.host)) {
            throw new Error(
                `test channel refuses non-loopback host ${this.config.host}`
            );
        }
        if (this.config.token.trim() === "") {
            throw new Error("test channel token must not be empty");
        }
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                this.server.off("listening", onListening);
                reject(error);
            };
            const onListening = (): void => {
                this.server.off("error", onError);
                resolve();
            };
            this.server.once("error", onError);
            this.server.once("listening", onListening);
            this.server.listen(this.config.port, this.config.host);
        });
        const address = this.server.address();
        this.boundPort =
            typeof address === "object" && address !== null
                ? address.port
                : this.config.port;
        return this.boundPort;
    }

    /** Write the runtime discovery file used by process tests. */
    async writeDiscoveryFile(): Promise<void> {
        const paths = resolveHomePaths();
        await ensureHomeDirs(paths);
        await writeJsonAtomic(paths.testChannelPath, {
            host: this.config.host,
            port: this.boundPort,
            pid: process.pid,
            startedAt: new Date().toISOString(),
        });
    }

    /** Resolve the actual bound port. */
    get port(): number {
        return this.boundPort;
    }

    async start(_handler: {
        onInbound(message: InboundMessage): void;
    }): Promise<void> {
        // Inbound requests go straight into channel core so this driver can map
        // pipeline errors to HTTP status codes.
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.logger.info("stopping test channel");
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve());
        });
        const paths = resolveHomePaths();
        await unlink(paths.testChannelPath).catch(() => undefined);
    }

    async send(
        chatId: string,
        content: { kind: "text"; text: string }
    ): Promise<{ channelId: string; chatId: string; messageId: string }> {
        if (content.text.length === 0) {
            throw new Error("refusing to send an empty message");
        }
        return {
            channelId: this.id,
            chatId,
            messageId: randomUUID(),
        };
    }

    private async handle(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        try {
            if (
                !bearerMatches(request.headers.authorization, this.config.token)
            ) {
                sendJson(response, 401, { error: "unauthorized" });
                return;
            }
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (request.method === "POST" && url.pathname === "/v1/inbound") {
                await this.handleInbound(request, response);
                return;
            }
            if (request.method === "GET" && url.pathname === "/v1/outbound") {
                await this.handleOutbound(url, response);
                return;
            }
            if (request.method === "GET" && url.pathname === "/v1/status") {
                if (url.searchParams.get("full") === "1") {
                    sendJson(response, 200, {
                        ...this.channels.status(),
                        details: await this.channels.fullStatus(),
                    });
                    return;
                }
                sendJson(response, 200, this.channels.status());
                return;
            }
            sendJson(response, 404, { error: "not found" });
        } catch (error) {
            if (error instanceof HttpError) {
                sendJson(response, error.status, { error: error.message });
                return;
            }
            this.logger.error("http handler failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            if (!response.headersSent) {
                sendJson(response, 500, { error: "internal error" });
            } else {
                response.destroy();
            }
        }
    }

    private async handleInbound(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        const body = await readJson(request, this.config.maxBodyBytes);
        const text = typeof body.text === "string" ? body.text : undefined;
        const rawImages = body.images;
        if (rawImages !== undefined) {
            if (!Array.isArray(rawImages)) {
                throw new HttpError(400, "images must be an array");
            }
            for (const image of rawImages) {
                if (
                    typeof image !== "object" ||
                    image === null ||
                    typeof (image as { mime?: unknown }).mime !== "string" ||
                    typeof (image as { dataBase64?: unknown }).dataBase64 !==
                        "string"
                ) {
                    throw new HttpError(400, "invalid image entry");
                }
            }
            sendJson(response, 501, {
                error: "inbound images are not supported until M2",
            });
            return;
        }
        if (text === undefined || text.trim() === "") {
            throw new HttpError(400, "text is required");
        }
        const messageId =
            typeof body.messageId === "string" && body.messageId.trim() !== ""
                ? body.messageId
                : randomUUID();
        const chatId =
            typeof body.chatId === "string" && body.chatId.trim() !== ""
                ? body.chatId
                : this.config.chatId;
        const delivery = body.delivery;
        if (
            delivery !== undefined &&
            delivery !== "steer" &&
            delivery !== "followup" &&
            delivery !== "interrupt"
        ) {
            throw new HttpError(400, "invalid delivery");
        }
        const result = await this.channels.ingress({
            channelId: this.id,
            chatId,
            senderId: this.config.senderId,
            messageId,
            text,
            receivedAt: Date.now(),
            ...(delivery === undefined
                ? {}
                : { delivery: delivery as DeliveryMode }),
        });
        if (result.reason === "empty") {
            throw new HttpError(400, "text is required");
        }
        sendJson(response, 202, { messageId });
    }

    private async handleOutbound(
        url: URL,
        response: ServerResponse
    ): Promise<void> {
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isInteger(after) || after < 0) {
            throw new HttpError(400, "after must be a non-negative integer");
        }
        const timeoutSeconds = Number(
            url.searchParams.get("timeout") ??
                Math.round(this.config.longPollTimeoutMs / 1000)
        );
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
            throw new HttpError(400, "timeout must be non-negative");
        }
        const timeoutMs = Math.min(60_000, timeoutSeconds * 1000);
        const items = await this.channels.waitForOutbound(after, timeoutMs);
        const lastSeq = items.at(-1)?.seq;
        sendJson(response, 200, {
            items: items.map((item) => ({
                seq: item.seq,
                kind: item.kind,
                chatId: item.chatId,
                text: item.text,
                ...(item.interactionId === null
                    ? {}
                    : { interactionId: item.interactionId }),
            })),
            // A concurrent enqueue can advance nextOutboxSeq after the
            // history read; report a cursor consistent with the returned
            // items so a client cannot skip an unseen sequence.
            nextSeq: lastSeq === undefined ? after : lastSeq + 1,
        });
    }
}
