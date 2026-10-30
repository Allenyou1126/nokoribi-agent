import json
import sys

import yaml


def construct_js(loader, node):
    """Keep `!!js` expressions as a readable marker instead of failing."""
    return f"__js__{loader.construct_scalar(node)}"


yaml.SafeLoader.add_constructor("tag:yaml.org,2002:js", construct_js)


def fail(message):
    raise SystemExit(message)


def bundle_rows(bundle):
    if (
        not isinstance(bundle, list)
        or len(bundle) != 1
        or "insert" not in bundle[0]
        or not isinstance(bundle[0]["insert"], list)
    ):
        fail("bundle patch must be one insert list")
    return bundle[0]["insert"]


def expect_js(value, needle, label):
    """Assert a value is an evaluated-at-runtime JS expression with `needle`."""
    if not isinstance(value, str) or not value.startswith("__js__"):
        fail(f"{label} must be a !!js expression: {value!r}")
    if needle not in value:
        fail(f"{label} expression must mention {needle}: {value!r}")
    return value


def entry(document, row_id):
    for candidate in document:
        if candidate.get("id") == row_id:
            return candidate
    fail(f"missing overlay row {row_id}")
    return {}


def row(document, row_id):
    return entry(document, row_id).get("config", {})


def row_index(document, row_id):
    for index, candidate in enumerate(document):
        if candidate.get("id") == row_id:
            return index
    fail(f"missing overlay row {row_id}")
    return -1


def disabled_row(document, row_id):
    candidate = entry(document, row_id)
    if candidate.get("disabled") is not True:
        fail(f"overlay row {row_id} must be disabled")
    if "config" in candidate:
        fail(f"overlay row {row_id} must not keep a config when disabled")
    return candidate


def duplicate_ids(document):
    seen = set()
    duplicates = set()
    for candidate in document:
        row_id = candidate.get("id")
        if row_id in seen:
            duplicates.add(row_id)
        seen.add(row_id)
    return duplicates


def overlay_rows(document):
    """Flatten the overlay patch list, including id-less `insert` rows."""
    rows = []
    for candidate in document:
        if "insert" in candidate:
            rows.extend(candidate["insert"])
        else:
            rows.append(candidate)
    return rows


