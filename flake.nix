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
                };
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
            } ''
              python ${./nix/check-module.py} ${flag} "$overlay" "$serviceConfig" "$environment"
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
            touch $out
          '';

          module-eval = moduleEval "module-eval" "" sample;

          module-eval-disabled = moduleEval "module-eval-disabled" "--disabled" disabledSample;
        });
    };
}
