import type { Logger } from "@nokoribi/shared";
import {
    ApiClient,
    ApiError,
    TokenManager,
    gatewayPath,
    interactionPath,
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
import type { QqRestClient } from "./transport.js";

/** Options for the SDK-backed REST wrapper. */
export interface QqRestOptions {
    readonly config: QqBotConfig;
    readonly credentials: QqCredentials;
    readonly logger: Logger;
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
