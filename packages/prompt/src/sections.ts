/** Section name of the SOUL persona text (D111/D117). */
export const SOUL_SECTION_NAME: string = "nokoribi:soul";

/** SOUL text rides in the deployment persona slot (order 0). */
export const SOUL_SECTION_ORDER: number = 0;

/** Section name of the IM interaction contract. */
export const INTERACTION_SECTION_NAME: string = "nokoribi:interaction";

/** Interaction guidance sits after built-in tool guidance (09.3). */
export const INTERACTION_SECTION_ORDER: number = 4000;

/**
 * Stable IM interaction contract. Kept free of runtime facts so the section
 * never invalidates the KV cache (09.3); interpolation is disabled because
 * the text is literal.
 */
export const INTERACTION_PROMPT: string = `## IM 交互

- 每轮只发一条最终回复：完整、直接可读；不发送思考或工具过程，不假装流式。
- 默认中文（以 SOUL.md 为准）；先给结果，再给必要解释。
- 审批/提问按系统的 🔐 / ❓ 格式回复；不编造结果，不重复提交。
- ⚠️ 前缀是系统通知，不是用户消息；按通知处理，不要回复它。
- 有待应答的审批/提问时优先回答；期间仍可执行命令。
- 命令：/stop /status /clear /new；/goal 按说明使用，命令不进对话历史。`;
