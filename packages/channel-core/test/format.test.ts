import { describe, expect, it } from "vitest";

import {
    formatOutbound,
    renderForCapability,
    splitText,
} from "../src/format.js";

describe("outbound formatting", () => {
    const full = {
        markdown: "full" as const,
        maxTextLength: 0,
        inboundImages: false,
        outboundFiles: false,
    };
    const none = {
        markdown: "none" as const,
        maxTextLength: 0,
        inboundImages: false,
        outboundFiles: false,
    };

    it("keeps full markdown untouched", () => {
        expect(renderForCapability("**hi**", full)).toBe("**hi**");
    });

    it("downgrades markdown to plain text", () => {
        expect(renderForCapability("**hi** [x](https://e.test)", none)).toBe(
            "hi x (https://e.test)"
        );
    });

    it("splits long text and numbers the chunks", () => {
        const chunks = formatOutbound("a".repeat(30), {
            ...full,
            maxTextLength: 10,
        });
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[0]).toMatch(/^\(1\/\d+\) /);
    });

    it("prefers paragraph boundaries", () => {
        const chunks = splitText("first paragraph\n\nsecond paragraph", 20);
        expect(chunks[0]).toBe("first paragraph");
    });

    it("reserves prefix width so every chunk fits the limit", () => {
        const chunks = formatOutbound("a".repeat(30), {
            ...full,
            maxTextLength: 10,
        });
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(10);
        }
        expect(chunks[0]).toMatch(/^\(1\/\d+\) /);
    });

    it("truncates to max chunks with an ellipsis", () => {
        const chunks = formatOutbound(
            "a".repeat(30),
            { ...full, maxTextLength: 10 },
            { maxChunks: 2 }
        );
        expect(chunks).toHaveLength(2);
        expect(chunks.at(-1)?.endsWith("…")).toBe(true);
        expect(chunks.at(-1)?.length).toBeLessThanOrEqual(10);
    });

    it("returns no chunk when maxChunks is zero", () => {
        expect(formatOutbound("hello", full, { maxChunks: 0 })).toHaveLength(0);
    });

    it("keeps a short message as one unnumbered chunk", () => {
        expect(formatOutbound("hello", { ...full, maxTextLength: 5 })).toEqual([
            "hello",
        ]);
    });
});
