import { describe, expect, it } from "vitest";

import {
    buildSandboxCommand,
    buildSandboxTerminalArgv,
    shellQuote,
} from "../src/command.js";

const base = {
    guardDir: "/sandbox/.path-guard",
    shellHook: "",
    hostBash: "/usr/bin/bash",
    setpriv: "/usr/bin/setpriv",
    baseEnvironment: "/nix/store/base-env",
    packages: [],
    command: "echo hi",
};

describe("sandbox command wrapper", () => {
    it("quotes single quotes safely", () => {
        expect(shellQuote("plain")).toBe("'plain'");
        expect(shellQuote("a'b")).toBe("'a'\\''b'");
        expect(shellQuote("a\nb")).toBe("'a\nb'");
    });

    it("wraps base-only commands with setpriv and a fixed script", () => {
        const command = buildSandboxCommand(base);
        expect(command).toContain("exec '/usr/bin/setpriv' --no-new-privs -- ");
        expect(command).toContain("'/usr/bin/bash' -c");
        expect(command).toContain("nokoribi-sandbox 'echo hi'");
        expect(command).toContain("export PATH=");
        expect(command).toContain("/sandbox/.path-guard");
        expect(command).toContain('"$PATH"');
        expect(command).not.toContain("nix shell");
    });

    it("passes user commands as a positional argument, not shell source", () => {
        const command = buildSandboxCommand({
            ...base,
            command: "echo 'x'; rm -rf /tmp/not-run",
        });
        const script = command.slice(command.indexOf("'/usr/bin/bash' -c"));
        expect(command).toContain(
            "nokoribi-sandbox 'echo '\\''x'\\''; rm -rf /tmp/not-run'"
        );
        expect(script).not.toContain("rm -rf /tmp/not-run\n");
    });

    it("includes the shellHook before the user command", () => {
        const command = buildSandboxCommand({
            ...base,
            shellHook: "export FOO=bar",
        });
        expect(command).toContain("export FOO=bar");
        expect(command.indexOf("export FOO=bar")).toBeLessThan(
            command.indexOf("nokoribi-sandbox")
        );
    });

    it("adds a nix shell layer only when temporary packages exist", () => {
        const command = buildSandboxCommand({
            ...base,
            nix: "/usr/bin/nix",
            packages: ["nixpkgs#hello", "nixpkgs#jq"],
        });
        expect(command).toContain(
            "exec '/usr/bin/nix' shell '/nix/store/base-env' " +
                "'nixpkgs#hello' 'nixpkgs#jq' --command '/usr/bin/setpriv'"
        );
        expect(command).toContain("--no-new-privs");
    });

    it("rejects a missing nix binary when packages are requested", () => {
        expect(() =>
            buildSandboxCommand({
                ...base,
                packages: ["nixpkgs#hello"],
            })
        ).toThrow(/require a resolved nix binary/);
    });

    it("builds a setpriv terminal without a temporary package layer", () => {
        expect(
            buildSandboxTerminalArgv({
                hostBash: "/nix/store/bash/bin/bash",
                setpriv: "/nix/store/setpriv/bin/setpriv",
                baseEnvironment: "/nix/store/env",
                packages: [],
            })
        ).toEqual([
            "/nix/store/setpriv/bin/setpriv",
            "--no-new-privs",
            "--",
            "/nix/store/bash/bin/bash",
            "--noprofile",
            "--norc",
            "-i",
        ]);
    });

    it("builds a nix shell terminal layer for temporary packages", () => {
        expect(
            buildSandboxTerminalArgv({
                hostBash: "/nix/store/bash/bin/bash",
                setpriv: "/nix/store/setpriv/bin/setpriv",
                nix: "/nix/store/nix/bin/nix",
                baseEnvironment: "/nix/store/env",
                packages: ["nixpkgs#hello"],
            })
        ).toEqual([
            "/nix/store/nix/bin/nix",
            "shell",
            "/nix/store/env",
            "nixpkgs#hello",
            "--command",
            "/nix/store/setpriv/bin/setpriv",
            "--no-new-privs",
            "--",
            "/nix/store/bash/bin/bash",
            "--noprofile",
            "--norc",
            "-i",
        ]);
    });

    it("rejects terminal packages without a nix binary", () => {
        expect(() =>
            buildSandboxTerminalArgv({
                hostBash: "/bin/bash",
                setpriv: "/usr/bin/setpriv",
                baseEnvironment: "/nix/store/env",
                packages: ["nixpkgs#hello"],
            })
        ).toThrow(/require a resolved nix binary/);
    });
});
