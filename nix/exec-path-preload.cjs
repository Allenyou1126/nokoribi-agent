"use strict";

// DSH's local subprocess provider launches its private bootstrap by
// re-executing `process.execPath`. Under the Nix wrapper that value is the
// glibc loader, not a runnable Node binary, so every managed process launch
// dies before it can consume the launch request:
//   "subprocess scope exited before its bootstrap consumed the launch request"
// (observed on NixOS in the M6 target smoke, D148). Point `process.execPath`
// at the wrapper's Node shim; `bin/nokoribi-agent` exports its path in
// NOKORIBI_NODE_SHIM. Keep this preload loaded with `--require` from the
// wrapper so it never leaks into user shell environments through NODE_OPTIONS.
const shim = process.env.NOKORIBI_NODE_SHIM;
if (typeof shim === "string" && shim !== "") {
    Object.defineProperty(process, "execPath", {
        value: shim,
        writable: true,
        configurable: true,
        enumerable: true,
    });
}
