import json
import sys

import yaml


def fail(message):
    raise SystemExit(message)


def row(document, row_id):
    for entry in document:
        if entry.get("id") == row_id:
            return entry.get("config", {})
    fail(f"missing overlay row {row_id}")
    return {}


def row_index(document, row_id):
    for index, entry in enumerate(document):
        if entry.get("id") == row_id:
            return index
    fail(f"missing overlay row {row_id}")
    return -1


def main():
    overlay_path, service_path, environment_path = sys.argv[1:4]
    with open(overlay_path, encoding="utf-8") as handle:
        overlay = yaml.safe_load(handle)
    with open(service_path, encoding="utf-8") as handle:
        service = json.load(handle)
    with open(environment_path, encoding="utf-8") as handle:
        environment = json.load(handle)

    if not isinstance(overlay, list):
        fail("overlay must be a list")

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

    local = row(overlay, "nokoribi-shell-host-local")
    if local.get("enabled") is not True:
        fail("local host must be enabled")
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


if __name__ == "__main__":
    main()
