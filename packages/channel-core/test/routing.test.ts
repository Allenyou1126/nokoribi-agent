import { describe, expect, it } from "vitest";

import {
    isNoticeDeliverable,
    pickNoticeRoute,
    remainingReplySlots,
    resolveReplyTarget,
    type RoutingDriverView,
} from "../src/routing.js";

function driver(
    id: string,
    options: {
        defaultChatId?: string;
        activeMessages?: boolean;
        canDeliver?: RoutingDriverView["canDeliver"];
    } = {}
): RoutingDriverView {
    return {
        id,
        capabilities:
            options.activeMessages === undefined
                ? {}
                : { activeMessages: options.activeMessages },
        ...(options.defaultChatId === undefined
            ? {}
            : { defaultChatId: options.defaultChatId }),
        ...(options.canDeliver === undefined
            ? {}
            : { canDeliver: options.canDeliver }),
    };
}

describe("channel routing", () => {
    it("sends a notice to the source chat when it is deliverable", () => {
        const route = pickNoticeRoute({
            source: { channelId: "a", chatId: "a-chat" },
            drivers: [
                driver("a", { defaultChatId: "a-chat" }),
                driver("b", { defaultChatId: "b-chat" }),
            ],
        });
        expect(route).toEqual({
            action: "send",
            chat: { channelId: "a", chatId: "a-chat" },
        });
    });

    it("falls back to an active driver with a default chat", () => {
        const route = pickNoticeRoute({
            source: { channelId: "qq", chatId: "c2c:u" },
            drivers: [
                driver("qq", { activeMessages: false }),
                driver("local-test", { defaultChatId: "local" }),
            ],
        });
        expect(route).toEqual({
            action: "send",
            chat: { channelId: "local-test", chatId: "local" },
        });
    });

    it("defers for the source chat when no active channel exists", () => {
        const route = pickNoticeRoute({
            source: { channelId: "qq", chatId: "c2c:u" },
            drivers: [driver("qq", { activeMessages: false })],
        });
        expect(route).toEqual({
            action: "defer",
            chat: { channelId: "qq", chatId: "c2c:u" },
        });
    });

    it("drops a notice without a source chat or active channel", () => {
        const route = pickNoticeRoute({
            source: null,
            drivers: [driver("qq", { activeMessages: false })],
        });
        expect(route).toEqual({ action: "drop", reason: "no-chat" });
    });

    it("treats a throwing canDeliver as not deliverable", () => {
        const view = driver("a", {
            canDeliver: () => {
                throw new Error("boom");
            },
        });
        expect(isNoticeDeliverable(view, "chat")).toBe(false);
    });

    it("prefers turn chat, then last active, then the default", () => {
        const turn = { channelId: "a", chatId: "turn" };
        const last = { channelId: "b", chatId: "last" };
        const fallback = { channelId: "c", chatId: "default" };
        expect(resolveReplyTarget(turn, last, fallback)).toEqual(turn);
        expect(resolveReplyTarget(null, last, fallback)).toEqual(last);
        expect(resolveReplyTarget(null, null, fallback)).toEqual(fallback);
        expect(resolveReplyTarget(null, null, null)).toBeNull();
    });

    it("computes remaining passive reply slots", () => {
        expect(remainingReplySlots(undefined, 1)).toBe(
            Number.POSITIVE_INFINITY
        );
        expect(remainingReplySlots(0, 1)).toBe(Number.POSITIVE_INFINITY);
        expect(remainingReplySlots(4, 1)).toBe(4);
        expect(remainingReplySlots(4, 4)).toBe(1);
        expect(remainingReplySlots(4, 5)).toBe(0);
    });
});
