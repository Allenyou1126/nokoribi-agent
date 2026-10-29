{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types;

  cfg = config.services.nokoribi-agent;

  routeOr = route: fallback: {
    provider =
      if route.provider == null then fallback.provider else route.provider;
    model = if route.model == null then fallback.model else route.model;
    reasoningEffort =
      if route.reasoningEffort == "" then
        fallback.reasoningEffort
      else
        route.reasoningEffort;
  };

  mainRoute = cfg.models.main;
  fastRoute = routeOr cfg.review.fast mainRoute;
  strongRoute = routeOr cfg.review.strong fastRoute;
  goalRoute = routeOr cfg.goal mainRoute;
  memoryRoute = routeOr cfg.memory goalRoute;

  workspace =
    if cfg.workspace == null then "${cfg.dshHome}/workspace"
    else cfg.workspace;
  soulFile =
    if cfg.prompt.soulFile == null then "${cfg.package}/share/SOUL.md"
    else cfg.prompt.soulFile;
  templatesDir =
    if cfg.prompt.templatesDir == null then "${cfg.package}/share/templates"
    else cfg.prompt.templatesDir;

  # M12: bundled read-only skill root shipped in the package (share/skills).
  bundledSkillsDir =
    if cfg.skill.bundledDir == null then "${cfg.package}/share/skills"
    else cfg.skill.bundledDir;

  openViking = cfg.memory.openviking;

  mcpServerNames = map (server: server.name) cfg.mcp.servers;
  mcpNameOk = name: builtins.match "[A-Za-z0-9_-]{1,32}" name != null;
  mcpEnvNameOk = name: builtins.match "[A-Za-z_][A-Za-z0-9_]*" name != null;
  mcpSecretsOk = server:
    lib.all mcpEnvNameOk (lib.attrValues server.env)
    && lib.all mcpEnvNameOk (lib.attrValues server.headers);

  sandboxEnv =
    if cfg.hosts.sandbox.enable then
      pkgs.buildEnv {
        name = "nokoribi-sandbox";
        paths = [ pkgs.bashInteractive pkgs.coreutils ] ++ cfg.hosts.sandbox.packages;
        ignoreCollisions = true;
      }
    else
      null;
  sandboxBaseEnvironment =
    if sandboxEnv == null then "" else toString sandboxEnv;
  sandboxRoot = "${cfg.dshHome}/sandboxes";
  localExtraPackages = map (package: "${package}/bin") cfg.hosts.local.extraPackages;
  nixBinary = "${config.nix.package}/bin/nix";
  setpriv = "${pkgs.util-linux}/bin/setpriv";
  timeZone =
    if cfg.time.zone != null then cfg.time.zone else config.time.timeZone;

  overlayPatches = import ./overlay.nix {
    inherit lib cfg;
    inherit mainRoute fastRoute strongRoute goalRoute memoryRoute;
    inherit workspace soulFile templatesDir sandboxBaseEnvironment sandboxRoot;
    inherit localExtraPackages nixBinary setpriv timeZone bundledSkillsDir;
  };
  rawOverlayText = lib.generators.toYAML { } overlayPatches;

  # M13: MCP server env/header values are environment-variable indirections.
  # overlay.nix renders each as the plain scalar marker
  # `__nokoribi_js_process_env_<NAME>__` so the generated YAML stays valid;
  # here the quoted marker becomes the app-boot `!!js` expression that reads
  # the variable at daemon start, so no secret value enters the Nix store.
  overlayText =
    lib.concatMapStrings
      (part:
        if builtins.isString part then
          part
        else
          "!!js process.env.${builtins.elemAt part 0}")
      (builtins.split
        "\"__nokoribi_js_process_env_([A-Za-z_][A-Za-z0-9_]*)__\""
        rawOverlayText);
  overlayFile = pkgs.writeText "nokoribi-cordis.patch.yml" overlayText;

  stateDirectory =
    if cfg.dshHome == "/var/lib/nokoribi-agent" then "nokoribi-agent" else null;

  servicePath = lib.makeBinPath [
    pkgs.bashInteractive
    pkgs.coreutils
    pkgs.util-linux
    config.nix.package
    pkgs.systemd
  ] + ":/run/wrappers/bin:/run/current-system/sw/bin";

  serviceEnvironment = {
    DSH_HOME = cfg.dshHome;
    HOME = "${cfg.dshHome}/home";
    PATH = lib.mkForce servicePath;
    NODE_ENV = "production";
    NOKORIBI_PATCH = toString overlayFile;
    NOKORIBI_SYSTEMD_NOTIFY = "${pkgs.systemd}/bin/systemd-notify";
    NOKORIBI_READY_TIMEOUT_MS = "0";
    NOKORIBI_LOG_LEVEL = cfg.log.level;
  } // lib.optionalAttrs (timeZone != null) {
    TZ = timeZone;
  } // lib.optionalAttrs (cfg.web.deepseekSearchBaseUrl != null) {
    DEEPSEEK_SEARCH_BASE_URL = cfg.web.deepseekSearchBaseUrl;
  } // lib.optionalAttrs openViking.enable {
    # M17: the launcher mounts the OpenViking bundle and maps these names to
    # the plugin's OPENVIKING_* credential chain. Local memory is switched off
    # through the env switch; the overlay keeps the local rows complete.
    NOKORIBI_OPENVIKING_ENABLED = "true";
    NOKORIBI_MEMORY_ENABLED = "false";
    NOKORIBI_OPENVIKING_API_KEY_ENV = openViking.apiKeyEnv;
    OPENVIKING_STATE_DIR = "${cfg.dshHome}/openviking-state";
  } // lib.optionalAttrs (openViking.enable && openViking.endpoint != null) {
    NOKORIBI_OPENVIKING_ENDPOINT = openViking.endpoint;
  } // lib.optionalAttrs (openViking.enable && openViking.peerId != null) {
    NOKORIBI_OPENVIKING_PEER_ID = openViking.peerId;
  } // lib.optionalAttrs (openViking.enable && openViking.workspacePeer != null) {
    NOKORIBI_OPENVIKING_WORKSPACE_PEER = openViking.workspacePeer;
  } // lib.optionalAttrs (openViking.enable && openViking.recallMaxTokens != null) {
    NOKORIBI_OPENVIKING_RECALL_MAX_TOKENS = toString openViking.recallMaxTokens;
  };

  routePairOk = route:
    (route.provider == null) == (route.model == null);
  allowedModelOk = value: builtins.match "[^/[:space:]]+/[^/[:space:]]+" value != null;
