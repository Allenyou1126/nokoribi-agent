{ lib, fetchPnpmDeps, pnpm_12 }:

let
  source = import ./source.nix { inherit lib; };
in
fetchPnpmDeps {
  inherit (source) pname version src;
  pnpm = pnpm_12;
  fetcherVersion = 4;
  hash = "sha256-jTh4kakXDmGk/3xOg8q4Xj60Prlb5nGNQYmAnnaEatQ=";
}
