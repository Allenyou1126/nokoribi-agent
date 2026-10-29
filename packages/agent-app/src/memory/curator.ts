import { randomUUID } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { GoalChanged, GoalView } from "@deepseek-ai/dsh-goal";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentActivation } from "@deepseek-ai/dsh-subagent";
import type { Logger } from "@nokoribi/shared";

import type { GoalManager } from "../goals/manager.js";

/** Resolved memory-curator configuration. */
export interface MemoryCuratorConfig {
    readonly enabled: boolean;
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly timeoutMs: number;
}

/** Inputs rendered into the curator's one-shot prompt. */
export interface CuratorPromptInput {
    readonly objective: string;
    readonly phase: "complete" | "blocked";
    readonly rounds: number;
    readonly maxRounds: number;
    readonly report: string | undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Build the isolated memory-curator instruction.
 * @param input - goal outcome and the last child report, when available.
 * @returns a self-contained prompt for a fresh child.
 */
export function buildCuratorPrompt(input: CuratorPromptInput): string {
    const report = input.report?.trim();
    return [
        "你是记忆整理器，不是对话代理。你的唯一任务是从下面这次 goal 结果中提取值得长期保留的事实、偏好、决定或项目约定，并写入 memory。",
        "",
        `goal phase: ${input.phase}`,
        `objective: ${input.objective}`,
        `rounds: ${String(input.rounds)}/${String(input.maxRounds)}`,
        `last report:\n${report === undefined || report === "" ? "(none)" : report}`,
        "",
        "流程：",
        "1. 先用 memory action=search 查相关 title/tags/body，避免重复。",
        "2. 只写持久、可复用、跨会话仍有价值的内容；临时任务状态、工具输出、完整转录不要写。",
        "3. 不写密钥、token、密码或其它敏感凭据；不写可从仓库直接读到的大段内容。",
        "4. 每条 entry 使用有意义的 title、`type:*`/`project:*`/`topic:*` tags 和简洁 body；source 使用 `goal:<短 id>`。",
        "5. 用户级偏好/身份（type:person / type:preference）写 pinned: true；其他条目默认不 pin；memory write 支持 pinned。",
        "6. 最多写入 3 条；已有条目能更新时优先更新，确需取代时使用 supersedes。",
        "7. 如果没有值得长期保留的内容，不要写入；直接结束。",
        "",
        "不要向用户或父 agent 发消息；不要创建 goal；不要执行无关任务。",
    ].join("\n");
}

/** Host-triggered, best-effort memory extraction for terminal goals. */
export class MemoryCurator {
    private readonly ctx: Context;
    private readonly goals: GoalManager;
    private readonly config: MemoryCuratorConfig;
    private readonly logger: Logger;
    private readonly active = new Set<SubagentActivation>();
    private readonly seen = new Set<string>();
    private main: Agent | undefined;
    private mainId: string | null = null;
    private stopped = true;

    /**
     * Create a curator; call {@link install} and {@link bindMain} from the daemon.
     * @param ctx - host context.
     * @param goals - goal manager exposing tracked reports.
     * @param config - model route and enable/timeout policy.
     * @param logger - structured logger.
     */
    constructor(
        ctx: Context,
        goals: GoalManager,
        config: MemoryCuratorConfig,
        logger: Logger
    ) {
        this.ctx = ctx;
        this.goals = goals;
        this.config = config;
        this.logger = logger;
    }

    /** Subscribe to terminal goal changes and dispose active children. */
    install(): void {
        this.ctx.effect(() =>
            this.ctx.on(
                "goal/changed",
                (payload: {
                    readonly agent: Agent;
                    readonly change: GoalChanged;
                }) => {
                    void this.onGoalChanged(
                        payload.agent,
                        payload.change.goal
                    ).catch((error: unknown) => {
                        this.logger.error("memory curator trigger failed", {
                            error: errorMessage(error),
                        });
                    });
                }
            )
        );
        this.ctx.effect(() => () => this.clear());
    }

    /** Bind the current main agent and enable future triggers. */
    bindMain(agent: Agent): void {
        this.main = agent;
        this.mainId = agent.id;
        this.stopped = false;
    }

    /** Stop future triggers and cancel running curator children. */
    clear(): void {
        this.stopped = true;
        this.main = undefined;
        this.mainId = null;
        this.seen.clear();
        for (const activation of this.active) {
            void activation.dispose().catch((error: unknown) => {
                this.logger.warn("memory curator dispose failed", {
                    error: errorMessage(error),
                });
            });
        }
        this.active.clear();
    }

    private async onGoalChanged(
        agent: Agent,
        goal: GoalView | undefined
    ): Promise<void> {
        if (
            !this.config.enabled ||
            this.stopped ||
            this.main === undefined ||
            goal === undefined
        ) {
            return;
        }
        if (agent.session.header.parentSession !== this.mainId) return;
        if (goal.phase !== "complete" && goal.phase !== "blocked") return;
        const key = `${goal.id}:${goal.phase}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        // Let GoalManager process the same event and capture its report first.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await this.run(agent.id, goal);
    }

    private async run(childId: string, goal: GoalView): Promise<void> {
        const main = this.main;
        if (main === undefined || this.stopped) return;
        const prompt = buildCuratorPrompt({
            objective: goal.objective,
            phase: goal.phase as "complete" | "blocked",
            rounds: goal.roundsStarted,
            maxRounds: goal.maxGoalRounds,
            report: this.goals.lastReport(childId),
        });
        const controller = new AbortController();
        let activation: SubagentActivation | undefined;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                if (activation !== undefined) {
                    void activation.dispose().catch((error: unknown) => {
                        this.logger.warn(
                            "memory curator timeout dispose failed",
                            {
                                error: errorMessage(error),
                            }
                        );
                    });
                }
                reject(new Error("memory curator timed out"));
            }, this.config.timeoutMs);
        });
        try {
            activation = await this.ctx.subagents.startActivation({
                provider: "spawn",
                label: "memory-curator",
                childId: SessionId(`memory-${randomUUID()}`),
                request: {
                    parent: main,
                    prompt: [{ type: "text", text: prompt }] as ContentBlock[],
                    agentOptions: this.agentOptions(),
                },
                signal: controller.signal,
                delivery: "caller",
            });
            if (this.stopped) return;
            this.active.add(activation);
            await Promise.race([activation.result, timeout]);
            this.logger.info("memory curator finished", {
                goal: childId,
                phase: goal.phase,
            });
        } catch (error) {
            this.logger.warn("memory curator failed", {
                goal: childId,
                phase: goal.phase,
                error: errorMessage(error),
            });
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (activation !== undefined) {
                this.active.delete(activation);
                await activation.dispose().catch((error: unknown) => {
                    this.logger.warn("memory curator cleanup failed", {
                        error: errorMessage(error),
                    });
                });
            }
        }
    }

    private agentOptions(): AgentOptions {
        const effort = this.config.reasoningEffort?.trim();
        return {
            provider: this.config.provider,
            model: this.config.model,
            ...(effort === undefined || effort === ""
                ? {}
                : {
                      reasoningEffort:
                          effort as AgentOptions["reasoningEffort"],
                  }),
        };
    }
}
