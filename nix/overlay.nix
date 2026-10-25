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
      };
    }
    {
      id = "nokoribi-channel-core";
      config = {
        allowedSenders = [ "local-user" ];
        allowedChats = [ "local" ];
        defaultChatId = "local";
        approvalTimeoutMs = cfg.approval.approvalTimeoutSeconds * 1000;
        questionTimeoutMs = cfg.approval.questionTimeoutSeconds * 1000;
      };
    }
    {
      id = "nokoribi-channel-local-test";
      config = channelLocalTest;
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

  timePatch = lib.optional (timeZone != null) {
    id = "time-context";
    config = {
      inherit timeZone;
      refreshIntervalMs = cfg.time.contextRefreshSeconds * 1000;
    };
  };
in
patches ++ timePatch
