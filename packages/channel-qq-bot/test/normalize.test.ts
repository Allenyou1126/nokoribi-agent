import type {
    InboundMessage as SdkInboundMessage,
    InteractionEvent,
} from "@tencent-connect/qqbot-nodejs/protocol";
import { describe, expect, it } from "vitest";

import {
    interactionAckCode,
    normalizeInbound,
    normalizeInteraction,
    normalizeText,
    parseInteractionButtonData,
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

function interactionEvent(
    overrides: Partial<InteractionEvent> = {}
): InteractionEvent {
    return {
        id: "interaction-1",
        type: 11,
        scene: "c2c",
        chat_type: 2,
        timestamp: "2026-10-27T12:00:00+08:00",
        user_openid: "u1",
        version: 1,
        data: {
            type: 11,
            resolved: {
                button_data: JSON.stringify({
                    k: "token-1",
                    t: "允许一次",
                }),
                button_id: "token-1",
                message_id: "bot-message-1",
            },
        },
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

describe("qq interaction normalization", () => {
    it("maps a C2C message-button callback", () => {
        const event = interactionEvent();
        expect(interactionAckCode(event)).toBe(0);
        expect(normalizeInteraction(event)).toEqual({
            channelId: "qq-bot",
            chatId: "c2c:u1",
            senderId: "u1",
            messageId: "interaction-1",
            text: "允许一次",
            receivedAt: Date.parse("2026-10-27T12:00:00+08:00"),
            action: {
                id: "token-1",
                payload: JSON.stringify({ k: "token-1", t: "允许一次" }),
                messageId: "interaction-1",
            },
        });
    });

    it("rejects unsupported types, group chats and missing users", () => {
        for (const event of [
            interactionEvent({ type: 12 }),
            interactionEvent({ chat_type: 1, group_openid: "g1" }),
            interactionEvent({ user_openid: "" }),
            interactionEvent({ id: " " }),
        ]) {
            expect(interactionAckCode(event)).toBe(1);
            expect(normalizeInteraction(event)).toBeNull();
        }
    });

    it("rejects missing or malformed button payloads", () => {
        for (const buttonData of [
            undefined,
            "",
            "not-json",
            "[1]",
            JSON.stringify({}),
            JSON.stringify({ k: "" }),
            JSON.stringify({ k: 1 }),
        ]) {
            const event = interactionEvent();
            if (buttonData === undefined) {
                delete event.data.resolved.button_data;
            } else {
                event.data.resolved.button_data = buttonData;
            }
            expect(interactionAckCode(event)).toBe(1);
            expect(normalizeInteraction(event)).toBeNull();
        }
    });

    it("treats a missing fallback as an empty text and keeps the token", () => {
        const event = interactionEvent();
        event.data.resolved = {
            button_data: JSON.stringify({ k: "token-2" }),
        };
        expect(interactionAckCode(event)).toBe(0);
        expect(normalizeInteraction(event)).toMatchObject({
            text: "",
            action: { id: "token-2" },
        });
        expect(
            parseInteractionButtonData(JSON.stringify({ k: "token-3" }))
        ).toEqual({ token: "token-3", fallback: "" });
    });
});
