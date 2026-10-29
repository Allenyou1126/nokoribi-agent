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
    ChannelHealth,
    ChannelService,
    DeliveryMode,
    FileAttachmentRef,
    InboundAction,
    InboundMessage,
    OutboundContent,
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
    /** Maximum decoded bytes for one inbound test image (default 10 MiB). */
    readonly inboundImageMaxBytes?: number;
}

/** Durable reader used by the loopback attachment endpoint. */
export interface LocalTestAttachments {
    readFileStream(
        ref: FileAttachmentRef,
        signal?: AbortSignal
    ): AsyncIterable<Uint8Array>;
}

const DEFAULT_INBOUND_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const SUPPORTED_IMAGE_MIME: ReadonlySet<string> = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
]);

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Normalize one declared test image mime onto the attachment vocabulary. */
function normalizeImageMime(mime: string): string | undefined {
    const base = mime.trim().toLowerCase();
    if (base === "image/jpg") return "image/jpeg";
    return SUPPORTED_IMAGE_MIME.has(base) ? base : undefined;
}

/** Validate one inbound test image and decode its base64 bytes. */
function parseInboundImage(
    value: unknown,
    maxBytes: number
): { readonly mime: string; readonly data: Uint8Array } {
    if (typeof value !== "object" || value === null) {
        throw new HttpError(400, "invalid image entry");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.mime !== "string") {
        throw new HttpError(400, "image.mime is required");
    }
    const mime = normalizeImageMime(record.mime);
    if (mime === undefined) {
        throw new HttpError(400, "image.mime is not a supported image type");
    }
    if (typeof record.data !== "string" || record.data.trim() === "") {
        throw new HttpError(400, "image.data must be a base64 string");
    }
    const compact = record.data.replace(/\s+/g, "");
    if (!BASE64.test(compact) || compact.length % 4 !== 0) {
        throw new HttpError(400, "image.data is not valid base64");
    }
    const buffer = Buffer.from(compact, "base64");
    if (buffer.length === 0) {
        throw new HttpError(400, "image.data decodes to zero bytes");
    }
    if (buffer.toString("base64") !== compact) {
        throw new HttpError(400, "image.data is not canonical base64");
    }
    if (buffer.length > maxBytes) {
        throw new HttpError(400, "image.data exceeds the byte limit");
    }
    return { mime, data: new Uint8Array(buffer) };
}

/** Validate one optional inbound image array. */
function parseInboundImages(
    value: unknown,
    maxBytes: number
): readonly { readonly mime: string; readonly data: Uint8Array }[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new HttpError(400, "images must be an array");
    }
    return value.map((entry) => parseInboundImage(entry, maxBytes));
}

