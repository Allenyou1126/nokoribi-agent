{
  lib,
  stdenv,
  nodejs_24,
  pnpm_12,
  pnpmConfigHook,
  fetchPnpmDeps,
}:

let
  source = import ./source.nix { inherit lib; };
  pnpmDeps = import ./deps.nix {
    inherit lib fetchPnpmDeps pnpm_12;
  };
in
stdenv.mkDerivation {
  pname = "${source.pname}-tests";
  inherit (source) version src;
  inherit pnpmDeps;

  nativeBuildInputs = [
    nodejs_24
    pnpm_12
    pnpmConfigHook
  ];

  preBuild = ''
    export pnpm_config_manage_package_manager_versions=false
  '';

  buildPhase = ''
    runHook preBuild
    pnpm build
    pnpm test:unit
    runHook postBuild
  '';

  installPhase = ''
    mkdir -p $out
    touch $out/passed
  '';

  doCheck = false;
  dontStrip = true;
}
