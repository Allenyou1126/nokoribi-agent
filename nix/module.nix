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
    inherit localExtraPackages nixBinary setpriv timeZone;
  };
  overlayText = lib.generators.toYAML { } overlayPatches;
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
      (cfg.enable && cfg.channel.qqBot.enable && cfg.channel.qqBot.markdown != "none")
      "QQ Markdown rendering of code blocks and tables is undocumented and untested; lower channel.qqBot.markdown to none if replies render badly."
    ++ lib.optional (cfg.enable && cfg.channel.qqBot.enable && !cfg.channel.localTest.enable)
      "channel.qqBot is the only message channel: there is no local fallback, so proactive notices are attempted, then deferred or dropped."
    ++ lib.optional (cfg.enable && cfg.channel.qqBot.enable && cfg.channel.localTest.enable)
      "channel.localTest and channel.qqBot are both enabled; replies and notices are routed per turn across the two channels."
    ++ lib.optional (cfg.enable && cfg.channel.qqBot.enable)
      "The QQ client secret is read from ${cfg.channel.qqBot.clientSecretEnv}; provide it through environmentFile/agenix, never the Nix store.";
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

    systemd.tmpfiles.rules = mkIf (stateDirectory == null) [
      "d ${cfg.dshHome} 0750 ${cfg.user} ${cfg.group} -"
    ];

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
