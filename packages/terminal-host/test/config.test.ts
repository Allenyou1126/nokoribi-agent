import { describe, expect, it } from "vitest";

import {
    Config,
    resolveConfig,
    TERMINAL_HOST_DEFAULTS,
} from "../src/config.js";

describe("terminal host config", () => {
    it("fills every deployment default through the schema", () => {
        const parsed = Config({}) as Record<string, unknown>;
        expect(parsed).toMatchObject({
            enabled: true,
            bashPath: "bash",
            sendTimeoutMs: 30000,
            rows: 40,
            cols: 160,
            scrollbackLines: 10000,
        });
        expect(parsed).toEqual(TERMINAL_HOST_DEFAULTS);
    });

    it("keeps explicit values", () => {
        const parsed = Config({
            enabled: false,
            bashPath: "/bin/zsh",
            sendTimeoutMs: 1000,
            rows: 24,
            cols: 80,
            scrollbackLines: 100,
        }) as Record<string, unknown>;
        expect(parsed).toEqual({
            enabled: false,
            bashPath: "/bin/zsh",
            sendTimeoutMs: 1000,
            rows: 24,
            cols: 80,
            scrollbackLines: 100,
        });
    });

    it("rejects non-positive size and timeout budgets", () => {
        expect(() => Config({ rows: 0 })).toThrow();
        expect(() => Config({ cols: 0 })).toThrow();
        expect(() => Config({ sendTimeoutMs: 0 })).toThrow();
        expect(() => Config({ scrollbackLines: 0 })).toThrow();
    });

    it("materializes defaults without the schema", () => {
        expect(resolveConfig()).toEqual(TERMINAL_HOST_DEFAULTS);
        expect(resolveConfig({})).toEqual(TERMINAL_HOST_DEFAULTS);
        expect(resolveConfig({ enabled: false, rows: 24 })).toEqual({
            ...TERMINAL_HOST_DEFAULTS,
            enabled: false,
            rows: 24,
        });
    });
});
