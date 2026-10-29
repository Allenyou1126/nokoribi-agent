import { TERMINAL_BASH_ARGS } from "@nokoribi/shell-bash";

/** Quote one argument for a POSIX shell command line. */
export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Inputs for one sandbox command wrapper. */
export interface SandboxCommandInput {
    /** Guard directory containing sudo/su/... shims. */
    readonly guardDir: string;
    /** Trusted shellHook evaluated before the command. */
    readonly shellHook: string;
    /** Absolute host bash used for the wrapper script and the command. */
    readonly hostBash: string;
    /** Absolute setpriv used to set no_new_privs. */
    readonly setpriv: string;
    /** Absolute nix binary, required when `packages` is non-empty. */
    readonly nix?: string | undefined;
    /** Absolute Nix buildEnv store path. */
    readonly baseEnvironment: string;
    /** Temporary package installables; empty means no nix shell layer. */
    readonly packages: readonly string[];
    /** User command; passed as a positional argument, never interpolated. */
    readonly command: string;
}

function wrapperScript(input: SandboxCommandInput): string {
    const lines = [`export PATH=${shellQuote(input.guardDir)}:"$PATH"`];
    if (input.shellHook.trim() !== "") lines.push(input.shellHook);
    lines.push(`exec ${shellQuote(input.hostBash)} -c "$1"`);
    return lines.join("\n");
}

/**
 * Build the command string executed by the router's local bash mechanics.
 *
 * The user command is passed as `$1`; only the fixed script and trusted
 * shellHook are part of the shell source. Temporary packages add one
 * `nix shell ... --command setpriv ...` layer so their bins are prepended to
 * the restricted PATH while `no_new_privs` still wraps the user command.
 * @param input - resolved binaries, paths, packages and command.
 * @returns one POSIX shell command string.
 */
export function buildSandboxCommand(input: SandboxCommandInput): string {
    const script = wrapperScript(input);
    const tail =
        `${shellQuote(input.hostBash)} -c ${shellQuote(script)} ` +
        `nokoribi-sandbox ${shellQuote(input.command)}`;
    if (input.packages.length === 0) {
        return `exec ${shellQuote(input.setpriv)} --no-new-privs -- ` + tail;
    }
    if (input.nix === undefined) {
        throw new Error(
            "sandbox temporary packages require a resolved nix binary"
        );
    }
    const installables = [input.baseEnvironment, ...input.packages]
        .map((value) => shellQuote(value))
        .join(" ");
    return (
        `exec ${shellQuote(input.nix)} shell ${installables} ` +
        `--command ${shellQuote(input.setpriv)} --no-new-privs -- ${tail}`
    );
}

/** Inputs for one sandbox persistent-terminal argv. */
export interface SandboxTerminalArgvInput {
    /** Absolute host bash used for the interactive shell. */
    readonly hostBash: string;
    /** Absolute setpriv used to set no_new_privs. */
    readonly setpriv: string;
    /** Absolute nix binary, required when `packages` is non-empty. */
    readonly nix?: string | undefined;
    /** Absolute Nix buildEnv store path. */
    readonly baseEnvironment: string;
    /** Temporary package installables; empty means no nix shell layer. */
    readonly packages: readonly string[];
}

/**
 * Build the argv for a sandbox PTY without a shell string.
 *
 * Temporary packages add one `nix shell ... --command` layer so their bins are
 * visible to the interactive shell while `no_new_privs` still wraps it.
 * @param input - resolved binaries, environment and packages.
 * @returns argv for `ctx.subprocess.spawnTerminal`.
 */
export function buildSandboxTerminalArgv(
    input: SandboxTerminalArgvInput
): string[] {
    const shell = [input.hostBash, ...TERMINAL_BASH_ARGS];
    if (input.packages.length === 0) {
        return [input.setpriv, "--no-new-privs", "--", ...shell];
    }
    if (input.nix === undefined) {
        throw new Error(
            "sandbox terminal temporary packages require a resolved nix binary"
        );
    }
    return [
        input.nix,
        "shell",
        input.baseEnvironment,
        ...input.packages,
        "--command",
        input.setpriv,
        "--no-new-privs",
        "--",
        ...shell,
    ];
}
