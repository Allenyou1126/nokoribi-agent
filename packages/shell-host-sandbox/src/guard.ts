import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Commands shadowed inside a sandbox to keep the PATH free of escalation. */
export const GUARDED_COMMANDS: readonly string[] = [
    "sudo",
    "su",
    "pkexec",
    "doas",
];

const GUARD_MESSAGE: string =
    "sandbox: privilege escalation is disabled; use the local host if the user approves the action";

/**
 * Install executable shims that shadow escalation binaries early in PATH.
 * This is a usability guard; `no_new_privs` remains the enforcement mechanism
 * for absolute paths.
 * @param guardDir - sandbox-local guard directory.
 * @param hostBash - absolute bash used for the shim shebang.
 */
export async function ensurePathGuard(
    guardDir: string,
    hostBash: string
): Promise<void> {
    await mkdir(guardDir, { recursive: true, mode: 0o700 });
    const bashPath = join(guardDir, "bash");
    await rm(bashPath, { force: true });
    await symlink(hostBash, bashPath);
    for (const command of GUARDED_COMMANDS) {
        const path = join(guardDir, command);
        const script = `#!${hostBash}\nprintf '%s\\n' ${JSON.stringify(
            GUARD_MESSAGE
        )} >&2\nexit 1\n`;
        await chmod(path, 0o700).catch(() => undefined);
        await writeFile(path, script, { mode: 0o555 });
        await chmod(path, 0o555);
    }
}
