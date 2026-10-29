{
  description = "Nokoribi Agent: a thin, deployment-focused DeepSeek Harness distribution";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
      forAllSystems = function:
        nixpkgs.lib.genAttrs systems
          (system: function (import nixpkgs { inherit system; }));
    in
    {
      packages = forAllSystems (pkgs:
        let
          package = pkgs.callPackage ./nix/package.nix { };
        in
        {
          default = package;
          nokoribi-agent = package;
        });

      overlays.default = final: _prev: {
        nokoribi-agent = final.callPackage ./nix/package.nix { };
      };

      nixosModules.default = { lib, pkgs, ... }: {
        imports = [ ./nix/module.nix ];
        services.nokoribi-agent.package = lib.mkDefault
          self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      };

      checks = forAllSystems (pkgs:
        let
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          python = pkgs.python3.withPackages (packages: [ packages.pyyaml ]);
          sampleOptions = {
            services.nokoribi-agent = {
              enable = true;
              package = pkgs.hello;
              environmentFile = "/run/agenix/nokoribi-agent-env";
              time.zone = "UTC";
              hosts.default = "local:workspace";
              goal.allowedModels = [
                "deepseek-official/alt-model"
              ];
              channel.localTest = {
                enable = true;
                token = "test-token";
              };
              channel.qqBot = {
                enable = true;
                appId = "123456";
              };
              # M11/M12: custom limits so the overlay mapping is asserted, not
              # just the option defaults.
              sessionSearch = {
                maxResults = 50;
                searchTimeoutSeconds = 20;
              };
              skill = {
                customDirs = [ "/run/skills/extra" ];
                catalogDescriptionMaxLength = 320;
              };
              # M13: one stdio and one streamable-http server; env/header values
              # are environment variable names, never secrets.
              mcp.servers = [
                {
                  name = "github";
                  transport = "stdio";
                  command = "npx";
                  args = [
                    "-y"
                    "@modelcontextprotocol/server-github"
                  ];
                  env.GITHUB_TOKEN = "GITHUB_TOKEN";
                  toolCallTimeoutSeconds = 10;
                  failOnStartupError = true;
                }
                {
                  name = "web";
                  transport = "streamable-http";
                  url = "http://127.0.0.1:3000/mcp";
                  headers.Authorization = "MCP_AUTH_HEADER";
                  maxInstructionBytes = 16384;
                  reconnect = {
                    enable = false;
                    initialDelayMs = 250;
                    maxDelayMs = 1000;
                    maxAttempts = 2;
                  };
                }
              ];
              # M16: custom snapshot budget so the inject mapping is asserted.
              memory.inject = {
                maxChars = 1500;
                maxEntries = 5;
                mainOnly = false;
                autoTags = [ "type:person" ];
              };
            };
          };
          sample = nixpkgs.lib.nixosSystem {
            system = pkgs.stdenv.hostPlatform.system;
            modules = [
              self.nixosModules.default
              sampleOptions
              {
                services.nokoribi-agent.web.deepseekSearchBaseUrl =
                  "https://search.example.invalid/v1";
              }
            ];
          };
          disabledSample = nixpkgs.lib.nixosSystem {
            system = pkgs.stdenv.hostPlatform.system;
            modules = [
              self.nixosModules.default
              sampleOptions
              {
                services.nokoribi-agent = {
                  terminal.enable = false;
                  web.enable = false;
                  sessionSearch.enable = false;
                  skill.enable = false;
                  mcp.servers = pkgs.lib.mkForce [ ];
                };
              }
            ];
          };
          openVikingSample = nixpkgs.lib.nixosSystem {
            system = pkgs.stdenv.hostPlatform.system;
            modules = [
              self.nixosModules.default
              sampleOptions
              {
                services.nokoribi-agent.memory.openviking = {
                  enable = true;
                  endpoint = "https://openviking.example.invalid";
                  apiKeyEnv = "OPENVIKING_API_KEY";
                  peerId = "peer-a";
                  workspacePeer = "0";
                  recallMaxTokens = 4000;
                };
              }
            ];
          };
          singleMcpSample = nixpkgs.lib.nixosSystem {
            system = pkgs.stdenv.hostPlatform.system;
            modules = [
              self.nixosModules.default
              sampleOptions
              {
                services.nokoribi-agent.mcp.servers = pkgs.lib.mkForce [
                  {
                    name = "solo";
                    transport = "stdio";
                    command = "solo-mcp";
                  }
                ];
              }
            ];
          };
          moduleEval = name: flag: nixos:
            pkgs.runCommand "nokoribi-${name}" {
              nativeBuildInputs = [ python ];
              overlay = pkgs.writeText "${name}-overlay.yml"
                nixos.config.services.nokoribi-agent._overlayText;
              serviceConfig = pkgs.writeText "${name}-service.json"
                (builtins.toJSON nixos.config.systemd.services.nokoribi-agent.serviceConfig);
              environment = pkgs.writeText "${name}-environment.json"
                (builtins.toJSON nixos.config.systemd.services.nokoribi-agent.environment);
              tmpfiles = pkgs.writeText "${name}-tmpfiles.json"
                (builtins.toJSON nixos.config.systemd.tmpfiles.rules);
              bundle = ./packages/bundle/cordis.patch.yml;
            } ''
              python ${./nix/check-module.py} ${flag} "$overlay" "$serviceConfig" "$environment" "$tmpfiles" "$bundle"
              touch $out
            '';
        in
        {
          package = package;

          unit = pkgs.callPackage ./nix/tests.nix { };

          package-smoke = pkgs.runCommand "nokoribi-package-smoke" { } ''
            test "$(${package}/bin/nokoribi-agent --version)" = "nokoribi-agent ${version}"
            ${package}/bin/nokoribi-agent --help > /dev/null
            test -f ${package}/share/SOUL.md
            test -d ${package}/share/templates
            # D148: the loader wrapper cannot be process.execPath; the preload
            # and its runnable Node shim must stay packaged.
            test -f ${package}/lib/nokoribi-agent/exec-path-preload.cjs
            test -x ${package}/bin/node-shim
            ${package}/bin/node-shim -e 'process.exit(0)'
            grep -q 'exec-path-preload.cjs' ${package}/bin/nokoribi-agent
            # M8: the official QQ SDK protocol layer must resolve from the
            # production closure, and the runtime needs fetch/WebSocket.
            # Resolve from the owning workspace package: pnpm links direct
            # dependencies into each package's node_modules, not the root.
            (cd ${package}/lib/nokoribi-agent/packages/channel-qq-bot && \
              ${package}/bin/node-shim --input-type=module \
                -e 'await import("@tencent-connect/qqbot-nodejs/protocol");')
            ${package}/bin/node-shim -e 'if (typeof fetch !== "function") process.exit(1)'
            ${package}/bin/node-shim -e 'if (typeof WebSocket !== "function") process.exit(1)'
            # M10: terminal and web rows must resolve from the production
            # closure; resolve from the bundle package that owns those deps.
            (cd ${package}/lib/nokoribi-agent/packages/bundle && \
              ${package}/bin/node-shim --input-type=module -e 'await import("@deepseek-ai/dsh-terminal"); await import("@deepseek-ai/dsh-terminal-bash"); await import("@deepseek-ai/dsh-web"); await import("@deepseek-ai/dsh-tool-web"); await import("@nokoribi/terminal-host");')
            # M11/M12/M13: session search, skill and MCP rows must resolve from
            # the production closure.
            (cd ${package}/lib/nokoribi-agent/packages/bundle && \
              ${package}/bin/node-shim --input-type=module -e 'await import("@deepseek-ai/dsh-tool-session-query"); await import("@deepseek-ai/dsh-skill"); await import("@deepseek-ai/dsh-skill-filesystem"); await import("@deepseek-ai/dsh-tool-skill"); await import("@deepseek-ai/dsh-mcp-client"); await import("@deepseek-ai/dsh-mcp-resources");')
            # M12: the bundled read-only skills must ship in share/skills.
            test -f '${package}/share/skills/nokoribi-deploy/SKILL.md'
            test -f '${package}/share/skills/nokoribi-debug/SKILL.md'
            # M17: the optional OpenViking bundle must resolve from the
            # launcher anchor so M12/M13 peer packages are the host copies.
            (cd ${package}/lib/nokoribi-agent/packages/launcher && \
              ${package}/bin/node-shim --input-type=module \
                -e 'await import("@openviking/dsh-memory-plugin");')
            touch $out
          '';

          module-eval = moduleEval "module-eval" "" sample;

          module-eval-disabled = moduleEval "module-eval-disabled" "--disabled" disabledSample;

          module-eval-openviking = moduleEval "module-eval-openviking" "--openviking" openVikingSample;

          module-eval-mcp-single = moduleEval "module-eval-mcp-single" "--mcp-single" singleMcpSample;
        });
    };
}
