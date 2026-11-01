import type {
    ChannelHealth,
    DaemonStatus,
    FullMemoryStatus,
} from "@nokoribi/channel-core";
import type {
    GoalState,
    RecentLogEntry,
    RestartReason,
} from "@nokoribi/shared";

/**
 * Simplified-Chinese labels and human formatting for user-facing IM text
 * (D186). Machine-facing JSON keeps its English field names.
 */

/** Label for one main-agent status. */
export const AGENT_STATUS_LABELS: Readonly<Record<string, string>> = {
    starting: "启动中",
    idle: "空闲",
    running: "运行中",
} satisfies Record<DaemonStatus["agentStatus"], string>;

/** Label for one channel driver health state. */
export const CHANNEL_STATE_LABELS: Readonly<Record<string, string>> = {
    online: "在线",
    connecting: "连接中",
    offline: "离线",
} satisfies Record<ChannelHealth["state"], string>;

/** Label for one goal phase. */
export const GOAL_PHASE_LABELS: Readonly<Record<string, string>> = {
    active: "运行中",
    paused: "已暂停",
    blocked: "已阻塞",
    complete: "已完成",
} satisfies Record<GoalState["phase"], string>;

/** Label for one goal child session state. */
export const GOAL_CHILD_LABELS: Readonly<Record<string, string>> = {
    running: "运行中",
    idle: "空闲",
    cold: "未启动",
};

/** Label for one process-local goal continuation state. */
export const GOAL_ACTIVATION_LABELS: Readonly<Record<string, string>> = {
    armed: "自动续跑已开启",
    disarmed: "自动续跑已暂停",
};

/** Label for one restart reason. */
export const RESTART_REASON_LABELS: Readonly<Record<string, string>> = {
    "first-start": "首次启动",
    clean: "正常退出",
    crash: "异常退出",
    "state-corrupt": "状态文件损坏",
} satisfies Record<RestartReason, string>;

/** Label for the only supported permission preset. */
export const PERMISSION_PRESET_LABELS: Readonly<Record<string, string>> = {
    auto: "自动审查",
};

/** Label for the memory snapshot injection switch. */
export const MEMORY_INJECT_LABELS: Readonly<Record<string, string>> = {
    enabled: "已开启",
    disabled: "已关闭",
} satisfies Record<FullMemoryStatus["inject"], string>;

/** Label for one schedule rule kind. */
export const SCHEDULE_KIND_LABELS: Readonly<Record<string, string>> = {
    after: "延时提醒",
    at: "定时提醒",
    every: "固定间隔提醒",
    daily: "每日提醒",
    weekly: "每周提醒",
    cron: "Cron 提醒",
};

/** Label for one schedule delivery state. */
export const SCHEDULE_STATE_LABELS: Readonly<Record<string, string>> = {
    scheduled: "已排定",
    overdue: "已逾期",
};

/** Label for one retained log record level. */
export const LOG_LEVEL_LABELS: Readonly<Record<string, string>> = {
    warn: "警告",
    error: "错误",
} satisfies Record<RecentLogEntry["level"], string>;

/** Label for one subagent stop reason. */
export const SUBAGENT_STOP_LABELS: Readonly<Record<string, string>> = {
    completed: "已完成",
    aborted: "已中止",
    error: "出错",
    "max-tokens": "达到 token 上限",
    refusal: "拒绝执行",
};

const UNKNOWN_PREFIX = "未知";

/**
 * Look up one display label.
 * @param map - label table keyed by the stored value.
 * @param value - value from a status snapshot or command record.
 * @returns the Chinese label, or `未知（raw）` for an unmapped value.
 */
export function labelOf(
    map: Readonly<Record<string, string>>,
    value: string
): string {
    const label = map[value];
    if (label !== undefined) return label;
    return value.trim() === ""
        ? UNKNOWN_PREFIX
        : `${UNKNOWN_PREFIX}（${value}）`;
}

/**
 * Render a duration as Chinese units.
 * @param totalSeconds - duration in seconds; negative or non-finite values
 * collapse to the smallest unit.
 * @returns text such as `2 小时 3 分` or `不到 1 秒`.
 */
export function formatDuration(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
        return "不到 1 秒";
    }
    const seconds = Math.floor(totalSeconds);
    if (seconds < 60) return `${String(seconds)} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        const rest = seconds % 60;
        return rest === 0
            ? `${String(minutes)} 分`
            : `${String(minutes)} 分 ${String(rest)} 秒`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const rest = minutes % 60;
        return rest === 0
            ? `${String(hours)} 小时`
            : `${String(hours)} 小时 ${String(rest)} 分`;
    }
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest === 0
        ? `${String(days)} 天`
        : `${String(days)} 天 ${String(rest)} 小时`;
}

/**
 * Render a byte count as Chinese units.
 * @param bytes - byte count; negative or non-finite values render as zero.
 * @returns text such as `123 字节` or `1.2 KiB`.
 */
export function formatBytes(bytes: number): string {
    const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (value < 1024) return `${String(Math.floor(value))} 字节`;
    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KiB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
