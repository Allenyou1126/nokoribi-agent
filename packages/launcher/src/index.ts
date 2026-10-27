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
        "  NOKORIBI_QQ_BOT_RECONNECT_BASE_MS reconnect backoff base (1000)",
        "  NOKORIBI_QQ_BOT_RECONNECT_MAX_MS reconnect backoff cap (60000)",
        "  NOKORIBI_QQ_BOT_API_BASE     REST base URL override (test)",
        "  NOKORIBI_QQ_BOT_TOKEN_BASE   token base URL override (test)",
        "  NOKORIBI_QQ_BOT_GATEWAY_URL  gateway URL override (test)",
        "  NOKORIBI_REVIEW_FAST_MODEL   fast reviewer model (default: main model)",
        "  NOKORIBI_REVIEW_STRONG_MODEL strong reviewer model (default: fast model)",
        "  NOKORIBI_APPROVAL_TIMEOUT_MS approval timeout (default 60000)",
        "  NOKORIBI_QUESTION_TIMEOUT_MS question timeout (default 300000)",
        "  NOKORIBI_DEFAULT_HOST       default shell host (default sandbox:default)",
        "  NOKORIBI_LOCAL_EXTRA_PATH   colon-separated PATH additions for local host",
        "  NOKORIBI_SANDBOX_BASE_ENV   Nix buildEnv store path for the sandbox",
        "  NOKORIBI_SANDBOX_TTL_MS     sandbox idle TTL (default 1800000)",
        "  NOKORIBI_SANDBOX_SETPRIV    setpriv path/name for no_new_privs",
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
        dsh: { profile: { bundles: ["@nokoribi/bundle"] } },
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
