/** Markdown rendering capability configured for the QQ driver. */
export type QqMarkdown = "none" | "basic" | "full";

/** Whether active (unsolicited) messages may be attempted. */
export type QqActiveMessageFallback = "auto" | "off";

/** Resolved QQ Bot driver configuration. */
export interface QqBotConfig {
    readonly enabled?: boolean;
    readonly appId: string;
    readonly clientSecretEnv: string;
    readonly markdown: QqMarkdown;
    readonly maxTextLength: number;
    readonly maxRepliesPerReply: number;
    readonly c2cReplyWindowSeconds: number;
    readonly groupReplyWindowSeconds: number;
    readonly requestTimeoutMs: number;
    readonly connectTimeoutMs: number;
    readonly activeMessageFallback: QqActiveMessageFallback;
    /** Render and accept C2C approval button callbacks. */
    readonly approvalButtons: boolean;
    /** Render and accept C2C question button callbacks (default true). */
    readonly questionButtons?: boolean;
    /** Download and forward inbound images (default true). */
    readonly inboundImages?: boolean;
    /** Maximum bytes for one downloaded inbound image (default 10 MiB). */
    readonly inboundImageMaxBytes?: number;
    /** Timeout for one inbound image download (default 15000 ms). */
    readonly inboundImageTimeoutMs?: number;
    readonly reconnectBaseMs: number;
    readonly reconnectMaxMs: number;
    /** How long an unavailable active-message state is remembered. */
    readonly activeMessageDisableMs?: number;
    /** Safety margin subtracted from the platform passive windows. */
    readonly replyWindowMarginMs?: number;
    /** REST API base URL; defaults to the documented api.bot.qq.com. */
    readonly apiBaseUrl?: string;
    /** Token endpoint base URL; defaults to the documented api.bot.qq.com. */
    readonly tokenBaseUrl?: string;
    /** Optional fixed gateway URL; empty means resolve through GET /gateway. */
    readonly gatewayUrl?: string;
}

/** Resolved credentials passed to the SDK protocol layer. */
export interface QqCredentials {
    readonly appId: string;
    readonly clientSecret: string;
}

/** Resolve the API base URL, defaulting to the documented host. */
export function resolveApiBaseUrl(config: QqBotConfig): string {
    const value = config.apiBaseUrl?.trim();
    return value === undefined || value === ""
        ? "https://api.bot.qq.com"
        : value;
}

/** Resolve the token endpoint base URL, defaulting to the documented host. */
export function resolveTokenBaseUrl(config: QqBotConfig): string {
    const value = config.tokenBaseUrl?.trim();
    return value === undefined || value === ""
        ? "https://api.bot.qq.com"
        : value;
}

/** Resolve the optional fixed gateway URL. */
export function resolveGatewayUrl(config: QqBotConfig): string | undefined {
    const value = config.gatewayUrl?.trim();
    return value === undefined || value === "" ? undefined : value;
}

/** Whether inbound image download/forward is enabled. */
export function resolveInboundImages(config: QqBotConfig): boolean {
    return config.inboundImages ?? true;
}

/** Effective maximum bytes for one inbound image. */
export function resolveInboundImageMaxBytes(config: QqBotConfig): number {
    return config.inboundImageMaxBytes ?? 10 * 1024 * 1024;
}

/** Effective inbound image download timeout. */
export function resolveInboundImageTimeoutMs(config: QqBotConfig): number {
    return config.inboundImageTimeoutMs ?? 15000;
}

/** Whether question buttons are enabled. */
export function resolveQuestionButtons(config: QqBotConfig): boolean {
    return config.questionButtons ?? true;
}

/** Whether any interactive button surface (approval or question) is enabled. */
export function resolveInteractionButtons(config: QqBotConfig): boolean {
    return config.approvalButtons || resolveQuestionButtons(config);
}

/** Effective passive-window safety margin. */
export function resolveReplyWindowMarginMs(config: QqBotConfig): number {
    return config.replyWindowMarginMs ?? 30_000;
}

/** Effective duration of an active-message unavailable mark. */
export function resolveActiveMessageDisableMs(config: QqBotConfig): number {
    return config.activeMessageDisableMs ?? 60 * 60 * 1000;
}

/**
 * Read the client secret from the environment variable named in the config.
 *
 * The secret is never logged and never written to the Nix store. Missing or
 * empty credentials fail loudly so a misconfigured daemon does not start with
 * a silently broken channel.
 */
export function resolveCredentials(
    config: QqBotConfig,
    env: Record<string, string | undefined> = process.env
): QqCredentials {
    const appId = config.appId.trim();
    if (appId === "") {
        throw new Error("channel-qq-bot: appId is required when enabled");
    }
    const envName = config.clientSecretEnv.trim();
    if (envName === "") {
        throw new Error(
            "channel-qq-bot: clientSecretEnv must name the environment variable holding the client secret"
        );
    }
    const clientSecret = env[envName]?.trim() ?? "";
    if (clientSecret === "") {
        throw new Error(
            `channel-qq-bot: client secret environment variable ${envName} is empty`
        );
    }
    return { appId, clientSecret };
}