def check_bundle(bundle):
    rows = bundle_rows(bundle)
    ids = [candidate.get("id") for candidate in rows]
    for row_id in (
        "session-query",
        "tool-session-query",
        "skill",
        "skill-filesystem",
        "tool-skill",
        "mcp-resources",
        "nokoribi-memory",
        "nokoribi-prompt",
        "nokoribi-agent-app",
        "nokoribi-channel-qq-bot",
    ):
        if row_id not in ids:
            fail(f"bundle missing row {row_id}")

    resources = entry(rows, "mcp-resources")
    if resources.get("disabled") is not None:
        fail("bundle mcp-resources row must stay enabled")

    session_query = row(rows, "session-query")
    expect_js(
        session_query.get("path"),
        "dshHomePath('session-search.db')",
        "bundle session-query path",
    )
    expect_js(
        session_query.get("openAt"),
        "NOKORIBI_SESSION_SEARCH_ENABLED",
        "bundle session-query openAt",
    )

    tool_session_query = entry(rows, "tool-session-query")
    expect_js(
        tool_session_query.get("disabled"),
        "NOKORIBI_SESSION_SEARCH_ENABLED",
        "bundle tool-session-query disabled",
    )
    tool_session_query_config = tool_session_query.get("config", {})
    expect_js(
        tool_session_query_config.get("maxSearchResults"),
        "100",
        "bundle tool-session-query maxSearchResults",
    )
    expect_js(
        tool_session_query_config.get("searchTimeoutMs"),
        "30000",
        "bundle tool-session-query searchTimeoutMs",
    )

    for row_id in ("skill", "skill-filesystem", "tool-skill"):
        expect_js(
            entry(rows, row_id).get("disabled"),
            "NOKORIBI_SKILL_ENABLED",
            f"bundle {row_id} disabled",
        )
    skill_fs = row(rows, "skill-filesystem")
    if skill_fs.get("includeDefaultRoots") is not True:
        fail("bundle skill-filesystem includeDefaultRoots mismatch")
    if skill_fs.get("watch") is not True:
        fail("bundle skill-filesystem watch mismatch")
    expect_js(
        skill_fs.get("dshHome"), "DSH_HOME", "bundle skill-filesystem dshHome"
    )
    expect_js(
        skill_fs.get("customSkillDirs"),
        "NOKORIBI_SKILL_DIRS",
        "bundle skill-filesystem customSkillDirs",
    )
    expect_js(
        skill_fs.get("bundledSkillDir"),
        "NOKORIBI_BUNDLED_SKILLS",
        "bundle skill-filesystem bundledSkillDir",
    )
    expect_js(
        row(rows, "tool-skill").get("catalogDescriptionMaxLength"),
        "NOKORIBI_SKILL_DESCRIPTION_MAX",
        "bundle tool-skill catalogDescriptionMaxLength",
    )

    memory_row = row(rows, "nokoribi-memory")
    expect_js(memory_row.get("root"), "dshHomePath('memory')", "bundle memory root")
    inject = memory_row.get("inject", {})
    for key, env_name in (
        ("enable", "NOKORIBI_MEMORY_INJECT_ENABLED"),
        ("maxChars", "NOKORIBI_MEMORY_INJECT_MAX_CHARS"),
        ("maxEntries", "NOKORIBI_MEMORY_INJECT_MAX_ENTRIES"),
        ("mainOnly", "NOKORIBI_MEMORY_INJECT_MAIN_ONLY"),
        ("autoTags", "NOKORIBI_MEMORY_INJECT_AUTO_TAGS"),
    ):
        expect_js(inject.get(key), env_name, f"bundle memory inject.{key}")
    expect_js(
        entry(rows, "nokoribi-memory").get("disabled"),
        "NOKORIBI_MEMORY_ENABLED",
        "bundle memory disabled",
    )
    expect_js(
        row(rows, "nokoribi-prompt").get("memorySection"),
        "NOKORIBI_MEMORY_ENABLED",
        "bundle prompt memorySection",
    )
    agent = row(rows, "nokoribi-agent-app")
    expect_js(
        agent.get("memoryCurator"),
        "NOKORIBI_MEMORY_ENABLED",
        "bundle agent-app memoryCurator",
    )
    expect_js(
        agent.get("sendFileMaxBytes"),
        "NOKORIBI_SEND_FILE_MAX_BYTES",
        "bundle agent-app sendFileMaxBytes",
    )

    qq_bot = row(rows, "nokoribi-channel-qq-bot")
    for key, env_name in (
        ("inboundImages", "NOKORIBI_QQ_BOT_INBOUND_IMAGES"),
        ("inboundImageMaxBytes", "NOKORIBI_QQ_BOT_INBOUND_IMAGE_MAX_BYTES"),
        ("inboundImageTimeoutMs", "NOKORIBI_QQ_BOT_INBOUND_IMAGE_TIMEOUT_MS"),
        ("questionButtons", "NOKORIBI_QQ_BOT_QUESTION_BUTTONS"),
    ):
        expect_js(qq_bot.get(key), env_name, f"bundle QQ {key}")


