import type { ShellHostInfo } from "./hosts.js";

/** Prompt section name for the host contract (09.3). */
export const HOSTS_SECTION_NAME: string = "nokoribi:hosts";

/** Hosts guidance sits before the IM interaction section. */
export const HOSTS_SECTION_ORDER: number = 3000;

/** Prompt section name for the bash exit-code reminder. */
export const BASH_SECTION_NAME: string = "tool:bash";

/** Short reminder paired with the bash tool. */
export const BASH_SECTION_PROMPT: string =
    "Check the [exit code: N] marker on every bash result; investigate failures before moving on.";

/**
 * Render the static host contract plus the currently registered host ids.
 *
 * The text is deliberately short and contains no per-turn facts; dynamic
 * values such as sandbox generation stay out of the system prompt (09.3).
 * @param defaultHost - host used when the model omits `host`.
 * @param hosts - currently registered hosts, sorted by the registry.
 * @param terminalEnabled - whether a terminal backend is registered; defaults
 * to true for callers without a terminal service.
 * @returns the hosts prompt section.
 */
export function renderHostsPrompt(
    defaultHost: string,
    hosts: readonly ShellHostInfo[],
    terminalEnabled: boolean = true
): string {
    const lines = [
        "## Shell hosts",
        "",
        `- 默认 host：\`${defaultHost}\`；省略 \`host\` 时使用它。`,
        "- `sandbox:*`：干净、可重置的临时环境；不挂载 workspace，默认 cwd 是 sandbox 临时目录。空闲 TTL 后可能被回收，重要产物要及时写回 workspace。",
        "- `local:*`：真实主机环境，持久 workspace；可用系统工具；sudo 动作会经过 Auto review。",
        "- sandbox 内不能 sudo；需要提权时显式用 local host，并向用户说明原因。",
        "- bash 在 sandbox 中会提供 `DSH_SANDBOX_DIR`、`DSH_WORKSPACE_DIR`；read/write/edit 等文件工具仍按主机路径工作，sandbox 内文件用 cp/rsync 搬运。",
        "- sandbox 与 workspace 是不同视图；不要把 sandbox 当持久存储。",
    ];
    if (terminalEnabled) {
        lines.push(
            "- 持久交互终端用 `terminal_*` 工具；`terminal_open.type` 填 host id，且该 host 必须在 `get_available_shell_host` 中显示 `terminal: true`。"
        );
    }
    lines.push(
        "- 不确定可用 host 时调用 `get_available_shell_host`，不要猜测 host 名称。"
    );
    if (hosts.length > 0) {
        lines.push("", "已注册 host：");
        for (const host of hosts) {
            const background = host.capabilities.background
                ? "后台可用"
                : "仅前台";
            lines.push(
                `- \`${host.id}\`（${host.kind}，${background}）：${host.description}`
            );
        }
    }
    return lines.join("\n");
}