/** Best-effort content type for one already-stored outbound file. */
function mimeForFileName(name: string): string {
    const ext = name.includes(".")
        ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
        : "";
    switch (ext) {
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "webp":
            return "image/webp";
        case "gif":
            return "image/gif";
        case "txt":
        case "md":
            return "text/plain; charset=utf-8";
        case "json":
            return "application/json";
        case "pdf":
            return "application/pdf";
        default:
            return "application/octet-stream";
    }
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

function parseInboundAction(value: unknown): InboundAction | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(400, "action must be a JSON object");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim() === "") {
        throw new HttpError(400, "action.id is required");
    }
    if (record.payload !== undefined && typeof record.payload !== "string") {
        throw new HttpError(400, "action.payload must be a string");
    }
    if (
        record.messageId !== undefined &&
        (typeof record.messageId !== "string" || record.messageId.trim() === "")
    ) {
        throw new HttpError(400, "action.messageId must be a non-empty string");
    }
    return {
        id: record.id,
        ...(record.payload === undefined ? {} : { payload: record.payload }),
        ...(record.messageId === undefined
            ? {}
            : { messageId: record.messageId }),
    };
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
    readonly defaultChatId: string;
    private readonly config: LocalTestConfig;
    private readonly channels: ChannelService;
    private readonly logger: Logger;
    private readonly attachments: LocalTestAttachments | undefined;
    private readonly fileRefs = new Map<string, FileAttachmentRef>();
    private readonly server: Server;
    private boundPort = 0;
    private stopped = false;

    constructor(
        config: LocalTestConfig,
        channels: ChannelService,
        attachments?: LocalTestAttachments
    ) {
        this.config = config;
        this.channels = channels;
        this.attachments = attachments;
        this.defaultChatId = config.chatId;
        this.logger = createLogger("channel-local-test");
        this.capabilities = {
            markdown: config.markdown,
            maxTextLength: config.maxTextLength,
            inboundImages: true,
            outboundFiles: true,
            // The loopback test channel accepts action-only injections so
            // process tests can replay button callbacks; production drivers
            // still require a text fallback.
            outboundActions: true,
            inboundActions: true,
            activeMessages: true,
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
        content: OutboundContent
    ): Promise<{ channelId: string; chatId: string; messageId: string }> {
        const files = content.files ?? [];
        if (content.text.length === 0 && files.length === 0) {
            throw new Error("refusing to send an empty message");
        }
        for (const file of files) {
            this.fileRefs.set(file.attachmentId, file);
        }
        return {
            channelId: this.id,
            chatId,
            messageId: randomUUID(),
        };
    }

    /** Report the loopback listener state for `/status`. */
    health(): ChannelHealth {
        return { state: this.stopped ? "offline" : "online" };
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
            if (
                request.method === "GET" &&
                url.pathname.startsWith("/v1/attachments/")
            ) {
                await this.handleAttachment(url.pathname, response);
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
        const action = parseInboundAction(body.action);
        const images = parseInboundImages(
            body.images,
            this.config.inboundImageMaxBytes ?? DEFAULT_INBOUND_IMAGE_MAX_BYTES
        );
        if (
            action === undefined &&
            images.length === 0 &&
            (text === undefined || text.trim() === "")
        ) {
            throw new HttpError(400, "text or images are required");
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
            ...(text === undefined || text.trim() === "" ? {} : { text }),
            ...(images.length === 0 ? {} : { images }),
            receivedAt: Date.now(),
            ...(action === undefined ? {} : { action }),
            ...(delivery === undefined
                ? {}
                : { delivery: delivery as DeliveryMode }),
        });
        if (result.reason === "empty") {
            throw new HttpError(400, "text or images are required");
        }
        if (result.reason === "unsupported-images") {
            throw new HttpError(400, "inbound images are not supported");
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
                ...(item.actions === null || item.actions === undefined
                    ? {}
                    : { actions: item.actions }),
                ...(item.files === null || item.files === undefined
                    ? {}
                    : { files: item.files.map(describeFile) }),
            })),
            // A concurrent enqueue can advance nextOutboxSeq after the
            // history read; report a cursor consistent with the returned
            // items so a client cannot skip an unseen sequence.
            nextSeq: lastSeq === undefined ? after : lastSeq + 1,
        });
    }

    /** Stream one stored outbound file by its durable attachment id. */
    private async handleAttachment(
        pathname: string,
        response: ServerResponse
    ): Promise<void> {
        const attachmentId = decodeURIComponent(
            pathname.slice("/v1/attachments/".length)
        ).trim();
        if (attachmentId === "") {
            throw new HttpError(400, "attachment id is required");
        }
        const ref = this.fileRefs.get(attachmentId);
        if (ref === undefined) {
            throw new HttpError(404, "attachment not found");
        }
        const attachments = this.attachments;
        if (attachments === undefined) {
            throw new HttpError(501, "attachment reader is not configured");
        }
        response.writeHead(200, {
            "content-type": mimeForFileName(ref.name),
            "content-length": ref.bytes,
            "cache-control": "no-store",
        });
        try {
            for await (const chunk of attachments.readFileStream(ref)) {
                response.write(chunk);
            }
            response.end();
        } catch (error) {
            this.logger.error("failed to stream attachment", {
                attachmentId,
                error: error instanceof Error ? error.message : String(error),
            });
            response.destroy();
        }
    }
}

/** Public file metadata for one outbound item. */
function describeFile(ref: FileAttachmentRef): {
    readonly attachmentId: string;
    readonly name: string;
    readonly bytes: number;
    readonly mime: string;
} {
    return {
        attachmentId: ref.attachmentId,
        name: ref.name,
        bytes: ref.bytes,
        mime: mimeForFileName(ref.name),
    };
}
