import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { LocalTestChannel, type LocalTestConfig } from "./channel.js";

export { LocalTestChannel } from "./channel.js";
export type { LocalTestConfig } from "./channel.js";

/** Loader plugin label. */
export const name = "channel-local-test";

/** Channel core must exist before this driver registers itself. */
export const inject: string[] = ["channels"];

/** Runtime configuration schema (validated by the Loader). */
export const Config: unknown = z.object({
    host: z.string().default("127.0.0.1"),
    port: z.natural().default(8787),
    token: z.string().default(""),
    senderId: z.string().default("local-user"),
    chatId: z.string().default("local"),
    longPollTimeoutMs: z.natural().min(1).default(25000),
    maxTextLength: z.natural().default(0),
    markdown: z.union(["none", "basic", "full"]).default("basic"),
    maxBodyBytes: z.natural().min(1024).default(1048576),
});

/** Mount the loopback test channel. */
export async function apply(
    ctx: Context,
    config: LocalTestConfig
): Promise<void> {
    const channel = new LocalTestChannel(config, ctx.channels);
    await channel.listen();
    const disposeDriver = await ctx.channels.registerDriver(channel);
    await channel.writeDiscoveryFile();
    ctx.effect(() => () => {
        disposeDriver();
        return channel.stop();
    });
}
