{
  lib,
  stdenv,
  nodejs_24,
  pnpm_12,
  pnpmConfigHook,
  fetchPnpmDeps,
  fetchurl,
  autoPatchelfHook,
}:

let
  source = import ./source.nix { inherit lib; };
  pnpmDeps = import ./deps.nix {
    inherit lib fetchPnpmDeps pnpm_12;
  };

  # DSH's node-addon-require-builtin introspects the official Node binary's
  # code layout. nixpkgs' Node and a patchelf-rewritten official binary both
  # fail that check, so keep the official binary intact and invoke it through
  # the Nix glibc loader. This also makes the wrapped process self-consistent
  # on NixOS.
  nodeRuntime = stdenv.mkDerivation {
    pname = "node-official";
    version = "24.21.0";
    src = fetchurl (
      if stdenv.hostPlatform.system == "x86_64-linux" then {
        url = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz";
        hash = "sha256-/Y5Z1aURUQ9qKYr7VI8Yx9KxvkBNi0on2U++SfVsstY=";
      } else if stdenv.hostPlatform.system == "aarch64-linux" then {
        url = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz";
        hash = "sha256-atEyXtvbVknDebdaI3FHpmbJXU+a6NNA/vLRV10omtI=";
      } else
        throw "unsupported Node runtime system ${stdenv.hostPlatform.system}"
    );
    dontConfigure = true;
    dontBuild = true;
    dontPatchELF = true;
    dontStrip = true;
    installPhase = ''
      mkdir -p $out/bin
      cp bin/node $out/bin/node
      chmod 755 $out/bin/node
    '';
  };

  loader = "${stdenv.cc.libc}/lib/${
    if stdenv.hostPlatform.isAarch64 then "ld-linux-aarch64.so.1"
    else "ld-linux-x86-64.so.2"
  }";
  nodeLibraries = lib.makeLibraryPath [
    stdenv.cc.cc.lib
    stdenv.cc.libc
  ];
in
stdenv.mkDerivation {
  inherit (source) pname version src;
  inherit pnpmDeps;

  nativeBuildInputs = [
    nodejs_24
    pnpm_12
    pnpmConfigHook
    autoPatchelfHook
  ];
  buildInputs = [
    stdenv.cc.cc.lib
  ];

  # koffi ships separate glibc and musl prebuilds. NixOS uses the glibc one;
  # the unused musl artifact still names its musl interpreter.
  autoPatchelfIgnoreMissingDeps =
    lib.optional stdenv.hostPlatform.isx86_64 "libc.musl-x86_64.so.1"
    ++ lib.optional stdenv.hostPlatform.isAarch64 "libc.musl-aarch64.so.1";

  # Keep the nixpkgs pnpm instead of letting pnpm try to fetch the version
  # pinned in package.json during the offline build.
  preBuild = ''
    export pnpm_config_manage_package_manager_versions=false
  '';

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    export pnpm_config_manage_package_manager_versions=false
    rm -rf node_modules
    find packages vendor -type d -name node_modules -prune -exec rm -rf {} +
    pnpm install --prod --offline --frozen-lockfile --trust-lockfile \
      --ignore-scripts

    mkdir -p $out/lib/nokoribi-agent
    cp -a \
      package.json \
      pnpm-lock.yaml \
      pnpm-workspace.yaml \
      SOUL.md \
      templates \
      vendor \
      packages \
      node_modules \
      $out/lib/nokoribi-agent/

    # NixOS module defaults point at the conventional share/ layout.
    mkdir -p $out/share
    cp -a SOUL.md $out/share/SOUL.md
    cp -a templates $out/share/templates

    mkdir -p $out/bin
    cat > $out/bin/nokoribi-agent <<EOF
#!${stdenv.shell}
export NODE_ENV=production
exec ${loader} --library-path ${nodeLibraries} ${nodeRuntime}/bin/node "$out/lib/nokoribi-agent/packages/launcher/dist/index.js" "\$@"
EOF
    chmod 755 $out/bin/nokoribi-agent

    runHook postInstall
  '';

  doCheck = false;
  dontStrip = true;

  meta = {
    description = "Nokoribi Agent daemon, a thin DeepSeek Harness distribution";
    homepage = "https://github.com/allenyou/nokoribi-agent";
    license = lib.licenses.mit;
    mainProgram = "nokoribi-agent";
    platforms = lib.platforms.linux;
  };
}
