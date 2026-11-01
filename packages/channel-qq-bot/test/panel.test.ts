import { createLogger } from "@nokoribi/shared";
import { describe, expect, it } from "vitest";

import {
    buildPanelItems,
    MAX_PANEL_DESC_CHARS,
    MAX_PANEL_ITEMS,
    MAX_PANEL_NAME_CHARS,
    QqCommandPanel,
    QQ_COMMAND_PANEL_REMARK,
    type QqPanelClient,
    type QqPanelItem,
    type QqPanelPayload,
    type QqPanelRecord,
    type QqPanelScope,
} from "../src/panel.js";

const logger = createLogger("qq-panel-test", () => undefined);

class FakePanelClient implements QqPanelClient {
    readonly lists: QqPanelScope[] = [];
    readonly creates: {
        scope: QqPanelScope;
        panel: QqPanelPayload;
    }[] = [];
    readonly updates: { panelId: string; panel: QqPanelPayload }[] = [];
    readonly records: QqPanelRecord[] = [];
    failList: unknown;
    failCreate: unknown;
    failUpdate: unknown;
    private seq = 0;

    async listPanels(scope: QqPanelScope): Promise<readonly QqPanelRecord[]> {
        this.lists.push(scope);
        if (this.failList !== undefined) throw this.failList;
        return this.records.filter((record) => record.scope === scope);
    }

    async createPanel(
        scope: QqPanelScope,
        panel: QqPanelPayload
    ): Promise<{ readonly panel_id: string }> {
        if (this.failCreate !== undefined) throw this.failCreate;
        this.seq += 1;
        const panelId = `panel-${String(this.seq)}`;
        this.creates.push({ scope, panel });
        this.records.push({
            panel_id: panelId,
            scope,
            target_type: "all",
            panel,
        });
        return { panel_id: panelId };
    }

    async updatePanel(
        panelId: string,
        panel: QqPanelPayload
    ): Promise<{ readonly version: number }> {
        if (this.failUpdate !== undefined) throw this.failUpdate;
        this.updates.push({ panelId, panel });
        const record = this.records.find((entry) => entry.panel_id === panelId);
        if (record !== undefined) {
            const index = this.records.indexOf(record);
            this.records[index] = {
                ...record,
                panel,
            };
        }
        return { version: 2 };
    }
}

function item(name: string, desc = "description"): QqPanelItem {
    return { type: "command", name, desc };
}

