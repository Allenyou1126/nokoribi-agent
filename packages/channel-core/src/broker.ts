import { randomUUID } from "node:crypto";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
    ApprovalOutcome,
    ApprovalRequest,
} from "@deepseek-ai/dsh-user-approval";
import {
    UserQuestionError,
    type AskUserQuestionAnswer,
    type AskUserQuestionAnswerItem,
    type AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";
import type { Logger } from "@nokoribi/shared";

import {
    describeAgent,
    formatApprovalPrompt,
    formatQuestionPrompt,
    parseApprovalReply,
    parseQuestionReply,
} from "./interaction-format.js";
import { summarizeToolCall } from "./tool-summary.js";

/** Why a broker aborted its pending interactions. */
export type InteractionAbortReason =
    | "user-stop"
    | "clear"
    | "shutdown"
    | "disposed";

/** Callbacks and deadlines owned by the channel service. */
export interface InteractionBrokerOptions {
    readonly approvalTimeoutMs: number;
    readonly questionTimeoutMs: number;
    readonly sendPrompt: (input: {
        readonly text: string;
        readonly interactionId: string;
    }) => Promise<void>;
    readonly sendNotice: (text: string) => Promise<void>;
    readonly onTerminal?: (interactionId: string) => void;
    readonly logger: Logger;
    readonly now?: () => number;
}

interface BaseInteraction {
    readonly id: string;
    readonly kind: "approval" | "question";
    readonly agent: Agent | undefined;
    readonly origin: string;
    readonly signal: AbortSignal | undefined;
    abortListener: (() => void) | undefined;
    deadline: number;
    shown: boolean;
    settled: boolean;
    timer: NodeJS.Timeout | undefined;
}

interface ApprovalInteraction extends BaseInteraction {
    readonly kind: "approval";
    readonly request: ApprovalRequest;
    readonly resolve: (outcome: ApprovalOutcome) => void;
}

interface QuestionInteraction extends BaseInteraction {
    readonly kind: "question";
    readonly request: AskUserQuestionRequest;
    readonly resolve: (answer: AskUserQuestionAnswer) => void;
    readonly reject: (error: Error) => void;
    index: number;
    readonly answers: AskUserQuestionAnswerItem[];
}

type Interaction = ApprovalInteraction | QuestionInteraction;

function interactionId(): string {
    return `i-${randomUUID()}`;
}

function timeoutError(message: string): UserQuestionError {
    return new UserQuestionError(message, "ASK_ABORTED");
}

/**
 * Serial text interaction broker for approvals and user questions.
 *
 * One prompt is presented at a time; replies are routed by the channel ingress
 * while the tool call is still waiting. Every path settles exactly once, and
 * the terminal-id set lets the outbox skip prompts that can no longer be
 * answered.
 */
export class InteractionBroker {
    private readonly options: InteractionBrokerOptions;
    private readonly queue: Interaction[] = [];
    private readonly terminalIds = new Set<string>();
    private readonly terminalOrder: string[] = [];
    private active: Interaction | undefined;
    private closed = false;
    private aborting = false;

    constructor(options: InteractionBrokerOptions) {
        this.options = options;
    }

    /** Number of active and queued interactions. */
    get pendingCount(): number {
        return this.queue.length + (this.active === undefined ? 0 : 1);
    }

    /** Whether any interaction is waiting for a user reply. */
    hasPending(): boolean {
        return this.pendingCount > 0;
    }

    /** Whether an interaction id can no longer be answered. */
    isTerminal(id: string): boolean {
        return this.terminalIds.has(id);
    }

    /** Ask the user for a one-shot approval. */
    requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
        if (this.closed) return Promise.resolve("unavailable");
        return new Promise<ApprovalOutcome>((resolve) => {
            const interaction = this.baseInteraction(req.agent, req.signal);
            const approval: ApprovalInteraction = {
                ...interaction,
                kind: "approval",
                request: req,
                resolve,
            };
            this.enqueue(approval);
        });
    }

    /** Ask the user one or more structured questions. */
    requestQuestion(
        req: AskUserQuestionRequest
    ): Promise<AskUserQuestionAnswer> {
        if (this.closed) {
            return Promise.reject(
                new UserQuestionError(
                    "interaction broker is closed",
                    "NO_PROVIDER"
                )
            );
        }
        return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
            const interaction = this.baseInteraction(req.agent, req.signal);
            const question: QuestionInteraction = {
                ...interaction,
                kind: "question",
                request: req,
                resolve,
                reject,
                index: 0,
                answers: [],
            };
            this.enqueue(question);
        });
    }

    /**
     * Route one ordinary inbound text to the active interaction.
     * @returns true when the broker consumed it; false when nothing is pending.
     */
    async handleReply(text: string): Promise<boolean> {
        const active = this.active;
        if (active === undefined || !active.shown || active.settled) {
            return false;
        }
        if (active.kind === "approval") {
            const decision = parseApprovalReply(text);
            if (decision === undefined) {
                await this.reprompt(active);
                return true;
            }
            this.settleApproval(
                active,
                decision === "allow" ? "allowed-once" : "rejected"
            );
            return true;
        }

        const question = active.request.questions[active.index];
        if (question === undefined) {
            this.failQuestion(active, "question index is out of range");
            return true;
        }
        const parsed = parseQuestionReply(text, question);
        if (parsed === undefined) {
            await this.reprompt(active);
            return true;
        }
        const answer: AskUserQuestionAnswerItem = {
            id: question.id,
            selected: parsed.selected,
            ...(parsed.custom === undefined ? {} : { custom: parsed.custom }),
        };
        active.answers.push(answer);
        active.index += 1;
        if (active.index >= active.request.questions.length) {
            this.resolveQuestion(active);
            return true;
        }
        await this.presentQuestion(active);
        return true;
    }

    /** Abort every pending interaction; optionally notify the user once. */
    async abortAll(
        reason: InteractionAbortReason,
        notify: boolean
    ): Promise<void> {
        this.aborting = true;
        const hadPending = this.pendingCount > 0;
        const items = [...this.queue];
        this.queue.length = 0;
        if (this.active !== undefined) items.push(this.active);
        this.active = undefined;
        for (const interaction of items) {
            this.abortInteraction(interaction);
        }
        this.aborting = false;
        if (notify && hadPending) {
            await this.options.sendNotice(
                reason === "clear"
                    ? "待审批/提问已随会话切换中止。"
                    : reason === "user-stop"
                      ? "待审批/提问已中止。"
                      : "进程关闭，待审批/提问已失效。"
            );
        }
    }

    /** Close the broker and settle everything without notification. */
    async dispose(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.abortAll("disposed", false);
    }

    private baseInteraction(
        agent: Agent | undefined,
        signal: AbortSignal | undefined
    ): BaseInteraction {
        return {
            id: interactionId(),
            kind: "approval",
            agent,
            origin: agent === undefined ? "主会话" : describeAgent(agent),
            signal,
            abortListener: undefined,
            deadline: 0,
            shown: false,
            settled: false,
            timer: undefined,
        };
    }

    private enqueue(interaction: Interaction): void {
        interaction.deadline = 0;
        interaction.shown = false;
        interaction.settled = false;
        interaction.timer = undefined;
        if (interaction.signal !== undefined) {
            const listener = (): void => this.abortInteraction(interaction);
            interaction.abortListener = listener;
            if (interaction.signal.aborted) {
                listener();
                return;
            }
            interaction.signal.addEventListener("abort", listener, {
                once: true,
            });
        }
        this.queue.push(interaction);
        void this.showNext();
    }

    private async showNext(): Promise<void> {
        if (this.closed || this.aborting || this.active !== undefined) return;
        const interaction = this.queue.shift();
        if (interaction === undefined) return;
        if (interaction.settled) {
            void this.showNext();
            return;
        }
        this.active = interaction;
        interaction.shown = true;
        interaction.deadline =
            this.now() +
            (interaction.kind === "approval"
                ? this.options.approvalTimeoutMs
                : this.options.questionTimeoutMs);
        try {
            await this.present(interaction);
        } catch (error) {
            this.options.logger.error("interaction prompt failed", {
                kind: interaction.kind,
                error: error instanceof Error ? error.message : String(error),
            });
            if (interaction.kind === "approval") {
                this.settleApproval(interaction, "unavailable");
            } else {
                this.failQuestion(
                    interaction,
                    error instanceof Error ? error.message : String(error)
                );
            }
            return;
        }
        if (interaction.settled) return;
        this.startTimer(interaction);
    }

    private async present(interaction: Interaction): Promise<void> {
        if (interaction.kind === "question") {
            await this.presentQuestion(interaction);
            return;
        }
        const req = interaction.request;
        const summary = summarizeToolCall(req.agent, req.callId);
        const reason = req.displayReason?.["zh"] ?? req.reason;
        const text = formatApprovalPrompt({
            origin: interaction.origin,
            toolName: req.toolName,
            ...(reason === undefined ? {} : { reason }),
            ...(summary === undefined ? {} : { summary }),
            timeoutSeconds: Math.ceil(this.options.approvalTimeoutMs / 1000),
        });
        await this.options.sendPrompt({
            text,
            interactionId: interaction.id,
        });
    }

    private async presentQuestion(
        interaction: QuestionInteraction
    ): Promise<void> {
        const question = interaction.request.questions[interaction.index];
        if (question === undefined) {
            this.failQuestion(interaction, "question index is out of range");
            return;
        }
        const text = formatQuestionPrompt({
            origin: interaction.origin,
            index: interaction.index + 1,
            total: interaction.request.questions.length,
            question,
            timeoutSeconds: Math.ceil(this.options.questionTimeoutMs / 1000),
        });
        await this.options.sendPrompt({
            text,
            interactionId: interaction.id,
        });
    }

    private async reprompt(interaction: Interaction): Promise<void> {
        const text =
            "无效回复。请按提示重新作答。\n\n" +
            this.describeCurrentPrompt(interaction);
        try {
            await this.options.sendPrompt({
                text,
                interactionId: interaction.id,
            });
        } catch (error) {
            this.options.logger.warn("interaction reprompt failed", {
                kind: interaction.kind,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private describeCurrentPrompt(interaction: Interaction): string {
        if (interaction.kind === "question") {
            const question = interaction.request.questions[interaction.index];
            if (question === undefined) return "";
            return formatQuestionPrompt({
                origin: interaction.origin,
                index: interaction.index + 1,
                total: interaction.request.questions.length,
                question,
                timeoutSeconds: Math.ceil(
                    this.options.questionTimeoutMs / 1000
                ),
            });
        }
        const req = interaction.request;
        const reason = req.displayReason?.["zh"] ?? req.reason;
        const summary = summarizeToolCall(req.agent, req.callId);
        return formatApprovalPrompt({
            origin: interaction.origin,
            toolName: req.toolName,
            ...(reason === undefined ? {} : { reason }),
            ...(summary === undefined ? {} : { summary }),
            timeoutSeconds: Math.ceil(this.options.approvalTimeoutMs / 1000),
        });
    }

    private startTimer(interaction: Interaction): void {
        const remaining = Math.max(0, interaction.deadline - this.now());
        interaction.timer = setTimeout(() => {
            if (interaction.settled) return;
            if (interaction.kind === "approval") {
                this.settleApproval(interaction, "rejected");
                void this.options.sendNotice("审批超时，已拒绝。");
            } else {
                this.failQuestion(interaction, "提问超时，已取消。");
                void this.options.sendNotice("提问超时，已取消。");
            }
        }, remaining);
    }

    private settleApproval(
        interaction: ApprovalInteraction,
        outcome: ApprovalOutcome
    ): void {
        if (interaction.settled) return;
        interaction.settled = true;
        this.clearTimer(interaction);
        interaction.resolve(outcome);
        this.finish(interaction);
        this.options.logger.info("interaction decided", {
            kind: "approval",
            origin: interaction.origin,
            tool: interaction.request.toolName,
            outcome,
        });
    }

    private resolveQuestion(interaction: QuestionInteraction): void {
        if (interaction.settled) return;
        interaction.settled = true;
        this.clearTimer(interaction);
        interaction.resolve({ answers: [...interaction.answers] });
        this.finish(interaction);
        this.options.logger.info("interaction decided", {
            kind: "question",
            origin: interaction.origin,
            questions: interaction.request.questions.length,
            outcome: "answered",
        });
    }

    private failQuestion(
        interaction: QuestionInteraction,
        message: string
    ): void {
        if (interaction.settled) return;
        interaction.settled = true;
        this.clearTimer(interaction);
        interaction.reject(timeoutError(message));
        this.finish(interaction);
        this.options.logger.info("interaction decided", {
            kind: "question",
            origin: interaction.origin,
            outcome: "failed",
        });
    }

    private abortInteraction(interaction: Interaction): void {
        if (interaction.settled) return;
        interaction.settled = true;
        this.clearTimer(interaction);
        this.removeFromQueue(interaction);
        if (interaction.kind === "approval") {
            interaction.resolve("cancelled");
        } else {
            interaction.reject(
                timeoutError(
                    "ask_user_question was aborted before the user answered"
                )
            );
        }
        this.finish(interaction, true);
        this.options.logger.info("interaction aborted", {
            kind: interaction.kind,
            origin: interaction.origin,
        });
    }

    private finish(interaction: Interaction, skipNext = false): void {
        if (this.active === interaction) this.active = undefined;
        if (
            interaction.signal !== undefined &&
            interaction.abortListener !== undefined
        ) {
            interaction.signal.removeEventListener(
                "abort",
                interaction.abortListener
            );
        }
        this.rememberTerminal(interaction.id);
        this.options.onTerminal?.(interaction.id);
        if (!skipNext) void this.showNext();
    }

    private clearTimer(interaction: Interaction): void {
        if (interaction.timer !== undefined) {
            clearTimeout(interaction.timer);
            interaction.timer = undefined;
        }
    }

    private removeFromQueue(interaction: Interaction): void {
        const index = this.queue.indexOf(interaction);
        if (index >= 0) this.queue.splice(index, 1);
    }

    private rememberTerminal(id: string): void {
        if (this.terminalIds.has(id)) return;
        this.terminalIds.add(id);
        this.terminalOrder.push(id);
        if (this.terminalOrder.length > 1000) {
            const oldest = this.terminalOrder.shift();
            if (oldest !== undefined) this.terminalIds.delete(oldest);
        }
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }
}
