#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    loadLayeredEnv,
    loadProfileDirectory,
} from "@deepseek-ai/dsh-app-boot";
import { writeJsonAtomic } from "@nokoribi/shared";

const PROFILE_NAME = "nokoribi-agent";
/** Bundles mounted by every deployment, before any optional backend bundle. */
const BASE_BUNDLES = ["@nokoribi/bundle"] as const;
const OPENVIKING_BUNDLE = "@openviking/dsh-memory-plugin";

/**
 * Bundles mounted by the runtime profile. OpenViking is an explicit opt-in
 * backend (D175): its package is installed with the distribution but its Cordis
 * layer only loads when the deployment enables the backend.
 */
function resolveProfileBundles(env: NodeJS.ProcessEnv): readonly string[] {
    if ((env.NOKORIBI_OPENVIKING_ENABLED ?? "false") !== "true") {
        return BASE_BUNDLES;
    }
    return [...BASE_BUNDLES, OPENVIKING_BUNDLE];
}

/**
 * Map `memory.openviking.*` configuration to the environment the plugin's
 * credential chain reads. The NixOS module sets `NOKORIBI_OPENVIKING_*`; a
 * manual deployment may instead set the `OPENVIKING_*` names directly.
 *
 * Enabling OpenViking is mutually exclusive with local memory (D175): the local
 * memory tool, storage, snapshot and curator stay off so exactly one backend
 * owns memory.
 */
function applyOpenVikingEnvironment(env: NodeJS.ProcessEnv): void {
    if ((env.NOKORIBI_OPENVIKING_ENABLED ?? "false") !== "true") return;
    env.NOKORIBI_MEMORY_ENABLED = "false";
    const endpoint = env.NOKORIBI_OPENVIKING_ENDPOINT?.trim();
    if (endpoint !== undefined && endpoint !== "") {
        env.OPENVIKING_URL ??= endpoint;
    }
    const keySource =
        env.NOKORIBI_OPENVIKING_API_KEY_ENV?.trim() || "OPENVIKING_API_KEY";
    const apiKey = env[keySource]?.trim();
    if (apiKey !== undefined && apiKey !== "") {
        env.OPENVIKING_API_KEY ??= apiKey;
    }
    const peerId = env.NOKORIBI_OPENVIKING_PEER_ID?.trim();
    if (peerId !== undefined && peerId !== "") {
        env.OPENVIKING_PEER_ID ??= peerId;
    }
    const workspacePeer = env.NOKORIBI_OPENVIKING_WORKSPACE_PEER?.trim();
    if (workspacePeer !== undefined && workspacePeer !== "") {
        env.OPENVIKING_WORKSPACE_PEER ??= workspacePeer;
    }
    const recallMaxTokens = env.NOKORIBI_OPENVIKING_RECALL_MAX_TOKENS?.trim();
    if (recallMaxTokens !== undefined && recallMaxTokens !== "") {
        env.OPENVIKING_RECALL_MAX_TOKENS ??= recallMaxTokens;
    }
}

interface CliOptions {
    readonly patches: readonly string[];
    readonly help: boolean;
    readonly version: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
    const patches: string[] = [];
    let help = false;
    let version = false;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--help" || arg === "-h") {
            help = true;
        } else if (arg === "--version" || arg === "-v") {
            version = true;
        } else if (arg === "--profile") {
            const value = argv[++index];
            if (value !== PROFILE_NAME) {
                throw new Error(
                    `unsupported profile ${JSON.stringify(value)}; only ${JSON.stringify(PROFILE_NAME)} is packaged`
                );
            }
        } else if (arg === "--patch") {
            const value = argv[++index];
            if (value === undefined) throw new Error("--patch requires a path");
            patches.push(
                isAbsolute(value) ? value : resolve(process.cwd(), value)
            );
        } else {
            throw new Error(`unknown argument ${JSON.stringify(arg)}`);
        }
    }
    return { patches, help, version };
}

