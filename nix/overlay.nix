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
  bundledSkillsDir,
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
    # M16/M17: the curator stays off when local memory is disabled, which
    # OpenViking mode forces through the env switch (D175).
    memoryCurator = cfg.memory.curator.enable && !cfg.memory.openviking.enable;
    memoryCuratorTimeoutMs = cfg.memory.curator.timeoutMs;
    sendFileMaxBytes = cfg.sendFile.maxBytes;

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
    questionButtons = cfg.channel.qqBot.questionButtons;
    inboundImages = cfg.channel.qqBot.inboundImages;
    inboundImageMaxBytes = cfg.channel.qqBot.inboundImageMaxBytes;
    inboundImageTimeoutMs = cfg.channel.qqBot.inboundImageTimeoutSeconds * 1000;
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

  # M11: the query-service row stays mounted (exact reads, filters and traces
  # remain available) and only its FTS lifecycle changes; the model-facing tool
  # row is switched off as a unit when the deployment disables session search.
  sessionSearchPatches = [
    {
      id = "session-query";
      config = {
        path = "${cfg.dshHome}/session-search.db";
        openAt = if cfg.sessionSearch.enable then "first-search" else "never";
      };
    }
  ] ++ (
    if cfg.sessionSearch.enable then
      [
        {
          id = "tool-session-query";
          config = {
            maxSearchResults = cfg.sessionSearch.maxResults;
            searchTimeoutMs = cfg.sessionSearch.searchTimeoutSeconds * 1000;
          };
        }
      ]
    else
      [
        {
          id = "tool-session-query";
          disabled = true;
        }
      ]
  );

  # M12: local skills are a group: the registry, filesystem provider and
  # model-facing catalog/tool are disabled together so no skill surface leaks
  # into an uncovered deployment.
  skillPatches =
    if cfg.skill.enable then
      [
        {
          id = "skill-filesystem";
          config = {
            includeDefaultRoots = true;
            dshHome = cfg.dshHome;
            customSkillDirs = cfg.skill.customDirs;
            bundledSkillDir = bundledSkillsDir;
            watch = true;
          };
        }
        {
          id = "tool-skill";
          config = {
            catalogDescriptionMaxLength = cfg.skill.catalogDescriptionMaxLength;
          };
        }
      ]
    else
      [
        {
          id = "skill";
          disabled = true;
        }
        {
          id = "skill-filesystem";
          disabled = true;
        }
        {
          id = "tool-skill";
          disabled = true;
        }
      ];

  # M13: one mcp-client row per configured server. Env/header VALUES are
  # environment-variable names; they render as markers here and become
  # app-boot `!!js process.env.<NAME>` expressions in module.nix, so the store
  # only ever contains the variable name.
  jsEnvMarker = value: "__nokoribi_js_process_env_${value}__";
  mcpServerConfig =
    server:
    {
      serverName = server.name;
      inherit (server) transport maxInstructionBytes failOnStartupError;
      toolCallTimeoutMs = server.toolCallTimeoutSeconds * 1000;
      reconnect = {
        enabled = server.reconnect.enable;
        inherit (server.reconnect) initialDelayMs maxDelayMs maxAttempts;
      };
    }
    // (
      if server.transport == "stdio" then
        {
          inherit (server) command args;
          env = lib.mapAttrs (_name: value: jsEnvMarker value) server.env;
        }
        // lib.optionalAttrs (server.cwd != null) { inherit (server) cwd; }
      else
        {
          inherit (server) url;
          headers = lib.mapAttrs (_name: value: jsEnvMarker value) server.headers;
        }
    );
  mcpPatches = lib.optional (cfg.mcp.servers != [ ]) {
    # Patch rows only override existing ids, so the generated client rows are
    # appended through one insert entry (id-less insert pushes to the top
    # level of the Cordis entry list).
    insert = map (server: {
      id = "mcp-${server.name}";
      name = "@deepseek-ai/dsh-mcp-client";
      config = mcpServerConfig server;
    }) cfg.mcp.servers;
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
        # M17: OpenViking owns memory, so the local memory prompt section is
        # not registered (the memory row is switched off by the env switch).
        memorySection = !cfg.memory.openviking.enable;
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
        inject = {
          enable = cfg.memory.inject.enable;
          maxChars = cfg.memory.inject.maxChars;
          maxEntries = cfg.memory.inject.maxEntries;
          mainOnly = cfg.memory.inject.mainOnly;
          autoTags = cfg.memory.inject.autoTags;
        };
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
patches
++ terminalPatches
++ webPatches
++ sessionSearchPatches
++ skillPatches
++ mcpPatches
++ timePatch
