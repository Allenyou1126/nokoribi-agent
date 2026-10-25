import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
    AssembleContext,
    PromptAssembly,
} from "@deepseek-ai/dsh-system-prompt";
import Schema from "@deepseek-ai/schemastery";
import {
    createLogger,
    isGoalChildSession,
    resolveHomePaths,
} from "@nokoribi/shared";

import { WORKSPACE_ENV, seedAgentInstructions } from "./agents.js";
import { configuredValue } from "./env.js";
import {
    CHILD_DELEGATION_PROMPT,
    GOAL_CHILD_PROMPT,
    GOAL_CHILD_TOOL_PROMPT,
    GOAL_MAIN_PROMPT,
    GOAL_SECTION_NAME,
    GOAL_SECTION_ORDER,
    GOAL_TOOL_SECTION_NAME,
    INTERACTION_PROMPT,
    INTERACTION_SECTION_NAME,
    INTERACTION_SECTION_ORDER,
    SAFETY_PROMPT,
    SAFETY_SECTION_NAME,
    SAFETY_SECTION_ORDER,
    SOUL_SECTION_NAME,
    SOUL_SECTION_ORDER,
} from "./sections.js";
import { DEFAULT_SOUL_WARN_BYTES, loadSoul } from "./soul.js";

export {
    CHILD_DELEGATION_PROMPT,
    GOAL_CHILD_PROMPT,
    GOAL_CHILD_TOOL_PROMPT,
    GOAL_MAIN_PROMPT,
    GOAL_SECTION_NAME,
    GOAL_SECTION_ORDER,
    GOAL_TOOL_SECTION_NAME,
    INTERACTION_PROMPT,
    SAFETY_PROMPT,
} from "./sections.js";

/**
 * Replace DSH's child delegation context once child approval bridging is on.
 * The original text says every approval-requiring action is rejected, which is
 * no longer true once auto-review escalates child denials to the user.
 * @param assembly - assembled prompt sections and runtime contexts.
 * @param agent - agent whose scope is being assembled, when present.
 * @returns the original assembly or a copy with the corrected context.
 */
export function overrideChildDelegation(
    assembly: PromptAssembly,
    agent: Agent | undefined
): PromptAssembly {
    if (agent === undefined) return assembly;
    const header = agent.session.header;
    if (header.origin !== "subagent" && header.parentSession === undefined) {
        return assembly;
    }
    let changed = false;
    const contexts = assembly.contexts.map((context) => {
        if (
            context.name !== "subagent:delegation" ||
            context.text === CHILD_DELEGATION_PROMPT
        ) {
            return context;
        }
        changed = true;
        return { ...context, text: CHILD_DELEGATION_PROMPT };
    });
    return changed ? { ...assembly, contexts } : assembly;
}

/**
 * Select the goal section text for one agent assembly. Main roots get the
 * control-plane contract, bridge-created goal children get the execution
 * contract, and ordinary delegated children get no goal section.
 * @param agent - agent whose prompt is being assembled.
 * @returns section text (possibly empty).
 */
export function goalPromptForAgent(agent: Agent | undefined): string {
    if (agent === undefined) return GOAL_MAIN_PROMPT;
    if (isGoalChildSession(agent.id)) return GOAL_CHILD_PROMPT;
    const header = agent.session.header;
    if (header.origin === "subagent" || header.parentSession !== undefined) {
        return "";
    }
    return GOAL_MAIN_PROMPT;
}

/**
 * Remove DSH's same-session goal-tool guidance from scopes that must not see
 * it, while giving a goal child the host-created-goal wording.
 * @param assembly - assembled prompt.
 * @param agent - agent whose prompt is being assembled, when present.
 * @returns a possibly rewritten assembly.
 */
export function adjustGoalPrompt(
    assembly: PromptAssembly,
    agent: Agent | undefined
): PromptAssembly {
    if (agent === undefined) return assembly;
    const goalChild = isGoalChildSession(agent.id);
    let changed = false;
    const sections = assembly.sections.flatMap((section) => {
        if (section.name !== GOAL_TOOL_SECTION_NAME) return [section];
        changed = true;
        if (!goalChild) return [];
        return [{ ...section, text: GOAL_CHILD_TOOL_PROMPT }];
    });
    return changed ? { ...assembly, sections } : assembly;
}

/** Plugin name used by Cordis diagnostics. */
export const name: string = "prompt";

/** The prompt registry must exist before sections can be contributed. */
export const inject: string[] = ["systemPrompt"];

/** Seed missing AGENTS.md files on startup unless configured otherwise. */
export const DEFAULT_SEED_AGENTS: boolean = true;

type ObjectSchema = ReturnType<typeof Schema.object>;