function helpText(version: string): string {
    return [
        `nokoribi-agent ${version}`,
        "",
        "Usage: nokoribi-agent [--profile nokoribi-agent] [--patch <file>] [--version] [--help]",
        "",
        "Environment:",
        "  DSH_HOME                     harness home (default: ~/.dsh)",
        "  DEEPSEEK_API_KEY             model credential",
        "  NOKORIBI_TEST_TOKEN          loopback test channel token (required)",
        "  NOKORIBI_TEST_PORT           loopback test channel port (default 8787)",
        "  NOKORIBI_QQ_BOT_ENABLED      enable QQ official bot (default false)",
        "  NOKORIBI_QQ_BOT_APP_ID       QQ Bot AppID; non-secret",
        "  NOKORIBI_QQ_BOT_CLIENT_SECRET secret via EnvironmentFile only",
        "  NOKORIBI_QQ_BOT_MARKDOWN     none|basic|full (default basic)",
        "  NOKORIBI_QQ_BOT_MAX_TEXT_LENGTH text chunk limit (default 4500)",
        "  NOKORIBI_QQ_BOT_MAX_REPLIES  passive reply cap (default 4)",
        "  NOKORIBI_QQ_BOT_C2C_WINDOW_SECONDS C2C window seconds (3600)",
        "  NOKORIBI_QQ_BOT_GROUP_WINDOW_SECONDS group window seconds (300)",
        "  NOKORIBI_QQ_BOT_REQUEST_TIMEOUT_MS REST timeout ms (10000)",
        "  NOKORIBI_QQ_BOT_CONNECT_TIMEOUT_MS connect timeout ms (30000)",
        "  NOKORIBI_QQ_BOT_ACTIVE_FALLBACK active message fallback (auto)",
        "  NOKORIBI_QQ_BOT_APPROVAL_BUTTONS C2C approval buttons (default true)",
        "  NOKORIBI_QQ_BOT_RECONNECT_BASE_MS reconnect backoff base (1000)",
        "  NOKORIBI_QQ_BOT_RECONNECT_MAX_MS reconnect backoff cap (60000)",
        "  NOKORIBI_QQ_BOT_API_BASE     REST base URL override (test)",
        "  NOKORIBI_QQ_BOT_TOKEN_BASE   token base URL override (test)",
        "  NOKORIBI_QQ_BOT_GATEWAY_URL  gateway URL override (test)",
        "  NOKORIBI_REVIEW_FAST_MODEL   fast reviewer model (default: main model)",
        "  NOKORIBI_REVIEW_STRONG_MODEL strong reviewer model (default: fast model)",
        "  NOKORIBI_REVIEW_EXEMPT_TOOLS comma-separated tools exempt from Auto review",
        "  NOKORIBI_APPROVAL_TIMEOUT_MS approval timeout (default 60000)",
        "  NOKORIBI_QUESTION_TIMEOUT_MS question timeout (default 300000)",
        "  NOKORIBI_DEFAULT_HOST       default shell host (default sandbox:default)",
        "  NOKORIBI_LOCAL_EXTRA_PATH   colon-separated PATH additions for local host",
        "  NOKORIBI_SANDBOX_BASE_ENV   Nix buildEnv store path for the sandbox",
        "  NOKORIBI_SANDBOX_TTL_MS     sandbox idle TTL (default 1800000)",
        "  NOKORIBI_SANDBOX_SETPRIV    setpriv path/name for no_new_privs",
        "  NOKORIBI_TERMINAL_ENABLED   register host-aware terminals (default true)",
        "  NOKORIBI_TERMINAL_BASH_PATH local terminal shell (default bash)",
        "  NOKORIBI_TERMINAL_MAX_RESULT_BYTES terminal read/send cap (default 262144)",
        "  NOKORIBI_TERMINAL_SEND_TIMEOUT_MS foreground send wait (default 30000)",
        "  NOKORIBI_TERMINAL_ROWS      initial PTY rows (default 40)",
        "  NOKORIBI_TERMINAL_COLS      initial PTY columns (default 160)",
        "  NOKORIBI_TERMINAL_SCROLLBACK_LINES scrollback lines (default 10000)",
        "  NOKORIBI_WEB_ENABLED        register web_search/web_fetch (default true)",
        "  NOKORIBI_WEB_SEARCH_PROVIDER pinned search provider (default deepseek-official)",
        "  NOKORIBI_WEB_FETCH_PROVIDER pinned fetch provider (default http)",
        "  NOKORIBI_SESSION_SEARCH_ENABLED session_search/session_event_* tools (default true)",
        "  NOKORIBI_SESSION_SEARCH_OPEN_AT FTS index open: first-search|startup|never",
        "  NOKORIBI_SESSION_SEARCH_MAX_RESULTS per-call search result cap (default 100)",
        "  NOKORIBI_SESSION_SEARCH_TIMEOUT_MS search deadline ms (default 30000)",
        "  NOKORIBI_SKILL_ENABLED     load local SKILL.md skills (default true)",
        "  NOKORIBI_SKILL_DIRS        colon-separated extra read-only skill roots",
        "  NOKORIBI_BUNDLED_SKILLS    bundled read-only skill root (Nix share/skills)",
        "  NOKORIBI_SKILL_DESCRIPTION_MAX catalog description cap (default 500)",
        "  NOKORIBI_GOAL_PROVIDER      goal child provider (default: main provider)",
        "  NOKORIBI_GOAL_MODEL         goal child model (default: main model)",
        "  NOKORIBI_GOAL_REASONING_EFFORT goal child reasoning effort (optional)",
        "  NOKORIBI_GOAL_MODELS        comma-separated provider/model goal allowlist",
        "  NOKORIBI_GOAL_RECOVERY_TIMEOUT_MS cold goal recovery bound (default 30000)",
        "  NOKORIBI_MAX_ACTIVE_SUBAGENTS subagent activation capacity (default unlimited)",
        "  NOKORIBI_TIME_ZONE          time-context fallback zone (default process)",
        "  NOKORIBI_TIME_CONTEXT_REFRESH_MS time-context minimum interval (default 60000)",
        "  NOKORIBI_MEMORY_PROVIDER    memory curator provider (default: goal provider)",
        "  NOKORIBI_MEMORY_MODEL       memory curator model (default: goal model)",
        "  NOKORIBI_MEMORY_REASONING_EFFORT memory curator reasoning effort (optional)",
        "  NOKORIBI_MEMORY_CURATOR     enable best-effort memory extraction (default true)",
        "  NOKORIBI_MEMORY_CURATOR_TIMEOUT_MS memory curator bound (default 60000)",
        "  NOKORIBI_MEMORY_ENABLED     mount local memory tool/store/snapshot (default true)",
        "  NOKORIBI_MEMORY_INJECT_ENABLED inject the pinned memory snapshot (default true)",
        "  NOKORIBI_MEMORY_INJECT_MAX_CHARS snapshot character budget (default 3000)",
        "  NOKORIBI_MEMORY_INJECT_MAX_ENTRIES snapshot entry budget (default 20)",
        "  NOKORIBI_MEMORY_INJECT_MAIN_ONLY inject only for the main session (default true)",
        "  NOKORIBI_MEMORY_INJECT_AUTO_TAGS comma-separated auto-included tags",
        "  NOKORIBI_OPENVIKING_ENABLED enable the OpenViking memory backend (default false)",
        "  NOKORIBI_OPENVIKING_ENDPOINT OpenViking server URL",
        "  NOKORIBI_OPENVIKING_API_KEY_ENV env var holding the OpenViking bearer key",
        "  NOKORIBI_OPENVIKING_PEER_ID explicit OpenViking actor peer",
        "  NOKORIBI_OPENVIKING_WORKSPACE_PEER workspace-derived peer ('0' disables)",
        "  NOKORIBI_OPENVIKING_RECALL_MAX_TOKENS server-assembled recall token budget",
        "  NOKORIBI_GOAL_DEFAULT_MAX_ROUNDS default goal round cap (default 256)",
        "  NOKORIBI_LOG_LEVEL          debug|info|warn|error (default info)",
        "  NOKORIBI_SYSTEMD_NOTIFY     systemd-notify helper path (default: PATH)",
        "  NOKORIBI_READY_TIMEOUT_MS   launcher readiness wait; 0 disables (default 30000)",
        "  NOKORIBI_PATCH               colon-separated extra overlay files",
        "  NOKORIBI_SOUL_FILE           persona file (default: repository SOUL.md)",
        "  NOKORIBI_TEMPLATES_DIR       AGENTS.md templates directory",
    ].join("\n");
}

