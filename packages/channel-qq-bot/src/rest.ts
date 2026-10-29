import type { Logger } from "@nokoribi/shared";
import {
    ApiClient,
    ApiError,
    TokenManager,
    gatewayPath,
    interactionPath,
    mediaUploadPath,
    messagePath,
    type ChatScope,
    type MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";

import {
    resolveApiBaseUrl,
    resolveGatewayUrl,
    resolveTokenBaseUrl,
    type QqBotConfig,
    type QqCredentials,
} from "./config.js";
import { classifySendError } from "./errors.js";
import { createSdkLogger } from "./logger.js";
import type {
    DownloadedImage,
    DownloadImageOptions,
    QqRestClient,
} from "./transport.js";

/** Options for the SDK-backed REST wrapper. */
export interface QqRestOptions {
    readonly config: QqBotConfig;
    readonly credentials: QqCredentials;
    readonly logger: Logger;
}

/** Read one response body as bytes, aborting once `maxBytes` is exceeded. */
async function readBoundedBody(
    response: Response,
    maxBytes: number
): Promise<Uint8Array> {
    const body = response.body;
    if (body === null) return new Uint8Array();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error("inbound image exceeds the byte limit");
        }
        chunks.push(value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
    }
    return data;
}

/**
 * Thin wrapper over the SDK protocol REST primitives.
 *
 * Only token caching, message sends and gateway-url resolution are used; the
 * SDK facade, middleware and business semantics stay out of the driver.
 */
export class QqRest implements QqRestClient {
    private readonly config: QqBotConfig;
    private readonly credentials: QqCredentials;
    private readonly logger: Logger;
    private readonly tokens: TokenManager;
    private readonly api: ApiClient;

    constructor(options: QqRestOptions) {
        this.config = options.config;
        this.credentials = options.credentials;
        this.logger = options.logger;
        const sdkLogger = createSdkLogger(options.logger);
        const api = new ApiClient({
            baseUrl: resolveApiBaseUrl(options.config),
            defaultTimeoutMs: options.config.requestTimeoutMs,
            logger: sdkLogger,
        });
        this.api = api;
        this.tokens = new TokenManager({
            baseUrl: resolveTokenBaseUrl(options.config),
            logger: sdkLogger,
        });
    }

    async send(
        scope: ChatScope,
        targetId: string,
        body: Record<string, unknown>
    ): Promise<MessageResponse> {
        try {
            return await this.requestSend(scope, targetId, body);
        } catch (error) {
            if (classifySendError(error) !== "auth") throw error;
            this.tokens.clearCache(this.credentials.appId);
            this.logger.warn("refreshing qq bot token after auth failure");
            return await this.requestSend(scope, targetId, body);
        }
    }

    async ackInteraction(interactionId: string, code: 0 | 1): Promise<void> {
        const token = await this.getAccessToken();
        await this.api.request(token, "PUT", interactionPath(interactionId), {
            code,
        });
    }

    /**
     * Download one inbound image URL with a hard timeout and byte cap.
     *
     * The URL is platform-generated and carries its own `rkey`; only the
     * protocol is validated here because tests point it at a loopback fake.
     */
    async downloadImage(
        url: string,
        options: DownloadImageOptions
    ): Promise<DownloadedImage> {
        if (!/^https?:\/\//i.test(url)) {
            throw new Error("inbound image url must be http(s)");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs);
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                redirect: "follow",
            });
            if (!response.ok) {
                throw new Error(
                    `inbound image download failed: HTTP ${String(response.status)}`
                );
            }
            const declared = Number(
                response.headers.get("content-length") ?? ""
            );
            if (Number.isFinite(declared) && declared > options.maxBytes) {
                throw new Error("inbound image exceeds the byte limit");
            }
            const data = await readBoundedBody(response, options.maxBytes);
            const contentType = response.headers.get("content-type");
            return {
                data,
                ...(contentType === null || contentType === ""
                    ? {}
                    : { mime: contentType.split(";")[0]?.trim() }),
            };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Upload one file through the rich-media API and return its `file_info`.
     * The caller sends the follow-up `msg_type=7` message.
     */
    async uploadMedia(
        scope: ChatScope,
        targetId: string,
        body: Record<string, unknown>
    ): Promise<{ readonly file_info: string }> {
        const token = await this.getAccessToken();
        const path = mediaUploadPath(scope, targetId);
        const response = await this.api.request<{
            file_info?: string;
            code?: number;
            err_code?: number;
            message?: string;
        }>(token, "POST", path, body, {
            uploadRequest: true,
            redactBodyKeys: ["file_data"],
        });
        const code = response.code ?? response.err_code;
        if (typeof code === "number" && code !== 0) {
            throw new ApiError(
                `API Error [${path}]: ${response.message ?? String(code)}`,
                200,
                path,
                code,
                response.message
            );
        }
        if (
            typeof response.file_info !== "string" ||
            response.file_info === ""
        ) {
            throw new ApiError(
                `API Error [${path}]: missing file_info`,
                200,
                path
            );
        }
        return { file_info: response.file_info };
    }

    async getGatewayUrl(): Promise<string> {
        const fixed = resolveGatewayUrl(this.config);
        if (fixed !== undefined) return fixed;
        const token = await this.getAccessToken();
        const data = await this.api.request<{ url: string }>(
            token,
            "GET",
            gatewayPath()
        );
        return data.url;
    }

    async getAccessToken(): Promise<string> {
        return await this.tokens.getAccessToken(
            this.credentials.appId,
            this.credentials.clientSecret
        );
    }

    clearTokenCache(): void {
        this.tokens.clearCache(this.credentials.appId);
    }

    stop(): void {
        this.tokens.stopBackgroundRefresh(this.credentials.appId);
    }

    private async requestSend(
        scope: ChatScope,
        targetId: string,
        body: Record<string, unknown>
    ): Promise<MessageResponse> {
        const token = await this.getAccessToken();
        const path = messagePath(scope, targetId);
        const response = await this.api.request<
            MessageResponse & {
                code?: number;
                err_code?: number;
                message?: string;
            }
        >(token, "POST", path, body);
        // QQ reports business failures as HTTP 200 with a nonzero body code;
        // the SDK ApiClient only throws on non-2xx responses.
        const code = response.code ?? response.err_code;
        if (typeof code === "number" && code !== 0) {
            throw new ApiError(
                `API Error [${path}]: ${response.message ?? String(code)}`,
                200,
                path,
                code,
                response.message
            );
        }
        return response;
    }
}
