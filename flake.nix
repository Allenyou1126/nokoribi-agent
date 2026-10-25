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
          sample = nixpkgs.lib.nixosSystem {
            system = pkgs.stdenv.hostPlatform.system;
            modules = [
              self.nixosModules.default
              {
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
                };
              }
            ];
          };
        in
        {
          package = package;

          unit = pkgs.callPackage ./nix/tests.nix { };

          package-smoke = pkgs.runCommand "nokoribi-package-smoke" { } ''
            test "$(${package}/bin/nokoribi-agent --version)" = "nokoribi-agent ${version}"
            ${package}/bin/nokoribi-agent --help > /dev/null
            test -f ${package}/share/SOUL.md
            test -d ${package}/share/templates
            touch $out
          '';

          module-eval = pkgs.runCommand "nokoribi-module-eval" {
            nativeBuildInputs = [ python ];
            overlay = pkgs.writeText "overlay.yml"
              sample.config.services.nokoribi-agent._overlayText;
            serviceConfig = pkgs.writeText "service.json"
              (builtins.toJSON sample.config.systemd.services.nokoribi-agent.serviceConfig);
            environment = pkgs.writeText "environment.json"
              (builtins.toJSON sample.config.systemd.services.nokoribi-agent.environment);
          } ''
            python ${./nix/check-module.py} \
              "$overlay" "$serviceConfig" "$environment"
            touch $out
          '';
        });
    };
}