function splitPaths(value: string | undefined): readonly string[] {
    if (value === undefined || value.trim() === "") return [];
    return value
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .map((entry) =>
            isAbsolute(entry) ? entry : resolve(process.cwd(), entry)
        );
}

async function main(): Promise<void> {
    const anchor = fileURLToPath(new URL("../package.json", import.meta.url));
    const manifest = JSON.parse(await readFile(anchor, "utf8")) as {
        version?: string;
    };
    const version = manifest.version ?? "0.0.0";
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${helpText(version)}\n`);
        return;
    }
    if (options.version) {
        process.stdout.write(`nokoribi-agent ${version}\n`);
        return;
    }

    const launcherDir = dirname(anchor);
    process.env.NOKORIBI_INSTALL_ANCHOR = anchor;
    process.env.NOKORIBI_VERSION ??= version;
    process.env.NOKORIBI_SHUTDOWN_TIMEOUT_MS ??= "30000";
    applyOpenVikingEnvironment(process.env);

    await applyDevDefaults(launcherDir);

    const home = process.env.DSH_HOME?.trim();
    if (home === undefined || home === "") {
        throw new Error(
            "DSH_HOME is required for the daemon; set it to a writable directory"
        );
    }
    const profileDir = resolve(home, "run/profile");
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(resolve(profileDir, "package.json"), {
        name: PROFILE_NAME,
        private: true,
        dsh: { profile: { bundles: resolveProfileBundles(process.env) } },
    });
    await writeFile(resolve(profileDir, "cordis.patch.yml"), "[]\n", {
        mode: 0o600,
    });

    const profile = loadProfileDirectory(PROFILE_NAME, profileDir, anchor);
    if (profile.skippedBundles.length > 0) {
        for (const skipped of profile.skippedBundles) {
            process.stderr.write(
                `nokoribi-agent: skipped bundle ${skipped.packageName}: ${skipped.reason}\n`
            );
        }
    }
    // OpenViking replaces local memory entirely (D175), so a deployment that
    // asked for it but silently lost its bundle would run without any memory
    // backend. Fail loud instead of starting in a degraded configuration.
    if ((process.env.NOKORIBI_OPENVIKING_ENABLED ?? "false") === "true") {
        const skipped = profile.skippedBundles.find(
            (entry) => entry.packageName === OPENVIKING_BUNDLE
        );
        if (skipped !== undefined) {
            throw new Error(
                `OpenViking memory backend is enabled but its bundle failed to load: ${skipped.reason}`
            );
        }
        if (
            !profile.layers.some(
                (layer) => layer.packageName === OPENVIKING_BUNDLE
            )
        ) {
            throw new Error(
                `OpenViking memory backend is enabled but ${JSON.stringify(OPENVIKING_BUNDLE)} is not part of the profile; reinstall the package`
            );
        }
    }
    const environment = loadLayeredEnv(PROFILE_NAME, process.cwd());
    const patchFiles = [
        ...splitPaths(process.env.NOKORIBI_PATCH),
        ...options.patches,
    ];
    const { runProfile } = await import("@nokoribi/profile-boot");
    const boot = runProfile({
        environment,
        profile: PROFILE_NAME,
        resolvedProfile: { profile, installAnchor: anchor },
        patchFiles,
        args: [],
    });
    await boot;
    await waitForReady(home);
}

async function waitForReady(home: string): Promise<void> {
    const readyPath = resolve(home, "run/ready.json");
    const errorPath = resolve(home, "run/startup-error.json");
    const configured = Number(
        process.env.NOKORIBI_READY_TIMEOUT_MS?.trim() || "30000"
    );
    const timeoutMs =
        Number.isSafeInteger(configured) && configured >= 0
            ? configured
            : 30_000;
    const deadline = timeoutMs === 0 ? undefined : Date.now() + timeoutMs;
    for (;;) {
        try {
            const raw = await readFile(errorPath, "utf8");
            const value = JSON.parse(raw) as { message?: string };
            throw new Error(
                `daemon startup failed: ${value.message ?? "unknown"}`
            );
        } catch (error) {
            if (
                error instanceof Error &&
                error.message.startsWith("daemon startup failed")
            ) {
                throw error;
            }
        }
        try {
            const raw = await readFile(readyPath, "utf8");
            const value = JSON.parse(raw) as { pid?: number };
            if (value.pid === process.pid) return;
        } catch {
            // not ready yet
        }
        if (deadline !== undefined && Date.now() > deadline) {
            throw new Error(
                `daemon did not become ready within ${String(timeoutMs)}ms; ` +
                    "refusing to keep a half-started process"
            );
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
}

async function applyDevDefaults(launcherDir: string): Promise<void> {
    const candidates = [
        resolve(launcherDir, "../../SOUL.md"),
        resolve(launcherDir, "../share/SOUL.md"),
    ];
    if (process.env.NOKORIBI_SOUL_FILE === undefined) {
        for (const candidate of candidates) {
            try {
                await readFile(candidate);
                process.env.NOKORIBI_SOUL_FILE = candidate;
                break;
            } catch {
                // try next candidate
            }
        }
    }
    if (process.env.NOKORIBI_TEMPLATES_DIR === undefined) {
        const candidates = [
            resolve(launcherDir, "../../templates"),
            resolve(launcherDir, "../share/templates"),
        ];
        const { access } = await import("node:fs/promises");
        for (const candidate of candidates) {
            try {
                await access(candidate);
                process.env.NOKORIBI_TEMPLATES_DIR = candidate;
                break;
            } catch {
                // try next candidate
            }
        }
    }
}

main().catch((error: unknown) => {
    process.stderr.write(
        `nokoribi-agent: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
});
