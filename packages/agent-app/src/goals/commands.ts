import type { GoalModelRef } from "@nokoribi/shared";

import { parseModelRoute } from "./model.js";

/** Parsed `/goal` subcommand. */
export type GoalCommand =
    | {
          readonly kind: "new";
          readonly objective: string;
          readonly maxRounds?: number;
          readonly model?: GoalModelRef;
          readonly reasoningEffort?: string;
      }
    | { readonly kind: "list" }
    | { readonly kind: "status"; readonly prefix: string }
    | { readonly kind: "pause"; readonly prefix: string }
    | { readonly kind: "resume"; readonly prefix: string }
    | { readonly kind: "clear"; readonly prefix: string }
    | { readonly kind: "archive"; readonly prefix: string }
    | { readonly kind: "help" }
    | { readonly kind: "error"; readonly message: string };

/** Short help shown for `/goal` with no arguments or invalid input. */
export const GOAL_HELP: string = [
    "用法：",
    "/goal new <目标> [--rounds N] [--model provider/model] [--effort ID] — 创建 goal 子代理",
    "/goal list — 列出 tracked goals",
    "/goal status <前缀> — 查看详情",
    "/goal pause <前缀> / resume <前缀> — 暂停/恢复自动续跑",
    "/goal clear <前缀> — 停止并归档",
    "/goal archive <前缀> — 归档已完成的 goal",
].join("\n");

function positiveInteger(value: string): number | undefined {
    if (!/^[1-9][0-9]*$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function prefixOf(rest: string): string | GoalCommand {
    const prefix = rest.trim();
    if (prefix === "") {
        return { kind: "error", message: "缺少 goal 前缀。\n" + GOAL_HELP };
    }
    if (/\s/.test(prefix)) {
        return { kind: "error", message: "goal 前缀不能包含空白。" };
    }
    return prefix;
}

/**
 * Parse the text after `/goal` without executing anything.
 * @param rawInput - exact command input after the command name.
 * @returns a validated subcommand or an error/help result.
 */
export function parseGoalCommand(rawInput: string): GoalCommand {
    const input = rawInput.trim();
    if (input === "") return { kind: "help" };
    const [action = "", ...parts] = input.split(/\s+/);
    const rest = input.slice(action.length).trim();
    switch (action.toLowerCase()) {
        case "new": {
            let objective = rest;
            let maxRounds: number | undefined;
            let model: GoalModelRef | undefined;
            let reasoningEffort: string | undefined;
            for (;;) {
                const match =
                    /(?:^|\s)--(rounds|model|effort)(?:\s+(\S+))?\s*$/.exec(
                        objective
                    );
                if (match === null) break;
                const flag = match[1] ?? "";
                const value = match[2];
                if (value === undefined) {
                    return {
                        kind: "error",
                        message:
                            flag === "rounds"
                                ? "--rounds 需要一个正整数。"
                                : `--${flag} 需要一个值。`,
                    };
                }
                if (flag === "rounds") {
                    maxRounds = positiveInteger(value);
                    if (maxRounds === undefined) {
                        return {
                            kind: "error",
                            message: "--rounds 必须是正整数。",
                        };
                    }
                } else if (flag === "model") {
                    model = parseModelRoute(value);
                    if (model === undefined) {
                        return {
                            kind: "error",
                            message:
                                "--model 需要 provider/model 形式的精确路由。",
                        };
                    }
                } else {
                    reasoningEffort = value;
                }
                objective = objective.slice(0, match.index).trim();
            }
            if (objective === "") {
                return {
                    kind: "error",
                    message:
                        "用法：/goal new <目标> [--rounds N] [--model provider/model] [--effort ID]",
                };
            }
            return {
                kind: "new",
                objective,
                ...(maxRounds === undefined ? {} : { maxRounds }),
                ...(model === undefined ? {} : { model }),
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            };
        }
        case "list":
            if (parts.length > 0) {
                return { kind: "error", message: "用法：/goal list" };
            }
            return { kind: "list" };
        case "status":
        case "pause":
        case "resume":
        case "clear":
        case "archive": {
            const prefix = prefixOf(rest);
            if (typeof prefix !== "string") return prefix;
            return {
                kind: action.toLowerCase() as
                    | "status"
                    | "pause"
                    | "resume"
                    | "clear"
                    | "archive",
                prefix,
            };
        }
        case "help":
            return { kind: "help" };
        default:
            return {
                kind: "error",
                message: `未知 /goal 子命令：${action}\n${GOAL_HELP}`,
            };
    }
}
