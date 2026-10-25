import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";

import { HostSessionController } from "../src/session-bridge.js";

function fakeAgent(id: string): Agent {
    return { id: SessionId(id) } as unknown as Agent;
}

describe("HostSessionController", () => {
    it("waits for binding and readiness before resolving the main session", async () => {
        const ctx = new Context();
        const controller = new HostSessionController(ctx);
        const agent = fakeAgent("main-1");
        let settled = false;
        const pending = controller.resolveAgent(SessionId("main-1"));
        void pending.then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);

        controller.bind(agent, Promise.resolve());
        await Promise.resolve();
        expect(settled).toBe(false);

        controller.markReady();
        await expect(pending).resolves.toEqual({ agent });
        expect(controller.boundSessionId).toBe(SessionId("main-1"));
    });

    it("rejects an unknown or stale session after a rebind", async () => {
        const ctx = new Context();
        const controller = new HostSessionController(ctx);
        const first = fakeAgent("main-1");
        const second = fakeAgent("main-2");
        controller.bind(first, Promise.resolve());
        controller.markReady();
        await expect(
            controller.resolveAgent(SessionId("main-1"))
        ).resolves.toEqual({ agent: first });
        await expect(
            controller.resolveAgent(SessionId("other"))
        ).resolves.toEqual({
            error: expect.any(Error),
        });

        controller.bind(second, Promise.resolve());
        controller.markReady();
        await expect(
            controller.resolveAgent(SessionId("main-1"))
        ).resolves.toEqual({
            error: expect.any(Error),
        });
        await expect(
            controller.resolveAgent(SessionId("main-2"))
        ).resolves.toEqual({ agent: second });
    });
});
