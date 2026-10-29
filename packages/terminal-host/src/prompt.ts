import type { Context } from "@deepseek-ai/cordis";
import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";

/** Prompt section name for the persistent terminal contract (09.3). */
export const PTY_SECTION_NAME: string = "nokoribi:pty";

/** Placement directly after the shell host contract. */
export const PTY_SECTION_ORDER: number = 3100;

/** Static guidance registered while persistent terminals are enabled. */
export const PTY_SECTION_PROMPT: string = [
    "## 持久终端（terminal_*）",
    "",
    "- `terminal_*` 只用于**需要跨工具调用保留状态**的交互式工作：REPL、长会话调试、需要 `cd`/`export` 持续生效、需要交互式 stdin 的场景。",
    "- 有界的一次性命令优先用 `bash(host)`：它每次都是新进程、不保留状态，更适合短命令与并行任务。",
    "- `terminal_open.type` 是 host id，不是终端类型名；先调用 `get_available_shell_host`，只选输出中 `terminal: true` 的 host；默认 host 不会自动套用。",
    "- `local:*` 终端是真实主机环境：可用系统工具、可 sudo，但每次 `terminal_send` 仍是工具调用，仍会经过 Auto review。",
    "- `sandbox:*` 终端固定在 `$DSH_SANDBOX_DIR`，请求的 cwd 会被忽略；需要 workspace 文件时用 cp/rsync 搬运；sandbox 内不能 sudo。终端打开期间 TTL 回收与 reset 会被保护而拒绝，关闭全部终端后才能回收或重置。",
    "- 终端输出有界：单次 read/send 超过上限会被截断；大输出先写到文件再用 read 工具查看，不要用终端刷屏。",
    "- 状态只在 daemon 进程内持久：`/clear`、goal 归档或 daemon 重启会关闭全部终端并丢失状态；跨重启不保留，不要在终端里放唯一副本。",
    "- 需要命令在后台继续跑时用 `run_in_background`，不要反复 `terminal_send` 轮询；不再需要的终端用 `terminal_close` 关闭。",
].join("\n");

/** Replacement text when this deployment disables persistent terminals. */
export const PTY_DISABLED_PROMPT: string = "持久终端在本部署禁用。";

/**
 * Register the `nokoribi:pty` system-prompt section.
 *
 * The section is static: dynamic host facts stay in the `nokoribi:hosts`
 * section, which the shell router owns.
 * @param ctx - context carrying `ctx.systemPrompt`.
 * @param enabled - whether persistent terminals are available.
 */
export function registerPtyPrompt(ctx: Context, enabled: boolean): void {
    const section: PromptSection = {
        name: PTY_SECTION_NAME,
        order: PTY_SECTION_ORDER,
        text: enabled ? PTY_SECTION_PROMPT : PTY_DISABLED_PROMPT,
        interpolate: false,
    };
    ctx.systemPrompt.section(section);
}
