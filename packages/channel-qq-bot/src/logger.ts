import type { Logger } from "@nokoribi/shared";
import type { Logger as SdkLogger } from "@tencent-connect/qqbot-nodejs/protocol";

/** Redact token-like values from SDK log messages before they reach ours. */
function sanitize(message: string): string {
    return message
        .replace(/(?:QQBot|Bearer)\s+\S+/gi, "[redacted]")
        .replace(
            /(?:access_token|client_secret|app_secret)[=:]\s*\S+/gi,
            "[redacted]"
        )
        .slice(0, 200);
}

/**
 * Adapt the SDK protocol logger to the shared structured logger.
 *
 * Only the SDK's message is forwarded (never its metadata), and the message is
 * redacted/truncated. Message bodies and credentials must never be logged.
 */
export function createSdkLogger(logger: Logger): SdkLogger {
    return {
        info: (message: string): void => {
            logger.debug("sdk", { event: sanitize(message) });
        },
        warn: (message: string): void => {
            logger.debug("sdk", { event: sanitize(message) });
        },
        debug: (message: string): void => {
            logger.debug("sdk", { event: sanitize(message) });
        },
        error: (message: string): void => {
            logger.warn("sdk error", { event: sanitize(message) });
        },
    };
}