def check_common(overlay, service, environment, bundle, unit):
    if not isinstance(overlay, list):
        fail("overlay must be a list")
    duplicates = duplicate_ids(overlay)
    if duplicates:
        fail(f"duplicate overlay rows: {sorted(duplicates)}")
    check_bundle(bundle)

    agent = row(overlay, "nokoribi-agent-app")
    if agent.get("provider") != "deepseek-official":
        fail("agent-app provider mismatch")
    if agent.get("model") != "deepseek-flash":
        fail("agent-app model mismatch")
    if agent.get("goalDefaultMaxRounds") != 256:
        fail("agent-app default goal rounds mismatch")
    if agent.get("goalModels") != ["deepseek-official/alt-model"]:
        fail("agent-app goal allowlist mismatch")
    if agent.get("workspace") != "/var/lib/nokoribi-agent/workspace":
        fail("agent-app workspace mismatch")
    if "reasoningEffort" in agent:
        fail("empty main effort must be omitted")

    reviewer = row(overlay, "nokoribi-reviewer")
    if reviewer["fast"]["provider"] != "deepseek-official":
        fail("fast reviewer fallback mismatch")
    if reviewer["strong"]["model"] != "deepseek-flash":
        fail("strong reviewer fallback mismatch")
    if reviewer.get("timeoutMs") != 30000:
        fail("reviewer timeout mismatch")
    if reviewer.get("exemptTools") != ["web_search", "web_fetch"]:
        fail("reviewer exemptTools mismatch")

    channel = row(overlay, "nokoribi-channel-local-test")
    if channel.get("enabled") is not True:
        fail("test channel must be enabled")
    if channel.get("token") != "test-token":
        fail("test channel token mismatch")
    if channel.get("host") != "127.0.0.1":
        fail("test channel bind mismatch")

    qq_bot = row(overlay, "nokoribi-channel-qq-bot")
    if qq_bot.get("enabled") is not True:
        fail("QQ bot channel must be enabled")
    expected_qq_bot = {
        "appId": "123456",
        "clientSecretEnv": "NOKORIBI_QQ_BOT_CLIENT_SECRET",
        "markdown": "basic",
        "maxTextLength": 4500,
        "maxRepliesPerReply": 4,
        "c2cReplyWindowSeconds": 3600,
        "groupReplyWindowSeconds": 300,
        "requestTimeoutMs": 10000,
        "connectTimeoutMs": 30000,
        "activeMessageFallback": "auto",
        "approvalButtons": True,
        "questionButtons": True,
        "inboundImages": True,
        "inboundImageMaxBytes": 10485760,
        "inboundImageTimeoutMs": 15000,
        "reconnectBaseMs": 1000,
        "reconnectMaxMs": 60000,
    }
    for key, value in expected_qq_bot.items():
        if qq_bot.get(key) != value:
            fail(f"QQ bot channel {key} mismatch: {qq_bot.get(key)!r}")
    if "clientSecret" in qq_bot:
        fail("QQ bot channel must not contain the client secret")
    for key in ("apiBaseUrl", "tokenBaseUrl", "gatewayUrl"):
        if key in qq_bot:
            fail(f"QQ bot channel must not contain the test override {key}")

    channel_core = row(overlay, "nokoribi-channel-core")
    if channel_core.get("trustedChannels") != ["qq-bot"]:
        fail("channel-core trustedChannels mismatch")
    if channel_core.get("defaultChannelId") != "local-test":
        fail("channel-core default channel mismatch")
    core_index = row_index(overlay, "nokoribi-channel-core")
    local_index = row_index(overlay, "nokoribi-channel-local-test")
    qq_index = row_index(overlay, "nokoribi-channel-qq-bot")
    if not core_index < local_index < qq_index:
        fail("channel rows must be ordered core, local-test, qq-bot")

    prompt = row(overlay, "nokoribi-prompt")
    if not prompt.get("soulFile", "").endswith("/share/SOUL.md"):
        fail("soul file mismatch")
    if not prompt.get("templatesDir", "").endswith("/share/templates"):
        fail("templates directory mismatch")

    if agent.get("sendFileMaxBytes") != 33554432:
        fail("agent-app sendFileMaxBytes mismatch")

    memory_row = row(overlay, "nokoribi-memory")
    if memory_row.get("root") != "/var/lib/nokoribi-agent/memory":
        fail("memory root mismatch")
    expected_inject = {
        "enable": True,
        "maxChars": 1500,
        "maxEntries": 5,
        "mainOnly": False,
        "autoTags": ["type:person"],
    }
    for key, value in expected_inject.items():
        if memory_row.get("inject", {}).get(key) != value:
            fail(f"memory inject.{key} mismatch: {memory_row.get('inject', {}).get(key)!r}")

    local = row(overlay, "nokoribi-shell-host-local")
    if local.get("enabled") is not True:
        fail("local host must be enabled")
    if local.get("terminalBashPath") != "bash":
        fail("local host terminal bash path mismatch")
    sandbox = row(overlay, "nokoribi-shell-host-sandbox")
    if sandbox.get("enabled") is not True:
        fail("sandbox host must be enabled")
    if not sandbox.get("baseEnvironment", "").startswith("/nix/store/"):
        fail("sandbox buildEnv missing")
    if sandbox.get("noNewPrivilegesCommand", "").endswith("/setpriv") is False:
        fail("setpriv path missing")

    time_context = row(overlay, "time-context")
    if time_context.get("timeZone") != "UTC":
        fail("time-context zone mismatch")

    expected_service = {
        "Type": "notify",
        "NotifyAccess": "all",
        "WatchdogSec": "120s",
        "TimeoutStopSec": "45s",
        "TimeoutStartSec": "300s",
        "KillMode": "mixed",
        "StateDirectory": "nokoribi-agent",
        "EnvironmentFile": ["/run/agenix/nokoribi-agent-env"],
    }
    for key, value in expected_service.items():
        if service.get(key) != value:
            fail(f"service {key} mismatch: {service.get(key)!r}")

    # U1: Type=notify needs a main process and a unit description; without
    # ExecStart the unit could never start.
    exec_start = service.get("ExecStart")
    if not isinstance(exec_start, str) or not exec_start.endswith(
        "/bin/nokoribi-agent"
    ):
        fail(f"service ExecStart must run the packaged daemon: {exec_start!r}")
    for expected_line in (
        "Description=Nokoribi Agent",
        f"ExecStart={exec_start}",
        "WantedBy=multi-user.target",
    ):
        if expected_line not in unit.splitlines():
            fail(f"unit must contain {expected_line!r}")

    if environment.get("DSH_HOME") != "/var/lib/nokoribi-agent":
        fail("DSH_HOME mismatch")
    if environment.get("HOME") != "/var/lib/nokoribi-agent/home":
        fail("HOME mismatch")
    if environment.get("NOKORIBI_READY_TIMEOUT_MS") != "0":
        fail("ready timeout mismatch")
    if not environment.get("NOKORIBI_SYSTEMD_NOTIFY", "").endswith("/systemd-notify"):
        fail("systemd-notify path missing")
    if not environment.get("NOKORIBI_PATCH", "").endswith(".yml"):
        fail("overlay path missing")


