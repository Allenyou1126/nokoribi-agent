import {
    NonRetryableDeliveryError,
    PassiveReplyExpiredError,
} from "@nokoribi/channel-core";

/** Coarse classification used by the QQ driver's send policy. */
export type SendErrorKind =
    | "retry"
    | "auth"
    | "passive-expired"
    | "active-unavailable"
    | "duplicate"
    | "length"
    | "markdown-unavailable"
    | "permanent";

/** Reads the numeric error fields exposed by the SDK's `ApiError`. */
interface ErrorFields {
    readonly httpStatus?: number;
    readonly bizCode?: number;
    readonly name?: string;
}

const AUTH_CODES: ReadonlySet<number> = new Set([
    100007, 100016, 10004, 11241, 11243, 11265,
]);

const PASSIVE_EXPIRED_CODES: ReadonlySet<number> = new Set([
    304103, 40034005, 40034026, 40034128,
]);

const ACTIVE_UNAVAILABLE_CODES: ReadonlySet<number> = new Set([
    40034101, 40034102, 40034105, 40054003, 40054013, 40054016,
]);

const RETRYABLE_CODES: ReadonlySet<number> = new Set([
    100001, 40034004, 40054006, 50055001, 50055002,
]);

const LENGTH_CODES: ReadonlySet<number> = new Set([40054007, 40054018]);

const MARKDOWN_UNAVAILABLE_CODES: ReadonlySet<number> = new Set([
    304036, 40034127,
]);

const PERMANENT_CODES: ReadonlySet<number> = new Set([
    22006, 50059, 304061, 304080, 40034006, 40034008, 40034009, 40034010,
    40034011, 40034024, 40034025, 40034027, 40034106, 40034108, 40034109,
    40034122, 40034123, 40034124, 40054002, 40054004, 40054010,
]);

function readFields(error: unknown): ErrorFields {
    if (typeof error !== "object" || error === null) return {};
    const value = error as Record<string, unknown>;
    return {
        httpStatus:
            typeof value.httpStatus === "number" ? value.httpStatus : undefined,
        bizCode: typeof value.bizCode === "number" ? value.bizCode : undefined,
        name: typeof value.name === "string" ? value.name : undefined,
    };
}

/** Classify one SDK/HTTP/network failure into the driver's retry policy. */
export function classifySendError(error: unknown): SendErrorKind {
    const fields = readFields(error);
    const code = fields.bizCode;
    const status = fields.httpStatus;

    if (code !== undefined) {
        if (AUTH_CODES.has(code)) return "auth";
        if (PASSIVE_EXPIRED_CODES.has(code)) return "passive-expired";
        if (code === 40054005) return "duplicate";
        if (ACTIVE_UNAVAILABLE_CODES.has(code)) return "active-unavailable";
        if (LENGTH_CODES.has(code)) return "length";
        if (MARKDOWN_UNAVAILABLE_CODES.has(code)) return "markdown-unavailable";
        if (RETRYABLE_CODES.has(code)) return "retry";
        if (status !== undefined && (status === 429 || status >= 500)) {
            return "retry";
        }
        if (PERMANENT_CODES.has(code)) return "permanent";
        return "permanent";
    }

    if (status !== undefined) {
        if (status === 401 || status === 403) return "auth";
        if (status === 429 || status >= 500) return "retry";
    }

    const message = error instanceof Error ? error.message : "";
    if (/HTTP\s+40[13]\b/.test(message)) return "auth";
    if (/access_token|Token fetch|Network error/i.test(message)) {
        return "retry";
    }

    const name = fields.name;
    if (
        name === "AbortError" ||
        name === "TimeoutError" ||
        name === "TypeError" ||
        name === "FetchError"
    ) {
        return "retry";
    }
    return "permanent";
}

/** Whether the error should trigger one token refresh and retry. */
export function isAuthError(error: unknown): boolean {
    return classifySendError(error) === "auth";
}

/** Whether the error means the platform rejected active messages. */
export function isActiveUnavailableError(error: unknown): boolean {
    return classifySendError(error) === "active-unavailable";
}

/** Safe structured fields for logs; never includes the message正文 or token. */
export function safeErrorFields(error: unknown): {
    readonly bizCode?: number;
    readonly httpStatus?: number;
    readonly errorName?: string;
} {
    const fields = readFields(error);
    return {
        ...(fields.bizCode === undefined ? {} : { bizCode: fields.bizCode }),
        ...(fields.httpStatus === undefined
            ? {}
            : { httpStatus: fields.httpStatus }),
        ...(fields.name === undefined ? {} : { errorName: fields.name }),
    };
}

/** Render a short, non-sensitive error description for retryable failures. */
export function describeSendError(error: unknown): string {
    const fields = readFields(error);
    const parts: string[] = [];
    if (fields.bizCode !== undefined) parts.push(`bizCode=${fields.bizCode}`);
    if (fields.httpStatus !== undefined) {
        parts.push(`httpStatus=${fields.httpStatus}`);
    }
    if (fields.name !== undefined) parts.push(`error=${fields.name}`);
    return parts.length === 0 ? "unknown error" : parts.join(", ");
}

/** Convert one classified failure into the error core expects to see. */
export function toDeliveryError(kind: SendErrorKind, error: unknown): Error {
    switch (kind) {
        case "passive-expired":
            return new PassiveReplyExpiredError();
        case "active-unavailable":
            return new NonRetryableDeliveryError(
                "active-unavailable",
                "QQ active messages are unavailable"
            );
        case "auth":
            return new NonRetryableDeliveryError(
                "auth-failed",
                `QQ bot authentication failed (${describeSendError(error)})`
            );
        case "duplicate":
            return new Error("qq-bot duplicate delivery");
        case "length":
            return new NonRetryableDeliveryError(
                "content-too-long",
                "QQ rejected the message as too long"
            );
        case "markdown-unavailable":
            return new NonRetryableDeliveryError(
                "markdown-unavailable",
                "QQ markdown rendering is unavailable"
            );
        case "permanent":
            return new NonRetryableDeliveryError(
                "permanent",
                `QQ bot rejected the message (${describeSendError(error)})`
            );
        case "retry":
            return new Error(
                `qq-bot delivery failed (${describeSendError(error)})`
            );
    }
}
