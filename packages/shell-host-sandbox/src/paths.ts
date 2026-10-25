import { join } from "node:path";

const SESSION_ID_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One session's sandbox directory and sidecar. */
export interface SandboxPaths {
    readonly dir: string;
    readonly meta: string;
}

/**
 * Reject session ids that could escape the sandbox root.
 * @param sessionId - agent session id.
 * @throws when the id is empty or contains unsafe path characters.
 */
export function assertSessionId(sessionId: string): void {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
        throw new Error(
            `invalid sandbox session id ${JSON.stringify(sessionId)}: ` +
                "expected letters, digits, dot, underscore, or hyphen"
        );
    }
}

/**
 * Resolve the per-session directory and sidecar path.
 * @param root - `$DSH_HOME/sandboxes`.
 * @param sessionId - owning session.
 * @returns directory and sidecar paths.
 */
export function sandboxPaths(root: string, sessionId: string): SandboxPaths {
    assertSessionId(sessionId);
    return {
        dir: join(root, sessionId),
        meta: join(root, `${sessionId}.json`),
    };
}
