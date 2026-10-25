{ lib }:

let
  package = lib.importJSON ../package.json;
  ignoredDirectories = [
    ".git"
    ".direnv"
    ".spec"
    "coverage"
    "dist"
    "nix"
    "node_modules"
    "result"
  ];
  ignoredFile = name:
    name == ".env"
    || lib.hasPrefix ".env." name
    || name == "flake.lock"
    || name == "result"
    || lib.hasSuffix ".log" name;
  filter = path: type:
    let
      name = baseNameOf path;
    in
    if type == "directory" then
      !(builtins.elem name ignoredDirectories)
    else
      !(ignoredFile name);
in
{
  pname = "nokoribi-agent";
  version = package.version;
  src = lib.cleanSourceWith {
    src = ../.;
    inherit filter;
  };
}
