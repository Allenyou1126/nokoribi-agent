/** One credential shape recognized by the secret guard. */
interface SecretPattern {
    /** Stable machine-readable credential kind. */
    readonly kind: string;
    /** Human-readable description used in error messages. */
    readonly label: string;
    /** Pattern matched against memory content. */
    readonly pattern: RegExp;
}

/**
 * Credential shapes rejected from memory content (09.5): private key blocks,
 * provider API keys, GitHub/AWS tokens, and password/token assignments with a
 * long value.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
    {
        kind: "private-key-block",
        label: "a private key block",
        pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
    },
    {
        kind: "sk-rk-api-key",
        label: "an sk-/rk- style API key",
        pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/,
    },
    {
        kind: "github-token",
        label: "a GitHub token",
        pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    },
    {
        kind: "aws-access-key-id",
        label: "an AWS access key id",
        pattern: /\bAKIA[0-9A-Z]{16}\b/,
    },
    {
        kind: "credential-assignment",
        label: "a password, API key, or token assignment",
        pattern:
            /(?:password|passwd|api[_-]?key|apikey|token)\s*[:=]\s*["']?[A-Za-z0-9_\-+/=.]{12,}/i,
    },
];

/** One recognized credential-like fragment in memory content. */
export interface SecretMatch {
    /** Stable machine-readable credential kind. */
    readonly kind: string;
    /** Human-readable description suitable for an error message. */
    readonly label: string;
}

/**
 * Find the first credential-looking fragment in memory content.
 * @param text - content about to be stored.
 * @returns the match, or `undefined` when the content is clean.
 */
export function findSecret(text: string): SecretMatch | undefined {
    for (const candidate of SECRET_PATTERNS) {
        if (candidate.pattern.test(text)) {
            return { kind: candidate.kind, label: candidate.label };
        }
    }
    return undefined;
}

/**
 * Whether memory content looks like it contains a credential.
 * @param text - content about to be stored.
 * @returns `true` when {@link findSecret} matches.
 */
export function containsSecret(text: string): boolean {
    return findSecret(text) !== undefined;
}

/** Raised when memory content is rejected because it looks like a credential. */
export class SecretDetectedError extends Error {
    /** Stable machine-readable credential kind. */
    readonly kind: string;

    constructor(kind: string, label: string, subject: string) {
        super(
            `refusing to store ${subject}: content looks like ${label} ` +
                `(${kind}); memory must never contain secrets or credentials`
        );
        this.name = "SecretDetectedError";
        this.kind = kind;
    }
}

/**
 * Reject memory content that looks like it contains a credential.
 * @param text - content about to be stored.
 * @param subject - what is being stored, used in the error message.
 * @throws {SecretDetectedError} when a credential shape is detected.
 */
export function assertNoSecrets(
    text: string,
    subject: string = "memory entry"
): void {
    const match = findSecret(text);
    if (match === undefined) return;
    throw new SecretDetectedError(match.kind, match.label, subject);
}
