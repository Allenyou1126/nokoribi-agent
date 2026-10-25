import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import type { LocalTestConfig } from "../src/channel.js";
import { Config, apply } from "../src/index.js";

describe("local test channel plugin", () => {
    it("defaults to enabled and can be disabled without a channel context", async () => {
        const config = (
            Config as (input: Record<string, unknown>) => LocalTestConfig
        )({
            host: "127.0.0.1",
            port: 0,
            token: "test-token",
        });
        expect(config.enabled).toBe(true);
        await expect(
            apply({} as Context, { ...config, enabled: false })
        ).resolves.toBeUndefined();
    });
});
