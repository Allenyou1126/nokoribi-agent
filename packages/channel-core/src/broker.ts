import { randomBytes, randomUUID } from "node:crypto";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
    ApprovalOutcome,
    ApprovalRequest,
} from "@deepseek-ai/dsh-user-approval";
import {
    UserQuestionError,
    type AskUserQuestionAnswer,
    type AskUserQuestionAnswerItem,
    type AskUserQuestionItem,
    type AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";
import type { Logger, OutboundAction } from "@nokoribi/shared";

import type { InboundAction } from "./contract.js";
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
        readonly actions?: readonly OutboundAction[];
        readonly actionKind?: "approval" | "question";
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
    actions: readonly OutboundAction[] | undefined;
}

interface ApprovalActionToken {
    readonly kind: "approval";
    readonly interactionId: string;
    readonly outcome: ApprovalOutcome;
}

interface QuestionActionToken {
    readonly kind: "question";
    readonly interactionId: string;
    readonly questionIndex: number;
    readonly optionIndex: number;
}

type ActionToken = ApprovalActionToken | QuestionActionToken;

/** Maximum option buttons rendered for one question (QQ row limits). */
const MAX_QUESTION_BUTTONS = 10;
/** Maximum keyboard label length accepted by QQ. */
const MAX_QUESTION_LABEL = 10;

interface QuestionInteraction extends BaseInteraction {
    readonly kind: "question";
    readonly request: AskUserQuestionRequest;
    readonly resolve: (answer: AskUserQuestionAnswer) => void;
    readonly reject: (error: Error) => void;
    index: number;
    readonly answers: AskUserQuestionAnswerItem[];
    /** Cached actions for the question at `actionIndex`. */
    actions: readonly OutboundAction[] | undefined;
    actionIndex: number;
}

type Interaction = ApprovalInteraction | QuestionInteraction;

/** Whether one question can be answered from explicit option buttons. */
function questionHasButtons(question: AskUserQuestionItem): boolean {
    const options = question.options ?? [];
    return (
        question.multiSelect !== true &&
        options.length > 0 &&
        options.length <= MAX_QUESTION_BUTTONS
    );
}

/** Truncate one button label to the QQ keyboard limit. */
function questionActionLabel(label: string): string {
    const chars = Array.from(label.trim());
    if (chars.length <= MAX_QUESTION_LABEL) return chars.join("");
    return `${chars.slice(0, MAX_QUESTION_LABEL - 1).join("")}…`;
}

function interactionId(): string {
    return `i-${randomUUID()}`;
}

function timeoutError(message: string): UserQuestionError {
    return new UserQuestionError(message, "ASK_ABORTED");
}