in
{
  options.services.nokoribi-agent = {
    enable = mkEnableOption "Nokoribi Agent daemon";

    package = mkOption {
      type = types.package;
      default = pkgs.nokoribi-agent;
      description = "Nokoribi Agent package to run.";
    };

    user = mkOption {
      type = types.str;
      default = "nokoribi";
      description = "Dedicated service user.";
    };

    group = mkOption {
      type = types.str;
      default = "nokoribi";
      description = "Dedicated service group.";
    };

    dshHome = mkOption {
      type = types.str;
      default = "/var/lib/nokoribi-agent";
      description = "Persistent DSH_HOME and state root.";
    };

    workspace = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Persistent workspace; defaults to ${cfg.dshHome}/workspace.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "systemd EnvironmentFile (for example an agenix secret path).";
    };

    models.main = {
      provider = mkOption {
        type = types.str;
        default = "deepseek-official";
        description = "Main agent provider.";
      };
      model = mkOption {
        type = types.str;
        default = "deepseek-flash";
        description = "Main agent model; must support images when image input is enabled.";
      };
      reasoningEffort = mkOption {
        type = types.str;
        default = "";
        description = "Main agent adapter reasoning effort; empty uses the adapter default.";
      };
    };

    review.fast = {
      provider = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Fast reviewer provider; null reuses the main provider.";
      };
      model = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Fast reviewer model; null reuses the main model.";
      };
      reasoningEffort = mkOption {
        type = types.str;
        default = "";
        description = "Fast reviewer effort; empty uses the main effort or adapter default.";
      };
    };

    review.strong = {
      provider = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Strong reviewer provider; null reuses the fast route.";
      };
      model = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Strong reviewer model; null reuses the fast route.";
      };
      reasoningEffort = mkOption {
        type = types.str;
        default = "";
        description = "Strong reviewer effort; empty reuses the fast effort or adapter default.";
      };
    };

    review.timeoutMs = mkOption {
      type = types.ints.positive;
      default = 30000;
      description = "Per-reviewer-call deadline in milliseconds.";
    };

    review.exemptTools = mkOption {
      type = types.listOf types.str;
      default = [
        "web_search"
        "web_fetch"
      ];
      description = "Tool names exempt from Auto review under the danger-full-access preset (D170); the empty list restores full review.";
    };

    goal.provider = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Default goal child provider; null reuses the main route.";
    };
    goal.model = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Default goal child model; null reuses the main route.";
    };
    goal.reasoningEffort = mkOption {
      type = types.str;
      default = "";
      description = "Default goal child effort; empty reuses the main effort.";
    };
    goal.allowedModels = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Exact provider/model routes selectable by start_goal or /goal new.";
    };
    goal.maxRounds = mkOption {
      type = types.ints.positive;
      default = 256;
      description = "Round cap used when a goal omits max_goal_rounds.";
    };
    goal.recoveryTimeoutMs = mkOption {
      type = types.ints.positive;
      default = 30000;
      description = "Bound for one cold goal recovery.";
    };

    memory.provider = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Memory curator provider; null reuses the goal route.";
    };
    memory.model = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Memory curator model; null reuses the goal route.";
    };
    memory.reasoningEffort = mkOption {
      type = types.str;
      default = "";
      description = "Memory curator effort; empty reuses the goal effort.";
    };
    memory.curator.enable = mkOption {
      type = types.bool;
      default = true;
      description = "Run best-effort extraction after terminal goals.";
    };
    memory.curator.timeoutMs = mkOption {
      type = types.ints.positive;
      default = 60000;
      description = "Bound for one memory curator run.";
    };
    memory.inject.enable = mkOption {
      type = types.bool;
      default = true;
      description = "Inject the pinned memory snapshot as a runtime context for the main session (M16).";
    };
    memory.inject.maxChars = mkOption {
      type = types.ints.positive;
      default = 3000;
      description = "Snapshot character budget; pinned and auto-included entries beyond it are replaced by a footer hint.";
    };
    memory.inject.maxEntries = mkOption {
      type = types.ints.positive;
      default = 20;
      description = "Maximum entries rendered in one memory snapshot.";
    };
    memory.inject.mainOnly = mkOption {
      type = types.bool;
      default = true;
      description = "Inject the snapshot only for the main session; goal children get no memory snapshot.";
    };
    memory.inject.autoTags = mkOption {
      type = types.listOf types.str;
      default = [
        "type:person"
        "type:preference"
      ];
      description = "Tags that opt an entry into the snapshot without an explicit pin.";
    };
    memory.openviking.enable = mkOption {
      type = types.bool;
      default = false;
      description = "Use the OpenViking backend for memory; enabled switches local memory and the curator off (M17, D175).";
    };
    memory.openviking.endpoint = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "OpenViking server URL; required when memory.openviking.enable is true.";
    };
    memory.openviking.apiKeyEnv = mkOption {
      type = types.str;
      default = "OPENVIKING_API_KEY";
      description = "Environment variable holding the OpenViking bearer key (EnvironmentFile/agenix); the name only enters the Nix store.";
    };
    memory.openviking.peerId = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Explicit OpenViking actor peer; null lets the plugin derive it.";
    };
    memory.openviking.workspacePeer = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Workspace-derived peer identity; the literal \"0\" disables derivation.";
    };
    memory.openviking.recallMaxTokens = mkOption {
      type = types.nullOr types.ints.positive;
      default = null;
      description = "Server-assembled recall token budget; null keeps the plugin default.";
    };

    approval.approvalTimeoutSeconds = mkOption {
      type = types.ints.positive;
      default = 60;
      description = "Approval prompt timeout.";
    };
    approval.questionTimeoutSeconds = mkOption {
      type = types.ints.positive;
      default = 300;
      description = "Question prompt timeout.";
    };

    hosts.default = mkOption {
      type = types.enum [ "sandbox:default" "local:workspace" ];
      default = "sandbox:default";
      description = "Default shell host.";
    };
    hosts.local.enable = mkOption {
      type = types.bool;
      default = true;
      description = "Register local:workspace.";
    };
    hosts.local.extraPackages = mkOption {
      type = types.listOf types.package;
      default = [ ];
      description = "Packages whose bin directories are prepended to the local PATH.";
    };
    hosts.sandbox.enable = mkOption {
      type = types.bool;
      default = true;
      description = "Register sandbox:default and its tools.";
    };
    hosts.sandbox.packages = mkOption {
      type = types.listOf types.package;
      default = [ ];
      description = "Base packages for the sandbox buildEnv; bash/coreutils are always included.";
    };
    hosts.sandbox.shellHook = mkOption {
      type = types.str;
      default = "";
      description = "Trusted shellHook evaluated before each sandbox command.";
    };
    hosts.sandbox.idleTtlMinutes = mkOption {
      type = types.ints.positive;
      default = 30;
      description = "Idle time before a sandbox is reclaimed.";
    };
    hosts.sandbox.allowRuntimePackages = mkOption {
      type = types.bool;
      default = true;
      description = "Allow sandbox_packages to realize runtime packages.";
    };

    channel.localTest = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Enable the loopback HTTP test channel.";
      };
      bind = mkOption {
        type = types.str;
        default = "127.0.0.1";
        description = "Loopback bind address.";
      };
      port = mkOption {
        type = types.port;
        default = 8787;
        description = "Loopback test-channel port.";
      };
      token = mkOption {
        type = types.str;
        default = "";
        description = "Test-channel bearer token; stored in the Nix store when enabled.";
      };
    };

    channel.qqBot = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Register the QQ official bot channel.";
      };
      appId = mkOption {
        type = types.str;
        default = "";
        description = "QQ Bot AppID; non-secret and stored in the Nix store.";
      };
      clientSecretEnv = mkOption {
        type = types.str;
        default = "NOKORIBI_QQ_BOT_CLIENT_SECRET";
        description = "Environment variable holding the client secret; the value comes from environmentFile/agenix.";
      };
      markdown = mkOption {
        type = types.enum [ "none" "basic" "full" ];
        default = "basic";
        description = "Markdown capability advertised to the model.";
      };
      maxTextLength = mkOption {
        type = types.ints.positive;
        default = 4500;
        description = "Per-chunk text limit for outbound replies.";
      };
      maxRepliesPerReply = mkOption {
        type = types.ints.positive;
        default = 4;
        description = "Maximum passive replies per inbound message.";
      };
      c2cReplyWindowSeconds = mkOption {
        type = types.ints.positive;
        default = 3600;
        description = "Passive reply window for C2C chats.";
      };
      groupReplyWindowSeconds = mkOption {
        type = types.ints.positive;
        default = 300;
        description = "Passive reply window for group chats.";
      };
      requestTimeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 10;
        description = "REST request timeout; the overlay renders it in milliseconds.";
      };
      connectTimeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 30;
        description = "Initial gateway connect wait before background reconnects.";
      };
      activeMessageFallback = mkOption {
        type = types.enum [ "auto" "off" ];
        default = "auto";
        description = "Whether to attempt active messages when passive delivery is unavailable.";
      };
      approvalButtons = mkOption {
        type = types.bool;
        default = true;
        description = "Render C2C approval buttons and subscribe to INTERACTION_CREATE; false keeps text-only approvals.";
      };
      reconnectBaseMs = mkOption {
        type = types.ints.positive;
        default = 1000;
        description = "Gateway reconnect backoff base in milliseconds.";
      };
      reconnectMaxMs = mkOption {
        type = types.ints.positive;
        default = 60000;
        description = "Gateway reconnect backoff cap in milliseconds.";
      };
      questionButtons = mkOption {
        type = types.bool;
        default = true;
        description = "Render C2C buttons for single-select ask_user_question options (M15); false keeps text-only questions.";
      };
      inboundImages = mkOption {
        type = types.bool;
        default = true;
        description = "Download and forward image attachments from inbound C2C/group messages (M14); false keeps the text-only path.";
      };
      inboundImageMaxBytes = mkOption {
        type = types.ints.positive;
        default = 10485760;
        description = "Maximum bytes of one downloaded inbound image (M14).";
      };
      inboundImageTimeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 15;
        description = "Inbound image download deadline in seconds (M14); the overlay renders it in milliseconds.";
      };
    };

    sendFile.maxBytes = mkOption {
      type = types.ints.positive;
      default = 33554432;
      description = "Maximum bytes of one file attached by the agent's send_to_user tool (M14).";
    };

    terminal = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Register host-aware persistent terminals (M10); false disables the terminal rows in the overlay.";
      };
      bashPath = mkOption {
        type = types.str;
        default = "bash";
        description = "Shell used by local:workspace terminals; the sandbox terminal ignores it.";
      };
      maxResultBytes = mkOption {
        type = types.ints.positive;
        default = 262144;
        description = "Maximum bytes returned by one terminal read or send.";
      };
      sendTimeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 30;
        description = "Foreground terminal send wait; the overlay renders it in milliseconds.";
      };
      rows = mkOption {
        type = types.ints.positive;
        default = 40;
        description = "Initial PTY rows.";
      };
      cols = mkOption {
        type = types.ints.positive;
        default = 160;
        description = "Initial PTY columns.";
      };
      scrollbackLines = mkOption {
        type = types.ints.positive;
        default = 10000;
        description = "Scrollback lines retained per terminal.";
      };
    };

    web = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Register web_search/web_fetch (M10); false disables the web rows in the overlay.";
      };
      searchProvider = mkOption {
        type = types.enum [
          "deepseek-official"
          "deepseek-search-api"
        ];
        default = "deepseek-official";
        description = "Pinned ctx.web search provider.";
      };
      fetchProvider = mkOption {
        type = types.enum [
          "http"
          "deepseek-fetch-api"
        ];
        default = "http";
        description = "Pinned ctx.web fetch provider.";
      };
      deepseekSearchBaseUrl = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "DEEPSEEK_SEARCH_BASE_URL for the DeepSeek search provider; null keeps the provider default.";
      };
      searchMaxResults = mkOption {
        type = types.ints.positive;
        default = 8;
        description = "Maximum search results per query.";
      };
      searchMaxQueries = mkOption {
        type = types.ints.positive;
        default = 4;
        description = "Maximum queries per web_search call.";
      };
      fetchTimeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 30;
        description = "web_fetch deadline; the overlay renders it in milliseconds.";
      };
      searchTimeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 30;
        description = "web_search deadline; the overlay renders it in milliseconds.";
      };
      fetchMaxOutputChars = mkOption {
        type = types.ints.positive;
        default = 200000;
        description = "Maximum characters returned by one fetch.";
      };
    };

    sessionSearch = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Register the session-history search tools (M11) and open the FTS index; false keeps exact session reads only.";
      };
      maxResults = mkOption {
        type = types.ints.positive;
        default = 100;
        description = "Maximum authorized hits returned by one session search.";
      };
      searchTimeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 30;
        description = "Cooperative session-search deadline; the overlay renders it in milliseconds.";
      };
    };

    skill = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Register the local skill registry, filesystem provider and skill tool (M12); false hides the catalog and tool.";
      };
      customDirs = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Additional read-only skill roots scanned after project roots and before $DSH_HOME/skills.";
      };
      bundledDir = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Bundled skill root; null uses the package's read-only share/skills directory.";
      };
      catalogDescriptionMaxLength = mkOption {
        type = types.ints.positive;
        default = 500;
        description = "Maximum normalized skill description length rendered in the model catalog.";
      };
    };

    mcp.servers = mkOption {
      type = types.listOf (types.submodule {
        options = {
          name = mkOption {
            type = types.str;
            default = "";
            description = "Stable server namespace for mcp__<name>__<tool> tool names ([A-Za-z0-9_-]{1,32}, unique).";
          };
          transport = mkOption {
            type = types.enum [
              "stdio"
              "streamable-http"
            ];
            default = "stdio";
            description = "MCP transport; stdio spawns command, streamable-http connects to url.";
          };
          command = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Executable started for the stdio transport.";
          };
          args = mkOption {
            type = types.listOf types.str;
            default = [ ];
            description = "Arguments passed directly to the stdio executable.";
          };
          env = mkOption {
            type = types.attrsOf types.str;
            default = { };
            description = "Extra stdio environment; each VALUE is the name of an environment variable, never the secret itself.";
          };
          cwd = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Working directory for the stdio child process.";
          };
          url = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "MCP endpoint URL for the streamable-http transport.";
          };
          headers = mkOption {
            type = types.attrsOf types.str;
            default = { };
            description = "Extra streamable-http request headers; each VALUE is the name of an environment variable, never the secret itself.";
          };
          toolCallTimeoutSeconds = mkOption {
            type = types.ints.positive;
            default = 60;
            description = "Per-call MCP tool/resource deadline; the overlay renders it in milliseconds.";
          };
          maxInstructionBytes = mkOption {
            type = types.ints.positive;
            default = 32768;
            description = "Maximum UTF-8 bytes of server instructions included in the prompt.";
          };
          failOnStartupError = mkOption {
            type = types.bool;
            default = false;
            description = "Fail this row's activation when the initial MCP connection or tool sync fails.";
          };
          reconnect = {
            enable = mkOption {
              type = types.bool;
              default = true;
              description = "Reconnect automatically after a lost MCP connection.";
            };
            initialDelayMs = mkOption {
              type = types.ints.positive;
              default = 500;
              description = "First reconnect delay in milliseconds; doubles per consecutive failed attempt.";
            };
            maxDelayMs = mkOption {
              type = types.ints.positive;
              default = 30000;
              description = "Reconnect backoff ceiling and attempt-budget reset uptime in milliseconds.";
            };
            maxAttempts = mkOption {
              type = types.ints.positive;
              default = 10;
              description = "Consecutive failed reconnect attempts before the server's tools are removed.";
            };
          };
        };
      });
      default = [ ];
      description = "External MCP servers; each entry generates one mcp-client row with id mcp-<name>.";
    };

    prompt.soulFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Persona file; defaults to the packaged SOUL.md.";
    };
    prompt.templatesDir = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "AGENTS.md template directory; defaults to the packaged templates.";
    };
    prompt.seedAgentsMd = mkOption {
      type = types.bool;
      default = true;
      description = "Seed global and workspace AGENTS.md when absent.";
    };

    time.zone = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Time-context zone; null uses the system zone.";
    };
    time.contextRefreshSeconds = mkOption {
      type = types.ints.positive;
      default = 60;
      description = "Minimum interval between time-context refreshes.";
    };

    log.level = mkOption {
      type = types.enum [ "debug" "info" "warn" "error" ];
      default = "info";
      description = "Structured log threshold.";
    };

    sudo.enable = mkOption {
      type = types.bool;
      default = false;
      description = "Grant the service user NOPASSWD: ALL; use only with the reviewer boundary.";
    };

    watchdog.intervalSeconds = mkOption {
      type = types.ints.positive;
      default = 120;
      description = "systemd WatchdogSec and notifier heartbeat budget.";
    };

    shutdown.graceSeconds = mkOption {
      type = types.ints.positive;
      default = 20;
      description = "Agent turn grace before cancellation.";
    };
    shutdown.stopTimeoutSeconds = mkOption {
      type = types.ints.positive;
      default = 45;
      description = "systemd TimeoutStopSec.";
    };
    shutdown.startTimeoutSeconds = mkOption {
      type = types.ints.positive;
      default = 300;
      description = "systemd TimeoutStartSec; cold goal recovery can be slow.";
    };

    _overlayText = mkOption {
      type = types.str;
      default = "";
      internal = true;
      description = "Rendered Cordis overlay, exposed for flake checks.";
    };
  };

  config = {
    assertions = [
      {
        assertion = !cfg.enable || cfg.environmentFile != null;
        message = "services.nokoribi-agent.environmentFile is required when the service is enabled.";
      }
      {
        assertion = !cfg.enable || cfg.models.main.provider != "" && cfg.models.main.model != "";
        message = "services.nokoribi-agent.models.main.provider/model must not be empty.";
      }
      {
        assertion = !cfg.enable || cfg.hosts.local.enable || cfg.hosts.sandbox.enable;
        message = "At least one of hosts.local.enable or hosts.sandbox.enable must be true.";
      }
      {
        assertion = !cfg.enable || cfg.hosts.default != "local:workspace" || cfg.hosts.local.enable;
        message = "hosts.default local:workspace requires hosts.local.enable = true.";
      }
      {
        assertion = !cfg.enable || cfg.hosts.default != "sandbox:default" || cfg.hosts.sandbox.enable;
        message = "hosts.default sandbox:default requires hosts.sandbox.enable = true.";
      }
      {
        assertion = !cfg.enable || !cfg.channel.localTest.enable || cfg.channel.localTest.token != "";
        message = "channel.localTest.token is required when the test channel is enabled.";
      }
      {
        assertion = !cfg.enable || !cfg.channel.localTest.enable
          || builtins.elem cfg.channel.localTest.bind [ "127.0.0.1" "::1" "localhost" ];
        message = "channel.localTest.bind must be a loopback address.";
      }
      {
        assertion = !cfg.enable || !cfg.channel.qqBot.enable || cfg.channel.qqBot.appId != "";
        message = "channel.qqBot.appId is required when the QQ bot channel is enabled.";
      }
      {
        assertion = !cfg.enable || !cfg.channel.qqBot.enable || cfg.channel.qqBot.clientSecretEnv != "";
        message = "channel.qqBot.clientSecretEnv must name the EnvironmentFile variable holding the client secret.";
      }
      {
        assertion = !cfg.enable || !cfg.channel.qqBot.enable
          || cfg.channel.qqBot.reconnectMaxMs >= cfg.channel.qqBot.reconnectBaseMs;
        message = "channel.qqBot.reconnectMaxMs must be at least channel.qqBot.reconnectBaseMs.";
      }
      {
        assertion = !cfg.enable || !cfg.channel.qqBot.enable || cfg.environmentFile != null;
        message = "channel.qqBot requires services.nokoribi-agent.environmentFile for the client secret.";
      }
      {
        assertion = !cfg.enable || routePairOk cfg.review.fast;
        message = "review.fast.provider and review.fast.model must both be set or both be null.";
      }
      {
        assertion = !cfg.enable || routePairOk cfg.review.strong;
        message = "review.strong.provider and review.strong.model must both be set or both be null.";
      }
      {
        assertion = !cfg.enable || routePairOk cfg.goal;
        message = "goal.provider and goal.model must both be set or both be null.";
      }
      {
        assertion = !cfg.enable || routePairOk cfg.memory;
        message = "memory.provider and memory.model must both be set or both be null.";
      }
      {
        assertion = !cfg.enable || lib.all allowedModelOk cfg.goal.allowedModels;
        message = "goal.allowedModels entries must use the exact provider/model form.";
      }
      {
        assertion = !cfg.enable || cfg.shutdown.stopTimeoutSeconds > cfg.shutdown.graceSeconds + 5;
        message = "shutdown.stopTimeoutSeconds must exceed shutdown.graceSeconds by more than 5 seconds.";
      }
      {
        assertion = !cfg.enable || lib.hasPrefix "/" cfg.dshHome;
        message = "dshHome must be an absolute path.";
      }
      {
        assertion = !cfg.enable || lib.hasPrefix "/" workspace;
        message = "workspace must be an absolute path.";
      }
      {
        assertion = !cfg.enable || lib.all mcpNameOk mcpServerNames;
        message = "mcp.servers[].name must match [A-Za-z0-9_-]{1,32}.";
      }
      {
        assertion = !cfg.enable
          || builtins.length (lib.unique mcpServerNames) == builtins.length mcpServerNames;
        message = "mcp.servers[].name values must be unique.";
      }
      {
        assertion = !cfg.enable
          || lib.all (server: server.transport != "stdio" || server.command != null) cfg.mcp.servers;
        message = "mcp.servers[].command is required for the stdio transport.";
      }
      {
        assertion = !cfg.enable
          || lib.all (server: server.transport != "streamable-http" || server.url != null) cfg.mcp.servers;
        message = "mcp.servers[].url is required for the streamable-http transport.";
      }
      {
        assertion = !cfg.enable || lib.all mcpSecretsOk cfg.mcp.servers;
        message = "mcp.servers[].env/headers values must be environment variable names ([A-Za-z_][A-Za-z0-9_]*), not secrets.";
      }
      {
        assertion = !cfg.enable
          || lib.all (server: server.reconnect.maxDelayMs >= server.reconnect.initialDelayMs) cfg.mcp.servers;
        message = "mcp.servers[].reconnect.maxDelayMs must be at least initialDelayMs.";
      }
      {
        assertion = !cfg.enable || !openViking.enable || openViking.endpoint != null;
        message = "memory.openviking.endpoint is required when memory.openviking.enable is true.";
      }
      {
        assertion = !cfg.enable
          || !openViking.enable
          || openViking.endpoint == null
          || lib.hasPrefix "http://" openViking.endpoint
          || lib.hasPrefix "https://" openViking.endpoint;
        message = "memory.openviking.endpoint must be an http(s) URL when set.";
      }
      {
        assertion = !cfg.enable || !openViking.enable || openViking.apiKeyEnv != "";
        message = "memory.openviking.apiKeyEnv must name the environment variable holding the OpenViking key.";
      }
      {
        assertion = !cfg.enable || lib.hasPrefix "/" bundledSkillsDir;
        message = "skill.bundledDir must be an absolute path.";
      }
    ];

    warnings = lib.optional (cfg.enable && cfg.sudo.enable)
      "services.nokoribi-agent.sudo.enable grants NOPASSWD: ALL; Auto review is the only boundary."
    ++ lib.optional (cfg.enable && cfg.channel.localTest.enable)
      "The local test-channel token is stored in the Nix store in plain text."
    ++ lib.optional (cfg.enable && !cfg.channel.localTest.enable && !cfg.channel.qqBot.enable)
      "The local test channel is disabled and the QQ bot channel is off; the daemon has no user-facing message channel."
    ++ lib.optional (cfg.enable && cfg.channel.qqBot.enable)
      "channel.qqBot is enabled: any QQ user who can message the bot or @-mention it in a group can drive the agent; platform limits are the only admission boundary and Auto review is the last gate (D152)."
    ++ lib.optional
      (cfg.enable && cfg.channel.qqBot.enable && cfg.channel.qqBot.activeMessageFallback == "auto")
      "QQ active message push was announced as removed on 2025-04-21 while the API docs still list active quotas; proactive notices may fail and are deferred to the next inbound (D161)."
    ++ lib.optional
      (cfg.enable && cfg.channel.qqBot.enable && cfg.channel.qqBot.approvalButtons)
      "QQ approval buttons are C2C-only; INTERACTION intent availability has not passed the real platform gate, and the driver falls back to text when unavailable (see channel health detail)."
    ++ lib.optional
      (cfg.enable && cfg.channel.qqBot.enable && cfg.channel.qqBot.markdown != "none")
      "QQ Markdown rendering of code blocks and tables is undocumented and untested; lower channel.qqBot.markdown to none if replies render badly."
    ++ lib.optional (cfg.enable && cfg.channel.qqBot.enable && !cfg.channel.localTest.enable)
      "channel.qqBot is the only message channel: there is no local fallback, so proactive notices are attempted, then deferred or dropped."
    ++ lib.optional (cfg.enable && cfg.channel.qqBot.enable && cfg.channel.localTest.enable)
      "channel.localTest and channel.qqBot are both enabled; replies and notices are routed per turn across the two channels."
    ++ lib.optional (cfg.enable && cfg.channel.qqBot.enable)
      "The QQ client secret is read from ${cfg.channel.qqBot.clientSecretEnv}; provide it through environmentFile/agenix, never the Nix store."
    ++ lib.optional (cfg.enable && cfg.mcp.servers != [ ])
      "mcp.servers attaches external MCP servers: their processes run with the service user's privileges and every MCP tool call is reviewed; configure only trusted servers."
    ++ lib.optional (cfg.enable && openViking.enable)
      "memory.openviking.enable disables local memory (tool/store/snapshot) and the memory curator; the OpenViking backend owns memory while enabled (D175)."
    ++ lib.optional (cfg.enable && openViking.enable && openViking.apiKeyEnv == "")
      "memory.openviking.apiKeyEnv is empty; the OpenViking key cannot be resolved from the environment.";
  } // mkIf cfg.enable {
    services.nokoribi-agent._overlayText = overlayText;

    users.groups.${cfg.group} = { };
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = "${cfg.dshHome}/home";
      createHome = false;
    };

    security.sudo.extraRules = mkIf cfg.sudo.enable [
      {
        users = [ cfg.user ];
        commands = [
          {
            command = "ALL";
            options = [ "NOPASSWD" ];
          }
        ];
      }
    ];

    nix.registry.nixpkgs.to = mkIf cfg.hosts.sandbox.enable (lib.mkDefault {
      type = "path";
      path = toString pkgs.path;
    });
    nix.settings.experimental-features = mkIf cfg.hosts.sandbox.enable (
      lib.mkAfter [ "nix-command" "flakes" ]
    );

    systemd.tmpfiles.rules =
      lib.optional (stateDirectory == null) "d ${cfg.dshHome} 0750 ${cfg.user} ${cfg.group} -"
      ++ lib.optional openViking.enable "d ${cfg.dshHome}/openviking-state 0700 ${cfg.user} ${cfg.group} -";

    systemd.services.nokoribi-agent = {
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      unitConfig = {
        StartLimitIntervalSec = 300;
        StartLimitBurst = 5;
      };
      environment = serviceEnvironment;
      serviceConfig = {
        Type = "notify";
        NotifyAccess = "all";
        WatchdogSec = "${toString cfg.watchdog.intervalSeconds}s";
        TimeoutStartSec = "${toString cfg.shutdown.startTimeoutSeconds}s";
        TimeoutStopSec = "${toString cfg.shutdown.stopTimeoutSeconds}s";
        Restart = "on-failure";
        RestartSec = "5s";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.dshHome;
        UMask = "0077";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        KillMode = "mixed";
        KillSignal = "SIGTERM";
        NoNewPrivileges = false;
        ProtectSystem = false;
        ProtectHome = false;
        PrivateTmp = false;
        StandardOutput = "journal";
        StandardError = "journal";
        SyslogIdentifier = "nokoribi-agent";
      } // lib.optionalAttrs (stateDirectory != null) {
        StateDirectory = stateDirectory;
        StateDirectoryMode = "0750";
      };
    };
  };
}