def check_enabled(overlay, environment, tmpfiles):
    sandbox_policy = row(overlay, "sandbox-policy")
    if sandbox_policy.get("mode") != "danger-full-access":
        fail("sandbox-policy mode mismatch")
    if sandbox_policy.get("workspaceRoot") != "/var/lib/nokoribi-agent/workspace":
        fail("sandbox-policy workspace root mismatch")

    terminal_host = row(overlay, "nokoribi-terminal-host")
    expected_terminal_host = {
        "enabled": True,
        "bashPath": "bash",
        "sendTimeoutMs": 30000,
        "rows": 40,
        "cols": 160,
        "scrollbackLines": 10000,
    }
    for key, value in expected_terminal_host.items():
        if terminal_host.get(key) != value:
            fail(f"terminal host {key} mismatch: {terminal_host.get(key)!r}")

    tool_terminal = row(overlay, "nokoribi-tool-terminal")
    if tool_terminal.get("enableRunInBackground") is not True:
        fail("tool-terminal run-in-background mismatch")
    if tool_terminal.get("maxResultBytes") != 262144:
        fail("tool-terminal maxResultBytes mismatch")

    web = row(overlay, "web")
    if web.get("searchProvider") != "deepseek-official":
        fail("web search provider mismatch")
    if web.get("fetchProvider") != "http":
        fail("web fetch provider mismatch")

    tool_web = row(overlay, "tool-web")
    expected_tool_web = {
        "search": True,
        "fetch": True,
        "searchMaxResults": 8,
        "searchMaxQueries": 4,
        "fetchTimeoutMs": 30000,
        "searchTimeoutMs": 30000,
        "fetchMaxOutputChars": 200000,
    }
    for key, value in expected_tool_web.items():
        if tool_web.get(key) != value:
            fail(f"tool-web {key} mismatch: {tool_web.get(key)!r}")

    if environment.get("DEEPSEEK_SEARCH_BASE_URL") != "https://search.example.invalid/v1":
        fail("DEEPSEEK_SEARCH_BASE_URL mismatch")

    # M11: enabled session search opens the dedicated FTS index on first search
    # and exposes the tools with the configured caps.
    session_query = row(overlay, "session-query")
    if session_query.get("path") != "/var/lib/nokoribi-agent/session-search.db":
        fail("session-query path mismatch")
    if session_query.get("openAt") != "first-search":
        fail("session-query openAt mismatch")
    tool_session_query = row(overlay, "tool-session-query")
    if tool_session_query.get("maxSearchResults") != 50:
        fail("tool-session-query maxSearchResults mismatch")
    if tool_session_query.get("searchTimeoutMs") != 20000:
        fail("tool-session-query searchTimeoutMs mismatch")

    # M12: skill rows are configured from the option values.
    skill_fs = row(overlay, "skill-filesystem")
    expected_skill_fs = {
        "includeDefaultRoots": True,
        "dshHome": "/var/lib/nokoribi-agent",
        "customSkillDirs": ["/run/skills/extra"],
        "watch": True,
    }
    for key, value in expected_skill_fs.items():
        if skill_fs.get(key) != value:
            fail(f"skill-filesystem {key} mismatch: {skill_fs.get(key)!r}")
    if not skill_fs.get("bundledSkillDir", "").endswith("/share/skills"):
        fail("skill-filesystem bundledSkillDir mismatch")
    if row(overlay, "tool-skill").get("catalogDescriptionMaxLength") != 320:
        fail("tool-skill catalogDescriptionMaxLength mismatch")

    # M13: one generated client row per server, including the secret
    # indirections and the reconnect field rename.
    rows = overlay_rows(overlay)
    mcp_ids = [
        candidate.get("id")
        for candidate in rows
        if str(candidate.get("id", "")).startswith("mcp-")
    ]
    if mcp_ids != ["mcp-github", "mcp-web"]:
        fail(f"mcp row ids mismatch: {mcp_ids!r}")
    github = row(rows, "mcp-github")
    expected_github = {
        "serverName": "github",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "toolCallTimeoutMs": 10000,
        "maxInstructionBytes": 32768,
        "failOnStartupError": True,
        "reconnect": {
            "enabled": True,
            "initialDelayMs": 500,
            "maxDelayMs": 30000,
            "maxAttempts": 10,
        },
        "env": {"GITHUB_TOKEN": "__js__process.env.GITHUB_TOKEN"},
    }
    for key, value in expected_github.items():
        if github.get(key) != value:
            fail(f"mcp-github {key} mismatch: {github.get(key)!r}")
    if "cwd" in github:
        fail("mcp-github must omit cwd when it is null")
    web = row(rows, "mcp-web")
    expected_web = {
        "serverName": "web",
        "transport": "streamable-http",
        "url": "http://127.0.0.1:3000/mcp",
        "toolCallTimeoutMs": 60000,
        "maxInstructionBytes": 16384,
        "failOnStartupError": False,
        "reconnect": {
            "enabled": False,
            "initialDelayMs": 250,
            "maxDelayMs": 1000,
            "maxAttempts": 2,
        },
        "headers": {"Authorization": "__js__process.env.MCP_AUTH_HEADER"},
    }
    for key, value in expected_web.items():
        if web.get(key) != value:
            fail(f"mcp-web {key} mismatch: {web.get(key)!r}")
    if "command" in web:
        fail("mcp-web must omit command for the streamable-http transport")
    if row(overlay, "nokoribi-prompt").get("memorySection") is not True:
        fail("prompt memorySection must default to true")
    if row(overlay, "nokoribi-agent-app").get("memoryCurator") is not True:
        fail("agent-app memoryCurator must default to true")

    for key in (
        "NOKORIBI_OPENVIKING_ENABLED",
        "NOKORIBI_MEMORY_ENABLED",
        "OPENVIKING_STATE_DIR",
    ):
        if key in environment:
            fail(f"{key} must be absent when OpenViking is disabled")
    if any("openviking-state" in rule for rule in tmpfiles):
        fail("openviking state dir rule must be absent when OpenViking is disabled")