function seeded(
    items: readonly QqPanelItem[],
    remark = QQ_COMMAND_PANEL_REMARK
): QqPanelRecord {
    return {
        panel_id: "panel-existing",
        scope: "c2c",
        target_type: "all",
        panel: { items, remark },
    };
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("buildPanelItems", () => {
    it("prefixes names with a slash and sorts by name", () => {
        const items = buildPanelItems(
            [
                { name: "stop", description: "Stop the turn" },
                { name: "clear", description: "Create a new session" },
            ],
            logger
        );
        expect(items.map((entry) => entry.name)).toEqual(["/clear", "/stop"]);
        expect(items.every((entry) => entry.type === "command")).toBe(true);
    });

    it("clips descriptions and collapses whitespace", () => {
        const [item] = buildPanelItems(
            [
                {
                    name: "goal",
                    description: `line one\nline two ${"x".repeat(60)}`,
                },
            ],
            logger
        );
        expect(item?.desc).not.toContain("\n");
        expect(Array.from(item?.desc ?? "").length).toBe(MAX_PANEL_DESC_CHARS);
        expect(item?.desc.endsWith("…")).toBe(true);
    });

    it("falls back to the command name for an empty description", () => {
        const [item] = buildPanelItems(
            [{ name: "status", description: "   " }],
            logger
        );
        expect(item?.desc).toBe("status");
    });

    it("skips command names longer than the panel limit", () => {
        const tooLong = "x".repeat(MAX_PANEL_NAME_CHARS);
        const limit = "y".repeat(MAX_PANEL_NAME_CHARS - 1);
        const items = buildPanelItems(
            [
                { name: tooLong, description: "too long" },
                { name: limit, description: "fits" },
            ],
            logger
        );
        expect(items.map((entry) => entry.name)).toEqual([`/${limit}`]);
    });

    it("caps elements at the platform limit", () => {
        const commands = Array.from(
            { length: MAX_PANEL_ITEMS + 5 },
            (_, i) => ({
                name: `c${String(i).padStart(2, "0")}`,
                description: "command",
            })
        );
        const items = buildPanelItems(commands, logger);
        expect(items).toHaveLength(MAX_PANEL_ITEMS);
        expect(items[0]?.name).toBe("/c00");
    });
});

describe("QqCommandPanel", () => {
    it("creates one C2C panel when none exists", async () => {
        const client = new FakePanelClient();
        const panel = new QqCommandPanel({ client, logger });
        panel.sync([{ name: "stop", description: "Stop the turn" }]);
        await waitFor(() => client.creates.length === 1);
        await panel.stop();
        expect(client.creates[0]?.scope).toBe("c2c");
        expect(client.creates[0]?.panel.remark).toBe(QQ_COMMAND_PANEL_REMARK);
        expect(
            client.creates[0]?.panel.items?.map((entry) => entry.name)
        ).toEqual(["/stop"]);
        expect(client.lists).toEqual(["c2c"]);
        expect(client.lists).not.toContain("group");
    });

    it("updates the marked panel instead of creating a duplicate", async () => {
        const client = new FakePanelClient();
        client.records.push(seeded([item("/old", "old")]));
        const panel = new QqCommandPanel({ client, logger });
        panel.sync([{ name: "stop", description: "Stop the turn" }]);
        await waitFor(() => client.updates.length === 1);
        await panel.stop();
        expect(client.creates).toHaveLength(0);
        expect(client.updates[0]?.panelId).toBe("panel-existing");
        expect(
            client.updates[0]?.panel.items?.map((entry) => entry.name)
        ).toEqual(["/stop"]);
    });

    it("does not rewrite an in-sync panel", async () => {
        const client = new FakePanelClient();
        client.records.push(seeded([item("/stop", "Stop the turn")]));
        const panel = new QqCommandPanel({ client, logger });
        panel.sync([{ name: "stop", description: "Stop the turn" }]);
        await waitFor(() => client.lists.length === 1);
        await panel.stop();
        expect(client.creates).toHaveLength(0);
        expect(client.updates).toHaveLength(0);
    });

    it("ignores panels without the marker remark", async () => {
        const client = new FakePanelClient();
        const foreign = seeded([item("/foreign", "keep me")], "other-tool");
        client.records.push(foreign);
        const panel = new QqCommandPanel({ client, logger });
        panel.sync([{ name: "stop", description: "Stop the turn" }]);
        await waitFor(() => client.creates.length === 1);
        await panel.stop();
        expect(client.updates).toHaveLength(0);
        expect(client.records[0]).toBe(foreign);
    });

    it("updates the newest marked panel and warns on duplicates", async () => {
        const client = new FakePanelClient();
        const newest = seeded([item("/old", "old")]);
        const older = {
            ...seeded([item("/older", "older")]),
            panel_id: "panel-older",
        };
        client.records.push(newest, older);
        const panel = new QqCommandPanel({ client, logger });
        panel.sync([{ name: "stop", description: "Stop the turn" }]);
        await waitFor(() => client.updates.length === 1);
        await panel.stop();
        expect(client.creates).toHaveLength(0);
        expect(client.updates[0]?.panelId).toBe("panel-existing");
    });

    it("retries a retryable failure once and stops cleanly", async () => {
        const client = new FakePanelClient();
        client.failList = Object.assign(new Error("network down"), {
            name: "TypeError",
        });
        const panel = new QqCommandPanel({
            client,
            logger,
            retryDelayMs: 5,
        });
        panel.sync([{ name: "stop", description: "Stop the turn" }]);
        await waitFor(() => client.lists.length >= 2);
        await panel.stop();
        const attempts = client.lists.length;
        await delay(20);
        expect(client.lists.length).toBe(attempts);
        expect(client.creates).toHaveLength(0);
    });

    it("skips an empty catalog without creating a panel", async () => {
        const client = new FakePanelClient();
        const panel = new QqCommandPanel({ client, logger });
        panel.sync([]);
        await delay(10);
        await panel.stop();
        expect(client.lists).toHaveLength(0);
        expect(client.creates).toHaveLength(0);
    });
});