/** Prompt plugin configuration; every field has a documented default. */
export interface Config {
    /** Persona file; defaults to NOKORIBI_SOUL_FILE, then `<cwd>/SOUL.md`. */
    readonly soulFile?: string | undefined;
    /** Soft persona-size limit in UTF-8 bytes; exceeding it only warns. */
    readonly soulWarnBytes?: number | undefined;
    /** Persistent workspace override; defaults to `NOKORIBI_WORKSPACE`. */
    readonly workspace?: string | undefined;
    /** Directory holding `AGENTS.global.md` and `AGENTS.workspace.md`. */
    readonly templatesDir?: string | undefined;
    /** Seed missing AGENTS.md files on startup (default `true`). */
    readonly seedAgents?: boolean | undefined;
    /** Seed the user-global `$DSH_HOME/AGENTS.md` (default `true`). */
    readonly seedGlobalAgents?: boolean | undefined;
    /** Seed the workspace `<workspace>/AGENTS.md` (default `true`). */
    readonly seedWorkspaceAgents?: boolean | undefined;
    /** Global AGENTS.md target override (default `$DSH_HOME/AGENTS.md`). */
    readonly globalAgentsFile?: string | undefined;
    /** Workspace AGENTS.md target override. */
    readonly workspaceAgentsFile?: string | undefined;
}

/** Validated prompt configuration schema. */
export const Config: ObjectSchema = Schema.object({
    soulFile: Schema.string().description(
        "Persona file path; defaults to NOKORIBI_SOUL_FILE then <cwd>/SOUL.md."
    ),
    soulWarnBytes: Schema.number()
        .default(DEFAULT_SOUL_WARN_BYTES)
        .min(1)
        .description(
            "Soft SOUL.md size limit in UTF-8 bytes; larger files warn."
        ),
    workspace: Schema.string().description(
        "Persistent workspace; defaults to NOKORIBI_WORKSPACE."
    ),
    templatesDir: Schema.string().description(
        "Directory holding the shipped AGENTS.md seed templates."
    ),
    seedAgents: Schema.boolean()
        .default(DEFAULT_SEED_AGENTS)
        .description("Seed missing AGENTS.md files on startup."),
    seedGlobalAgents: Schema.boolean()
        .default(DEFAULT_SEED_AGENTS)
        .description("Seed the user-global $DSH_HOME/AGENTS.md."),
    seedWorkspaceAgents: Schema.boolean()
        .default(DEFAULT_SEED_AGENTS)
        .description("Seed the workspace <workspace>/AGENTS.md."),
    globalAgentsFile: Schema.string().description(
        "Global AGENTS.md target; defaults to $DSH_HOME/AGENTS.md."
    ),
    workspaceAgentsFile: Schema.string().description(
        "Workspace AGENTS.md target; defaults to <workspace>/AGENTS.md."
    ),
});

function resolveWorkspace(
    configured: string | undefined,
    env: Record<string, string | undefined>
): string | undefined {
    return configuredValue(configured) ?? configuredValue(env[WORKSPACE_ENV]);
}

/**
 * Read SOUL.md once, contribute the two M1 prompt sections, and seed the
 * layered AGENTS.md files when they do not exist yet.
 * @param ctx - Cordis context owning the prompt registrations.
 * @param config - validated prompt configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
    const logger = createLogger("prompt");
    const env = process.env;
    const cwd = process.cwd();
    const soul = await loadSoul({
        configured: config.soulFile,
        env,
        cwd,
        warnBytes: config.soulWarnBytes ?? DEFAULT_SOUL_WARN_BYTES,
        logger,
    });
    ctx.systemPrompt.section({
        name: SOUL_SECTION_NAME,
        order: SOUL_SECTION_ORDER,
        text: soul.text,
        interpolate: false,
    });
    ctx.systemPrompt.section({
        name: INTERACTION_SECTION_NAME,
        order: INTERACTION_SECTION_ORDER,
        text: INTERACTION_PROMPT,
        interpolate: false,
    });
    ctx.systemPrompt.section({
        name: SAFETY_SECTION_NAME,
        order: SAFETY_SECTION_ORDER,
        text: SAFETY_PROMPT,
        interpolate: false,
    });
    ctx.systemPrompt.section({
        name: GOAL_SECTION_NAME,
        order: GOAL_SECTION_ORDER,
        text: (context: AssembleContext) => goalPromptForAgent(context.agent),
        interpolate: false,
    });
    ctx.effect(() =>
        ctx.on(
            "system-prompt/assemble",
            async (
                assembly: PromptAssembly,
                context: AssembleContext,
                next: () => Promise<PromptAssembly>
            ): Promise<PromptAssembly> =>
                adjustGoalPrompt(
                    overrideChildDelegation(await next(), context.agent),
                    context.agent
                )
        )
    );
    logger.info("prompt sections registered", {
        soulFile: soul.path,
        soulBytes: soul.bytes,
    });
    if (!(config.seedAgents ?? DEFAULT_SEED_AGENTS)) return;
    const paths = resolveHomePaths(resolveWorkspace(config.workspace, env));
    await seedAgentInstructions({
        home: paths.home,
        workspace: paths.workspaceDir,
        templatesDir: config.templatesDir,
        env,
        logger,
        seedGlobalAgents: config.seedGlobalAgents,
        seedWorkspaceAgents: config.seedWorkspaceAgents,
        globalAgentsFile: config.globalAgentsFile,
        workspaceAgentsFile: config.workspaceAgentsFile,
    });
}