def check_disabled(overlay, environment, tmpfiles):
    for row_id in (
        "sandbox-policy",
        "terminal",
        "nokoribi-terminal-host",
        "nokoribi-tool-terminal",
        "web",
        "web-search-deepseek",
        "web-fetch-http",
        "web-deepseek-api",
        "tool-web",
        "tool-session-query",
        "skill",
        "skill-filesystem",
        "tool-skill",
    ):
        disabled_row(overlay, row_id)

    # bash(host) keeps working when the terminal rows are off.
    local = row(overlay, "nokoribi-shell-host-local")
    if local.get("enabled") is not True:
        fail("local host must stay enabled when terminals are disabled")

    if "DEEPSEEK_SEARCH_BASE_URL" in environment:
        fail("DEEPSEEK_SEARCH_BASE_URL must be omitted when web.deepseekSearchBaseUrl is null")

    session_query = row(overlay, "session-query")
    if session_query.get("openAt") != "never":
        fail("session-query openAt must be never when session search is disabled")
    rows = overlay_rows(overlay)
    if any(str(candidate.get("id", "")).startswith("mcp-") for candidate in rows):
        fail("no mcp client rows may be generated for an empty mcp.servers list")
    if row(overlay, "nokoribi-prompt").get("memorySection") is not True:
        fail("prompt memorySection must stay true when OpenViking is disabled")
    if row(overlay, "nokoribi-agent-app").get("memoryCurator") is not True:
        fail("agent-app memoryCurator must stay true when OpenViking is disabled")
    for key in (
        "NOKORIBI_OPENVIKING_ENABLED",
        "NOKORIBI_MEMORY_ENABLED",
        "OPENVIKING_STATE_DIR",
    ):
        if key in environment:
            fail(f"{key} must be absent when OpenViking is disabled")


