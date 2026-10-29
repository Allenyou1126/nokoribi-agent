import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
    TerminalBackend,
    TerminalBackendSpawnSpec,
} from "@deepseek-ai/dsh-terminal";
import { describe, expect, it, vi } from "vitest";

import { TerminalHostController } from "../src/backends.js";
import { resolveConfig } from "../src/config.js";
import {
    createAgent,
    createFakeContext,
    createHostInfo,
    createSnapshot,
} from "./support/fake-context.js";
import type { FakeContext } from "./support/fake-context.js";

function backendOf(fake: FakeContext, type: string): TerminalBackend {
    const backend = fake.backends.get(type);
    if (backend === undefined) throw new Error(`backend "${type}" is missing`);
    return backend;
}

/** Track one owner on a host backend without a real PTY session. */
async function trackOwner(
    fake: FakeContext,
    hostId: string,
    owner: Agent
): Promise<void> {
    const spec: TerminalBackendSpawnSpec = {
        type: hostId,
        sessionId: "pty-1" as TerminalBackendSpawnSpec["sessionId"],
        owner,
    };
    // The fake context has no PTY substrate, so the backend setup rejects after
    // the controller has already recorded the owning session.
    await backendOf(fake, hostId)
        .spawn(spec)
        .catch(() => undefined);
}

describe("terminal host controller", () => {
    it("registers one backend per terminal-capable host", () => {
        const fake = createFakeContext([
            createHostInfo("local:workspace"),
            createHostInfo("sandbox:default", false),
        ]);
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();

        expect([...fake.backends.keys()]).toEqual(["local:workspace"]);
        expect(backendOf(fake, "local:workspace").type).toBe("local:workspace");
    });

    it("registers a backend when a terminal host appears", async () => {
        const fake = createFakeContext();
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();
        expect(fake.backends.size).toBe(0);

        fake.hosts.push(createHostInfo("local:workspace"));
        fake.shellsChanged();
        await vi.waitFor(() => {
            expect(fake.backends.has("local:workspace")).toBe(true);
        });
    });

    it("does not register non-terminal hosts", async () => {
        const fake = createFakeContext();
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();

        fake.hosts.push(createHostInfo("ssh:target", false));
        fake.shellsChanged();
        await controller.sync();
        expect(fake.backends.size).toBe(0);
    });

    it("removes a backend when the host loses terminal support", async () => {
        const fake = createFakeContext([createHostInfo("local:workspace")]);
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();
        expect(fake.backends.has("local:workspace")).toBe(true);

        fake.hosts[0] = createHostInfo("local:workspace", false);
        fake.shellsChanged();
        await vi.waitFor(() => {
            expect(fake.backends.size).toBe(0);
        });
    });

    it("kills that host's terminals before disposing its backend", async () => {
        const owner = createAgent("session-1");
        const fake = createFakeContext([createHostInfo("local:workspace")]);
        fake.sessions.push({
            owner,
            snapshot: createSnapshot("local:workspace", "pty-1"),
        });
        fake.sessions.push({
            owner,
            snapshot: createSnapshot("sandbox:default", "pty-2"),
        });
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();
        await trackOwner(fake, "local:workspace", owner);

        fake.hosts.length = 0;
        fake.shellsChanged();
        await vi.waitFor(() => {
            expect(fake.backends.size).toBe(0);
        });
        expect(fake.kill).toHaveBeenCalledTimes(1);
        expect(fake.kill.mock.calls[0]![0]).toBe(owner);
        expect(fake.kill.mock.calls[0]![1]).toBe("pty-1");
        expect(fake.kill.mock.calls[0]![2]).toBe("shell host removed");
    });

    it("keeps removal working when a terminal kill fails", async () => {
        const owner = createAgent("session-1");
        const fake = createFakeContext([createHostInfo("local:workspace")]);
        fake.sessions.push({
            owner,
            snapshot: createSnapshot("local:workspace", "pty-1"),
        });
        fake.kill.mockRejectedValueOnce(new Error("already closing"));
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();
        await trackOwner(fake, "local:workspace", owner);

        fake.hosts.length = 0;
        await expect(controller.sync()).resolves.toBeUndefined();
        expect(fake.backends.size).toBe(0);
    });

    it("closes every terminal and backend on disposal", async () => {
        const owner = createAgent("session-1");
        const fake = createFakeContext([
            createHostInfo("local:workspace"),
            createHostInfo("sandbox:default"),
        ]);
        fake.sessions.push({
            owner,
            snapshot: createSnapshot("local:workspace", "pty-1"),
        });
        fake.sessions.push({
            owner,
            snapshot: createSnapshot("sandbox:default", "pty-2"),
        });
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();
        await trackOwner(fake, "local:workspace", owner);
        await trackOwner(fake, "sandbox:default", owner);

        await controller.dispose();
        expect(fake.backends.size).toBe(0);
        expect(fake.kill).toHaveBeenCalledTimes(2);

        fake.hosts.push(createHostInfo("local:workspace"));
        fake.shellsChanged();
        await Promise.resolve();
        expect(fake.backends.size).toBe(0);
    });

    it("serializes repeated change notifications", async () => {
        const fake = createFakeContext();
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();

        fake.hosts.push(createHostInfo("local:workspace"));
        fake.shellsChanged();
        fake.shellsChanged();
        fake.shellsChanged();
        await controller.sync();
        await controller.sync();
        expect(fake.backends.size).toBe(1);
    });

    it("is a no-op when disposed twice", async () => {
        const fake = createFakeContext([createHostInfo("local:workspace")]);
        const controller = new TerminalHostController(
            fake.ctx,
            resolveConfig({})
        );
        controller.start();
        await controller.dispose();
        await expect(controller.dispose()).resolves.toBeUndefined();
        expect(fake.backends.size).toBe(0);
    });
});
