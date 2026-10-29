import { afterEach, describe, expect, it } from "vitest";

import {
    resolveActiveMessageDisableMs,
    resolveApiBaseUrl,
    resolveCredentials,
    resolveGatewayUrl,
    resolveReplyWindowMarginMs,
    resolveTokenBaseUrl,
    type QqBotConfig,
} from "../src/config.js";
import { Config } from "../src/index.js";

const config: QqBotConfig = {
    enabled: true,
    appId: "app-1",
    clientSecretEnv: "TEST_QQ_SECRET",
    markdown: "basic",
    maxTextLength: 4500,
    maxRepliesPerReply: 4,
    c2cReplyWindowSeconds: 3600,
    groupReplyWindowSeconds: 300,
    requestTimeoutMs: 1000,
    connectTimeoutMs: 1000,
    activeMessageFallback: "auto",
    approvalButtons: true,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1000,
};

afterEach(() => {
    delete process.env.TEST_QQ_SECRET;
});

describe("qq bot config", () => {
    it("applies documented defaults", () => {
        const parse = Config as (input: Record<string, unknown>) => QqBotConfig;
        const defaults = parse({});
        expect(defaults.enabled).toBe(false);
        expect(defaults.appId).toBe("");
        expect(defaults.markdown).toBe("basic");
        expect(defaults.maxTextLength).toBe(4500);
        expect(defaults.maxRepliesPerReply).toBe(4);
        expect(defaults.c2cReplyWindowSeconds).toBe(3600);
        expect(defaults.groupReplyWindowSeconds).toBe(300);
        expect(defaults.activeMessageFallback).toBe("auto");
        expect(defaults.approvalButtons).toBe(true);
        expect(defaults.gatewayUrl).toBe("");
    });

    it("reads the secret from the named environment variable", () => {
        process.env.TEST_QQ_SECRET = "secret-value";
        expect(resolveCredentials(config)).toEqual({
            appId: "app-1",
            clientSecret: "secret-value",
        });
    });

    it("fails loud when the app id or secret is missing", () => {
        expect(() => resolveCredentials({ ...config, appId: " " })).toThrow(
            /appId is required/
        );
        expect(() =>
            resolveCredentials({ ...config, clientSecretEnv: "" })
        ).toThrow(/clientSecretEnv/);
        expect(() => resolveCredentials(config)).toThrow(
            /TEST_QQ_SECRET is empty/
        );
    });

    it("resolves documented URLs and optional overrides", () => {
        expect(resolveApiBaseUrl(config)).toBe("https://api.bot.qq.com");
        expect(resolveTokenBaseUrl(config)).toBe("https://api.bot.qq.com");
        expect(resolveGatewayUrl(config)).toBeUndefined();
        expect(
            resolveApiBaseUrl({ ...config, apiBaseUrl: "http://127.0.0.1:1" })
        ).toBe("http://127.0.0.1:1");
        expect(
            resolveGatewayUrl({
                ...config,
                gatewayUrl: "ws://127.0.0.1:1/websocket",
            })
        ).toBe("ws://127.0.0.1:1/websocket");
    });

    it("uses bounded safety margins by default", () => {
        expect(resolveReplyWindowMarginMs(config)).toBe(30000);
        expect(resolveActiveMessageDisableMs(config)).toBe(3600000);
        expect(
            resolveReplyWindowMarginMs({ ...config, replyWindowMarginMs: 0 })
        ).toBe(0);
    });
});