def check_openviking(overlay, environment, tmpfiles):
    expected_environment = {
        "NOKORIBI_OPENVIKING_ENABLED": "true",
        "NOKORIBI_MEMORY_ENABLED": "false",
        "NOKORIBI_OPENVIKING_API_KEY_ENV": "OPENVIKING_API_KEY",
        "NOKORIBI_OPENVIKING_ENDPOINT": "https://openviking.example.invalid",
        "NOKORIBI_OPENVIKING_PEER_ID": "peer-a",
        "NOKORIBI_OPENVIKING_WORKSPACE_PEER": "0",
        "NOKORIBI_OPENVIKING_RECALL_MAX_TOKENS": "4000",
        "OPENVIKING_STATE_DIR": "/var/lib/nokoribi-agent/openviking-state",
    }
    for key, value in expected_environment.items():
        if environment.get(key) != value:
            fail(f"OpenViking environment {key} mismatch: {environment.get(key)!r}")

    memory_row = entry(overlay, "nokoribi-memory")
    if memory_row.get("disabled") is True:
        fail("local memory row must stay enabled in the overlay; the env switch owns the M17 toggle")
    if row(overlay, "nokoribi-prompt").get("memorySection") is not False:
        fail("prompt memorySection must be false when OpenViking is enabled")
    if row(overlay, "nokoribi-agent-app").get("memoryCurator") is not False:
        fail("agent-app memoryCurator must be false when OpenViking is enabled")
    if not any("openviking-state" in rule for rule in tmpfiles):
        fail("openviking state dir tmpfiles rule missing")


def check_single_mcp(overlay):
    rows = overlay_rows(overlay)
    mcp_ids = [
        candidate.get("id")
        for candidate in rows
        if str(candidate.get("id", "")).startswith("mcp-")
    ]
    if mcp_ids != ["mcp-solo"]:
        fail(f"single mcp row mismatch: {mcp_ids!r}")
    config = row(rows, "mcp-solo")
    expected = {
        "serverName": "solo",
        "transport": "stdio",
        "command": "solo-mcp",
        "args": [],
        "env": {},
        "toolCallTimeoutMs": 60000,
        "maxInstructionBytes": 32768,
        "failOnStartupError": False,
        "reconnect": {
            "enabled": True,
            "initialDelayMs": 500,
            "maxDelayMs": 30000,
            "maxAttempts": 10,
        },
    }
    for key, value in expected.items():
        if config.get(key) != value:
            fail(f"mcp-solo {key} mismatch: {config.get(key)!r}")
    if "cwd" in config:
        fail("mcp-solo must omit cwd when it is null")


def main():
    mode = "enabled"
    paths = []
    for argument in sys.argv[1:]:
        if argument == "--disabled":
            mode = "disabled"
        elif argument == "--openviking":
            mode = "openviking"
        elif argument == "--mcp-single":
            mode = "mcp-single"
        elif argument.startswith("-"):
            fail(f"unknown option {argument}")
        else:
            paths.append(argument)
    if len(paths) != 6:
        fail(
            "usage: check-module.py [--disabled|--openviking|--mcp-single] "
            "OVERLAY SERVICE ENVIRONMENT TMPFILES BUNDLE UNIT"
        )
    (
        overlay_path,
        service_path,
        environment_path,
        tmpfiles_path,
        bundle_path,
        unit_path,
    ) = paths
    with open(overlay_path, encoding="utf-8") as handle:
        overlay = yaml.safe_load(handle)
    with open(service_path, encoding="utf-8") as handle:
        service = json.load(handle)
    with open(environment_path, encoding="utf-8") as handle:
        environment = json.load(handle)
    with open(tmpfiles_path, encoding="utf-8") as handle:
        tmpfiles = json.load(handle)
    with open(bundle_path, encoding="utf-8") as handle:
        bundle = yaml.safe_load(handle)
    with open(unit_path, encoding="utf-8") as handle:
        unit = handle.read()

    check_common(overlay, service, environment, bundle, unit)
    if mode == "disabled":
        check_disabled(overlay, environment, tmpfiles)
    elif mode == "openviking":
        check_openviking(overlay, environment, tmpfiles)
    elif mode == "mcp-single":
        check_single_mcp(overlay)
    else:
        check_enabled(overlay, environment, tmpfiles)


if __name__ == "__main__":
    main()
