import { describe, expect, it } from "vitest";

import { chooseDelivery } from "../src/delivery.js";

describe("delivery selection", () => {
    it("lets an explicit code-level delivery win", () => {
        expect(chooseDelivery("interrupt", "steer", "running")).toEqual({
            mode: "interrupt",
            consumedOneShot: false,
        });
    });

    it("consumes a bare /steer or /queue one-shot", () => {
        expect(chooseDelivery(undefined, "steer", "idle")).toEqual({
            mode: "steer",
            consumedOneShot: true,
        });
        expect(chooseDelivery(undefined, "followup", "running")).toEqual({
            mode: "followup",
            consumedOneShot: true,
        });
    });

    it("steers busy agents and follows up idle agents by default", () => {
        expect(chooseDelivery(undefined, null, "running")).toEqual({
            mode: "steer",
            consumedOneShot: false,
        });
        expect(chooseDelivery(undefined, null, "idle")).toEqual({
            mode: "followup",
            consumedOneShot: false,
        });
    });
});
