{ lib, fetchPnpmDeps, pnpm_12 }:

let
  source = import ./source.nix { inherit lib; };
in
fetchPnpmDeps {
  inherit (source) pname version src;
  pnpm = pnpm_12;
  fetcherVersion = 4;
  hash = "sha256-tMVgkGdaENUEW+X1Pxr6rKO3+jMNySuEgFQnYXOmfg8=";
}
