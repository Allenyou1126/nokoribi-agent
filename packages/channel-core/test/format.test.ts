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
});