const APPROVAL_ACTIONS: readonly {
    readonly label: string;
    readonly outcome: ApprovalOutcome;
    readonly style: "primary" | "danger";
}[] = [
    { label: "允许一次", outcome: "allowed-once", style: "primary" },
    { label: "拒绝", outcome: "rejected", style: "danger" },
];

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
    private readonly actionTokens = new Map<string, ActionToken>();
    private readonly tokensByInteraction = new Map<string, Set<string>>();
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
                actions: undefined,
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
                actions: undefined,
                actionIndex: -1,
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
        await this.applyAnswer(active, answer);
        return true;
    }

    /**
     * Route one inbound button callback to the active approval or question.
     *
     * Actions are authoritative: the payload token is the only signal.
     * Unknown, malformed, stale or already-consumed actions are not interpreted
     * as text replies and never reach the model.
     * @returns true when the broker consumed the callback.
     */
    async handleAction(action: InboundAction): Promise<boolean> {
        const token = this.actionToken(action);
        if (token === undefined) return false;
        const entry = this.actionTokens.get(token);
        if (entry === undefined) return false;
        const active = this.active;
        if (
            active === undefined ||
            !active.shown ||
            active.settled ||
            active.id !== entry.interactionId
        ) {
            return false;
        }
        if (entry.kind === "approval") {
            if (active.kind !== "approval") return false;
            this.settleApproval(active, entry.outcome);
            return true;
        }
        if (active.kind !== "question") return false;
        if (entry.questionIndex !== active.index) return false;
        const question = active.request.questions[active.index];
        if (question === undefined) {
            this.failQuestion(active, "question index is out of range");
            return true;
        }
        const label = question.options?.[entry.optionIndex]?.label;
        if (label === undefined) return false;
        await this.applyAnswer(active, { id: question.id, selected: [label] });
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
        const actions = this.createApprovalActions(interaction);
        await this.options.sendPrompt({
            text,
            interactionId: interaction.id,
            actions,
            actionKind: "approval",
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
        const actions = this.questionActions(interaction);
        await this.options.sendPrompt({
            text,
            interactionId: interaction.id,
            ...(actions === undefined
                ? {}
                : { actions, actionKind: "question" }),
        });
    }

    private async reprompt(interaction: Interaction): Promise<void> {
        const text =
            "无效回复。请按提示重新作答。\n\n" +
            this.describeCurrentPrompt(interaction);
        const actions =
            interaction.kind === "approval"
                ? this.createApprovalActions(interaction)
                : this.questionActions(interaction);
        const actionKind =
            interaction.kind === "approval" ? "approval" : "question";
        try {
            await this.options.sendPrompt({
                text,
                interactionId: interaction.id,
                ...(actions === undefined ? {} : { actions, actionKind }),
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

    private createApprovalActions(
        interaction: ApprovalInteraction
    ): readonly OutboundAction[] {
        if (interaction.actions !== undefined) return interaction.actions;
        const actions = APPROVAL_ACTIONS.map((spec) => {
            const token = this.registerApprovalToken(
                interaction.id,
                spec.outcome
            );
            return {
                id: token,
                label: spec.label,
                kind: "callback" as const,
                payload: JSON.stringify({ k: token, t: spec.label }),
                style: spec.style,
            };
        });
        interaction.actions = actions;
        return actions;
    }

    private registerApprovalToken(
        interactionId: string,
        outcome: ApprovalOutcome
    ): string {
        const token = randomBytes(16).toString("base64url");
        this.actionTokens.set(token, {
            kind: "approval",
            interactionId,
            outcome,
        });
        let tokens = this.tokensByInteraction.get(interactionId);
        if (tokens === undefined) {
            tokens = new Set<string>();
            this.tokensByInteraction.set(interactionId, tokens);
        }
        tokens.add(token);
        return token;
    }

    private actionToken(action: InboundAction): string | undefined {
        const payload = action.payload;
        if (payload !== undefined) {
            try {
                const parsed: unknown = JSON.parse(payload);
                if (typeof parsed === "object" && parsed !== null) {
                    const token = (parsed as { k?: unknown }).k;
                    if (typeof token === "string" && token.trim() !== "") {
                        return token;
                    }
                }
            } catch {
                // A malformed payload falls back to the platform id below.
            }
        }
        const id = action.id.trim();
        return id === "" ? undefined : id;
    }

    private forgetActionTokens(interactionId: string): void {
        const tokens = this.tokensByInteraction.get(interactionId);
        if (tokens === undefined) return;
        for (const token of tokens) this.actionTokens.delete(token);
        this.tokensByInteraction.delete(interactionId);
    }

    /**
     * Generate or reuse the option buttons for the current question.
     *
     * Buttons are only produced for single-select questions with 1..10 explicit
     * options; every other shape keeps the text fallback. Tokens are scoped to
     * the interaction and question index so a click on an old row cannot answer
     * a later question.
     */
    private questionActions(
        interaction: QuestionInteraction
    ): readonly OutboundAction[] | undefined {
        const question = interaction.request.questions[interaction.index];
        if (question === undefined || !questionHasButtons(question)) {
            this.forgetActionTokens(interaction.id);
            interaction.actions = undefined;
            interaction.actionIndex = -1;
            return undefined;
        }
        if (
            interaction.actions !== undefined &&
            interaction.actionIndex === interaction.index
        ) {
            return interaction.actions;
        }
        this.forgetActionTokens(interaction.id);
        const actions = (question.options ?? []).map((option, optionIndex) => {
            const token = randomBytes(16).toString("base64url");
            this.actionTokens.set(token, {
                kind: "question",
                interactionId: interaction.id,
                questionIndex: interaction.index,
                optionIndex,
            });
            let tokens = this.tokensByInteraction.get(interaction.id);
            if (tokens === undefined) {
                tokens = new Set<string>();
                this.tokensByInteraction.set(interaction.id, tokens);
            }
            tokens.add(token);
            const label = questionActionLabel(option.label);
            return {
                id: token,
                label,
                kind: "callback" as const,
                payload: JSON.stringify({ k: token, t: label }),
                style: "default" as const,
            };
        });
        interaction.actions = actions;
        interaction.actionIndex = interaction.index;
        return actions;
    }

    /** Record one answer, then advance or settle the question batch. */
    private async applyAnswer(
        interaction: QuestionInteraction,
        answer: AskUserQuestionAnswerItem
    ): Promise<void> {
        interaction.answers.push(answer);
        interaction.index += 1;
        if (interaction.index >= interaction.request.questions.length) {
            this.resolveQuestion(interaction);
            return;
        }
        await this.presentQuestion(interaction);
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
        this.forgetActionTokens(interaction.id);
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
