import {
    NonRetryableDeliveryError,
    PassiveReplyExpiredError,
} from "@nokoribi/channel-core";
import { describe, expect, it } from "vitest";

import {
    classifySendError,
    safeErrorFields,
    toDeliveryError,
} from "../src/errors.js";

function apiError(httpStatus: number, bizCode?: number): unknown {
    return {
        name: "ApiError",
        httpStatus,
        ...(bizCode === undefined ? {} : { bizCode }),
    };
}

describe("qq send error classification", () => {
    it("maps passive-expiry codes", () => {
        for (const code of [304103, 40034005, 40034026, 40034128]) {
            expect(classifySendError(apiError(200, code))).toBe(
                "passive-expired"
            );
        }
    });

    it("maps active-unavailable codes", () => {
        for (const code of [
            40034101, 40034102, 40034105, 40054003, 40054013, 40054016,
        ]) {
            expect(classifySendError(apiError(200, code))).toBe(
                "active-unavailable"
            );
        }
    });

    it("maps duplicate and length codes", () => {
        expect(classifySendError(apiError(200, 40054005))).toBe("duplicate");
        expect(classifySendError(apiError(200, 40054007))).toBe("length");
        expect(classifySendError(apiError(200, 40054018))).toBe("length");
    });

    it("maps auth, retryable and permanent codes", () => {
        expect(classifySendError(apiError(401))).toBe("auth");
        expect(classifySendError(apiError(200, 11241))).toBe("auth");
        expect(classifySendError(apiError(200, 100001))).toBe("retry");
        expect(classifySendError(apiError(429))).toBe("retry");
        expect(classifySendError(apiError(503))).toBe("retry");
        expect(classifySendError(apiError(200, 40034006))).toBe("permanent");
        expect(classifySendError(apiError(200, 999999))).toBe("permanent");
    });

    it("maps markdown fallback codes", () => {
        expect(classifySendError(apiError(200, 40034127))).toBe(
            "markdown-unavailable"
        );
        expect(classifySendError(apiError(200, 304036))).toBe(
            "markdown-unavailable"
        );
    });

    it("treats network errors and token fetch failures as retryable", () => {
        expect(classifySendError({ name: "TypeError" })).toBe("retry");
        expect(classifySendError({ name: "AbortError" })).toBe("retry");
        expect(
            classifySendError(new Error("Token fetch failed: HTTP 500"))
        ).toBe("retry");
        expect(
            classifySendError(new Error("Token fetch failed: HTTP 401"))
        ).toBe("auth");
        expect(classifySendError(new Error("weird failure"))).toBe("permanent");
    });

    it("converts classified failures to core errors", () => {
        expect(toDeliveryError("passive-expired", {})).toBeInstanceOf(
            PassiveReplyExpiredError
        );
        const active = toDeliveryError("active-unavailable", {});
        expect(active).toBeInstanceOf(NonRetryableDeliveryError);
        expect((active as NonRetryableDeliveryError).reason).toBe(
            "active-unavailable"
        );
        const retry = toDeliveryError("retry", apiError(503));
        expect(retry).not.toBeInstanceOf(NonRetryableDeliveryError);
        expect(retry.message).toContain("httpStatus=503");
    });

    it("returns only safe fields for logs", () => {
        const fields = safeErrorFields({
            name: "ApiError",
            httpStatus: 400,
            bizCode: 40034006,
            message: "secret content",
        });
        expect(fields).toEqual({
            bizCode: 40034006,
            httpStatus: 400,
            errorName: "ApiError",
        });
    });
});
