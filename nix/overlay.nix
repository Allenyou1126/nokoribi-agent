{
  lib,
  cfg,
  mainRoute,
  fastRoute,
  strongRoute,
  goalRoute,
  memoryRoute,
  workspace,
  soulFile,
  templatesDir,
  sandboxBaseEnvironment,
  sandboxRoot,
  localExtraPackages,
  nixBinary,
  setpriv,
  timeZone,
}:

let
  effort = route:
    lib.optionalAttrs (route.reasoningEffort != "") {
      inherit (route) reasoningEffort;
    };

  route = route: {
    inherit (route) provider model;
  } // effort route;

  agentApp = {
    provider = mainRoute.provider;
    model = mainRoute.model;
    inherit workspace;
    shutdownGraceMs = cfg.shutdown.graceSeconds * 1000;
    version = cfg.package.version;

    goalProvider = goalRoute.provider;
    goalModel = goalRoute.model;
    goalModels = cfg.goal.allowedModels;
    goalDefaultMaxRounds = cfg.goal.maxRounds;
    goalRecoveryTimeoutMs = cfg.goal.recoveryTimeoutMs;

    memoryProvider = memoryRoute.provider;
    memoryModel = memoryRoute.model;
    memoryCurator = cfg.memory.curator.enable;
    memoryCuratorTimeoutMs = cfg.memory.curator.timeoutMs;

    reviewFastProvider = fastRoute.provider;
    reviewFastModel = fastRoute.model;
    reviewStrongProvider = strongRoute.provider;
    reviewStrongModel = strongRoute.model;
    reviewTimeoutMs = cfg.review.timeoutMs;
  }
  // effort mainRoute
  // (lib.optionalAttrs (goalRoute.reasoningEffort != "") {
    goalReasoningEffort = goalRoute.reasoningEffort;
  })
  // (lib.optionalAttrs (memoryRoute.reasoningEffort != "") {
    memoryReasoningEffort = memoryRoute.reasoningEffort;
  })
  // (lib.optionalAttrs (fastRoute.reasoningEffort != "") {
    reviewFastReasoningEffort = fastRoute.reasoningEffort;
  })
  // (lib.optionalAttrs (strongRoute.reasoningEffort != "") {
    reviewStrongReasoningEffort = strongRoute.reasoningEffort;
  });

  channelLocalTest = {
    enabled = cfg.channel.localTest.enable;
    host = cfg.channel.localTest.bind;
    port = cfg.channel.localTest.port;
    token = cfg.channel.localTest.token;
    senderId = "local-user";
    chatId = "local";
    longPollTimeoutMs = 25000;
    maxTextLength = 0;
    markdown = "basic";
    maxBodyBytes = 1048576;
  };

  channelQqBot = {
    enabled = cfg.channel.qqBot.enable;
    appId = cfg.channel.qqBot.appId;
    clientSecretEnv = cfg.channel.qqBot.clientSecretEnv;
    markdown = cfg.channel.qqBot.markdown;
    maxTextLength = cfg.channel.qqBot.maxTextLength;
    maxRepliesPerReply = cfg.channel.qqBot.maxRepliesPerReply;
    c2cReplyWindowSeconds = cfg.channel.qqBot.c2cReplyWindowSeconds;
    groupReplyWindowSeconds = cfg.channel.qqBot.groupReplyWindowSeconds;
    requestTimeoutMs = cfg.channel.qqBot.requestTimeoutSeconds * 1000;
    connectTimeoutMs = cfg.channel.qqBot.connectTimeoutSeconds * 1000;
    activeMessageFallback = cfg.channel.qqBot.activeMessageFallback;
    approvalButtons = cfg.channel.qqBot.approvalButtons;
    reconnectBaseMs = cfg.channel.qqBot.reconnectBaseMs;
    reconnectMaxMs = cfg.channel.qqBot.reconnectMaxMs;
  };

  # M10: BashTerminalBackend configuration for every registered shell host.
  terminalHost = {
    enabled = cfg.terminal.enable;
    bashPath = cfg.terminal.bashPath;
    sendTimeoutMs = cfg.terminal.sendTimeoutSeconds * 1000;
    rows = cfg.terminal.rows;
    cols = cfg.terminal.cols;
    scrollbackLines = cfg.terminal.scrollbackLines;
  };

  toolTerminal = {
    enableRunInBackground = true;
    maxResultBytes = cfg.terminal.maxResultBytes;
  };

  webConfig = {
    searchProvider = cfg.web.searchProvider;
    fetchProvider = cfg.web.fetchProvider;
  };

  toolWeb = {
    search = true;
    fetch = true;
    searchMaxResults = cfg.web.searchMaxResults;
    searchMaxQueries = cfg.web.searchMaxQueries;
    fetchTimeoutMs = cfg.web.fetchTimeoutSeconds * 1000;
    searchTimeoutMs = cfg.web.searchTimeoutSeconds * 1000;
    fetchMaxOutputChars = cfg.web.fetchMaxOutputChars;
  };

  patches = [
    {
      id = "nokoribi-agent-app";
      config = agentApp;
    }
    {
      id = "nokoribi-reviewer";
      config = {
        fast = route fastRoute;
        strong = route strongRoute;
        timeoutMs = cfg.review.timeoutMs;
        exemptTools = cfg.review.exemptTools;
      };
    }
    {
      id = "nokoribi-channel-core";
      config = {
        allowedSenders = [ "local-user" ];
        allowedChats = [ "local" ];
        defaultChatId = "local";
        trustedChannels = lib.optional cfg.channel.qqBot.enable "qq-bot";
        defaultChannelId = if cfg.channel.localTest.enable then "local-test" else "";
        approvalTimeoutMs = cfg.approval.approvalTimeoutSeconds * 1000;
        questionTimeoutMs = cfg.approval.questionTimeoutSeconds * 1000;
      };
    }
    {
      id = "nokoribi-channel-local-test";
      config = channelLocalTest;
    }
    {
      id = "nokoribi-channel-qq-bot";
      config = channelQqBot;
    }
    {
      id = "nokoribi-prompt";
      config = {
        inherit soulFile templatesDir workspace;
        seedGlobalAgents = cfg.prompt.seedAgentsMd;
        seedWorkspaceAgents = cfg.prompt.seedAgentsMd;
      };
    }
    {
      id = "nokoribi-shell-router";
      config = {
        defaultHost = cfg.hosts.default;
      };
    }
    {
      id = "nokoribi-shell-host-local";
      config = {
        enabled = cfg.hosts.local.enable;
        id = "local:workspace";
        inherit workspace;
        extraPackages = localExtraPackages;
        terminalBashPath = cfg.terminal.bashPath;
      };
    }
    {
      id = "nokoribi-shell-host-sandbox";
      config = {
        enabled = cfg.hosts.sandbox.enable;
        id = "sandbox:default";
        root = sandboxRoot;
        inherit workspace;
        baseEnvironment = sandboxBaseEnvironment;
        shellHook = cfg.hosts.sandbox.shellHook;
        idleTtlMs = cfg.hosts.sandbox.idleTtlMinutes * 60 * 1000;
        sweepIntervalMs = 60000;
        allowRuntimePackages = cfg.hosts.sandbox.allowRuntimePackages;
        inherit nixBinary;
        nixTimeoutMs = 120000;
        noNewPrivilegesCommand = setpriv;
      };
    }
    {
      id = "nokoribi-memory";
      config = {
        root = "${cfg.dshHome}/memory";
        defaultLimit = 10;
      };
    }
  ];

  # M10 terminal rows (bundle order: sandbox-policy, terminal, nokoribi-terminal-host,
  # nokoribi-tool-terminal). The terminal row itself needs no config; disabling the
  # group keeps bash(host) working because only the terminal rows are switched off.
  terminalPatches =
    if cfg.terminal.enable then
      [
        {
          id = "sandbox-policy";
          config = {
            mode = "danger-full-access";
            workspaceRoot = workspace;
          };
        }
        {
          id = "nokoribi-terminal-host";
          config = terminalHost;
        }
        {
          id = "nokoribi-tool-terminal";
          config = toolTerminal;
        }
      ]
    else
      [
        {
          id = "sandbox-policy";
          disabled = true;
        }
        {
          id = "terminal";
          disabled = true;
        }
        {
          id = "nokoribi-terminal-host";
          disabled = true;
        }
        {
          id = "nokoribi-tool-terminal";
          disabled = true;
        }
      ];

  # M10 web rows. All providers are mounted when enabled; ctx.web is pinned so a
  # second provider never makes the choice ambiguous.
  webPatches =
    if cfg.web.enable then
      [
        {
          id = "web";
          config = webConfig;
        }
        {
          id = "tool-web";
          config = toolWeb;
        }
      ]
    else
      [
        {
          id = "web";
          disabled = true;
        }
        {
          id = "web-search-deepseek";
          disabled = true;
        }
        {
          id = "web-fetch-http";
          disabled = true;
        }
        {
          id = "web-deepseek-api";
          disabled = true;
        }
        {
          id = "tool-web";
          disabled = true;
        }
      ];

  timePatch = lib.optional (timeZone != null) {
    id = "time-context";
    config = {
      inherit timeZone;
      refreshIntervalMs = cfg.time.contextRefreshSeconds * 1000;
    };
  };
in
patches ++ terminalPatches ++ webPatches ++ timePatch
