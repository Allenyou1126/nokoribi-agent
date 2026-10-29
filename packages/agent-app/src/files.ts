import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ChannelService, FileAttachmentRef } from "@nokoribi/channel-core";
import { createLogger, type Logger } from "@nokoribi/shared";

/** Default upper bound for one outbound file (32 MiB). */
export const DEFAULT_SEND_FILE_MAX_BYTES: number = 32 * 1024 * 1024;

/** Durable file saver injected from `ctx.attachments.saveFile`. */
export type SaveOutboundFile = (input: {
    readonly data: Uint8Array;
    readonly name?: string;
}) => Promise<FileAttachmentRef>;

/** Options for the `send_to_user` tool. */
export interface SendToUserToolOptions {
    readonly workspaceDir: string;
    readonly maxBytes: number;
    readonly channels: Pick<ChannelService, "sendFiles">;
    readonly saveFile: SaveOutboundFile;
    readonly logger?: Logger;
}

/** One file read from the workspace and admitted for delivery. */
export interface OutboundFileSource {
    readonly data: Uint8Array;
    readonly name: string;
}

/**
 * Resolve and read one outbound file.
 *
 * Relative paths resolve against the workspace; absolute paths are accepted
 * when the process can read them. The size cap is checked from `stat` before
 * the bytes are read so an oversized file never enters memory.
 * @param path - workspace-relative or absolute path.
 * @param workspaceDir - session workspace root.
 * @param maxBytes - maximum accepted file size in bytes.
 * @returns bytes plus a sanitized basename for display.
 */
export async function readOutboundFile(
    path: string,
    workspaceDir: string,
    maxBytes: number
): Promise<OutboundFileSource> {
    const trimmed = path.trim();
    if (trimmed === "") throw new Error("path must not be empty");
    const resolved = isAbsolute(trimmed)
        ? resolve(trimmed)
        : resolve(workspaceDir, trimmed);
    const info = await stat(resolved).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
        throw new Error(`文件不存在或不是普通文件：${trimmed}`);
    }
    if (info.size > maxBytes) {
        throw new Error(
            `文件过大：${String(info.size)} 字节（上限 ${String(maxBytes)} 字节）`
        );
    }
    const data = await readFile(resolved);
    return { data: new Uint8Array(data), name: basename(resolved) };
}

/**
 * Model-facing tool that sends a message and/or one workspace file to the user.
 *
 * The tool is reviewed by the configured Auto review like any other tool, and
 * the outbox keeps the durable attachment reference across retries/restarts.
 */
export function createSendToUserTool(
    options: SendToUserToolOptions
): ToolDefinition {
    const logger =
        options.logger ??
        createLogger("agent-app-send-to-user", () => undefined);
    return defineTool({
        name: "send_to_user",
        description:
            "Send a message and/or one file from the workspace to the user through the active chat channel, outside the automatic turn reply. Use it to deliver an artifact (report, image, archive) or an out-of-band update. Provide `text`, `path`, or both. The file is read from the workspace (absolute paths allowed), stored durably, and delivered as a channel attachment; failures are returned as tool errors.",
        parameters: {
            text: {
                type: "string",
                description:
                    "Optional message text delivered before the file (or alone when no path is given).",
            },
            path: {
                type: "string",
                description:
                    "Optional workspace-relative or absolute path of a regular file to send.",
            },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    seq: { type: "number", required: true },
                    name: { type: "string", required: true },
                    bytes: { type: "number", required: true },
                },
            },
            render: (_args, value) => [
                {
                    type: "text",
                    text: `已发送给用户（seq ${String(value.seq)}）：${value.name}（${String(value.bytes)} 字节）`,
                },
            ],
        },
        async execute(args: Record<string, unknown>, _exec: ToolRunContext) {
            const text = typeof args.text === "string" ? args.text.trim() : "";
            const path = typeof args.path === "string" ? args.path.trim() : "";
            if (text === "" && path === "") {
                throw new Error("send_to_user 需要 text 或 path 至少一个");
            }
            let saved: FileAttachmentRef | undefined;
            if (path !== "") {
                const source = await readOutboundFile(
                    path,
                    options.workspaceDir,
                    options.maxBytes
                );
                saved = await options.saveFile({
                    data: source.data,
                    name: source.name,
                });
            }
            let seqs: readonly number[];
            try {
                seqs = await options.channels.sendFiles(
                    saved === undefined ? [] : [saved],
                    text
                );
            } catch (error) {
                logger.warn("send_to_user failed", {
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
            const seq = seqs.at(-1);
            if (seq === undefined) {
                throw new Error("消息未能进入发送队列");
            }
            const name = saved?.name ?? "";
            return {
                seq,
                name,
                bytes: saved?.bytes ?? 0,
            };
        },
    });
}
