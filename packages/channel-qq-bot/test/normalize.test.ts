import type { InboundMessage as SdkInboundMessage } from "@tencent-connect/qqbot-nodejs/protocol";
import { describe, expect, it } from "vitest";

import {
    normalizeInbound,
    normalizeText,
    parseTimestamp,
} from "../src/normalize.js";

function sdkMessage(
    overrides: Partial<SdkInboundMessage> = {}
): SdkInboundMessage {
    return {
        rawEventType: "C2C_MESSAGE_CREATE",
        kind: "c2c",
        senderId: "user-1",
        content: "hello",
        messageId: "msg-1",
        timestamp: "2026-10-27T12:00:00+08:00",
        raw: {} as SdkInboundMessage["raw"],
        ...overrides,
    };
}

describe("qq inbound normalization", () => {
    it("maps a C2C message into the namespaced chat", () => {
        const result = normalizeInbound(sdkMessage());
        expect(result).toEqual({
            channelId: "qq-bot",
            chatId: "c2c:user-1",
            senderId: "user-1",
            messageId: "msg-1",
            text: "hello",
            receivedAt: Date.parse("2026-10-27T12:00:00+08:00"),
        });
    });

    it("maps a group @ message and keeps the group namespace", () => {
        const result = normalizeInbound(
            sdkMessage({
                rawEventType: "GROUP_AT_MESSAGE_CREATE",
                kind: "group",
                senderId: "member-1",
                groupOpenid: "group-1",
                content: " hi ",
            })
        );
        expect(result).toMatchObject({
            chatId: "group:group-1",
            senderId: "member-1",
            text: "hi",
        });
    });

    it("ignores group full messages, bot messages and other events", () => {
        expect(
            normalizeInbound(
                sdkMessage({ rawEventType: "GROUP_MESSAGE_CREATE" })
            )
        ).toBeNull();
        expect(normalizeInbound(sdkMessage({ senderIsBot: true }))).toBeNull();
        expect(
            normalizeInbound(sdkMessage({ rawEventType: "AT_MESSAGE_CREATE" }))
        ).toBeNull();
        expect(normalizeInbound(sdkMessage({ kind: "guild" }))).toBeNull();
    });

    it("ignores empty text and missing identifiers", () => {
        expect(normalizeInbound(sdkMessage({ content: "  " }))).toBeNull();
        expect(normalizeInbound(sdkMessage({ messageId: " " }))).toBeNull();
        expect(
            normalizeInbound(
                sdkMessage({
                    kind: "group",
                    rawEventType: "GROUP_AT_MESSAGE_CREATE",
                    groupOpenid: "",
                })
            )
        ).toBeNull();
        expect(normalizeInbound(sdkMessage({ senderId: "" }))).toBeNull();
    });

    it("strips a leading bot mention and keeps the reply reference", () => {
        expect(normalizeText("<@!12345> hello")).toBe("hello");
        expect(normalizeText("@bot hello")).toBe("@bot hello");
        const result = normalizeInbound(
            sdkMessage({ content: "<@!1> hi", refMsgIdx: "idx-1" })
        );
        expect(result).toMatchObject({ text: "hi", replyTo: "idx-1" });
    });

    it("falls back to now for invalid timestamps", () => {
        const before = Date.now();
        const result = normalizeInbound(sdkMessage({ timestamp: "bad" }));
        expect(result?.receivedAt).toBeGreaterThanOrEqual(before);
        expect(result?.receivedAt).toBeLessThanOrEqual(Date.now());
        expect(parseTimestamp("2026-10-27T00:00:00Z")).toBe(
            Date.parse("2026-10-27T00:00:00Z")
        );
    });
});
