import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-attachment";
import z from "@deepseek-ai/schemastery";
import { createLogger } from "@nokoribi/shared";

import { resolveCredentials, type QqBotConfig } from "./config.js";
import { QqBotDriver } from "./driver.js";
import { QqGateway } from "./gateway.js";
import { QqRest } from "./rest.js";

export { resolveCredentials } from "./config.js";
export type {
    QqActiveMessageFallback,
    QqBotConfig,
    QqCredentials,
    QqMarkdown,
} from "./config.js";
export { mediaFileTypeFor, QqBotDriver, parseChatId } from "./driver.js";
export type { ParsedQqChat, QqBotDriverOptions } from "./driver.js";
export {
    classifySendError,
    describeSendError,
    isActiveUnavailableError,
    isAuthError,
    safeErrorFields,
    toDeliveryError,
} from "./errors.js";
export type { SendErrorKind } from "./errors.js";
export {
    buildReconnectDelays,
    QqGateway,
    QQ_GROUP_AND_C2C_AND_INTERACTION_INTENTS,
    QQ_GROUP_AND_C2C_INTENTS,
    QQ_INTERACTION_INTENT,
} from "./gateway.js";
export type { QqGatewayOptions } from "./gateway.js";
export { SendLimiter } from "./limiter.js";
export type { SendLimiterOptions } from "./limiter.js";
export {
    interactionAckCode,
    normalizeInbound,
    normalizeInteraction,
    normalizeText,
    parseInteractionButtonData,
    parseTimestamp,
} from "./normalize.js";
export type {
    InboundImageSource,
    InteractionButtonPayload,
    NormalizedInboundMessage,
} from "./normalize.js";
export { QqRest } from "./rest.js";
export type { QqRestOptions } from "./rest.js";
export type {
    QqGatewayClient,
    QqGatewayHandlers,
    QqRestClient,
} from "./transport.js";

/** Loader plugin label. */
export const name = "channel-qq-bot";

/** Channel core and the attachment store must exist before registration. */
export const inject: string[] = ["channels", "attachments"];

/** Runtime configuration schema (validated by the Loader). */
export const Config: unknown = z.object({
    enabled: z.boolean().default(false),
    appId: z.string().default(""),
    clientSecretEnv: z.string().default("NOKORIBI_QQ_BOT_CLIENT_SECRET"),
    markdown: z.union(["none", "basic", "full"]).default("basic"),
    maxTextLength: z.natural().min(1).default(4500),
    maxRepliesPerReply: z.natural().min(1).default(4),
    c2cReplyWindowSeconds: z.natural().min(1).default(3600),
    groupReplyWindowSeconds: z.natural().min(1).default(300),
    requestTimeoutMs: z.natural().min(1).default(10000),
    connectTimeoutMs: z.natural().min(1).default(30000),
    activeMessageFallback: z.union(["auto", "off"]).default("auto"),
    approvalButtons: z.boolean().default(true),
    questionButtons: z.boolean().default(true),
    inboundImages: z.boolean().default(true),
    inboundImageMaxBytes: z.natural().min(1).default(10485760),
    inboundImageTimeoutMs: z.natural().min(1).default(15000),
    reconnectBaseMs: z.natural().min(1).default(1000),
    reconnectMaxMs: z.natural().min(1).default(60000),
    activeMessageDisableMs: z.natural().min(1).default(3600000),
    replyWindowMarginMs: z.natural().default(30000),
    apiBaseUrl: z.string().default("https://api.bot.qq.com"),
    tokenBaseUrl: z.string().default("https://api.bot.qq.com"),
    gatewayUrl: z.string().default(""),
});

/** Mount the QQ official-bot driver. */
export async function apply(ctx: Context, config: QqBotConfig): Promise<void> {
    if (config.enabled === false) return;
    const credentials = resolveCredentials(config);
    const logger = createLogger("channel-qq-bot");
    const rest = new QqRest({ config, credentials, logger });
    const gateway = new QqGateway({ config, credentials, rest, logger });
    const driver = new QqBotDriver({
        config,
        rest,
        gateway,
        logger,
        readFile: (file) => ctx.attachments.readFileStream(file),
    });
    const disposeDriver = await ctx.channels.registerDriver(driver);
    ctx.effect(() => () => {
        rest.stop();
        disposeDriver();
        return gateway.stop();
    });
    logger.info("qq bot driver registered", { appId: credentials.appId });
}
