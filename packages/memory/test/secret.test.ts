import { describe, expect, it } from "vitest";

import {
    SecretDetectedError,
    assertNoSecrets,
    containsSecret,
    findSecret,
} from "../src/secret.js";

const CREDENTIALS: readonly (readonly [string, string])[] = [
    [
        "private key block",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ],
    [
        "RSA private key block",
        "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    ],
    ["OpenAI-style key", "api key is sk-abcdefghijklmnopqrstuvwxyz"],
    ["rk-style key", "key: rk-abcdefghijklmnopqrstuvwxyz"],
    ["GitHub personal token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub OAuth token", "gho_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub user token", "ghu_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub server token", "ghs_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub refresh token", "ghr_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AWS access key id", "AKIAABCDEFGHIJKLMNOP"],
    ["password assignment", "password=correct-horse-battery"],
    ["API key assignment", 'api_key: "abcdef1234567890"'],
    ["token assignment", "token = abcdef1234567890"],
];

const SAFE_TEXTS: readonly string[] = [
    "用户偏好使用 agenix 管理 NixOS 密钥，不使用明文 EnvironmentFile。",
    "NixOS deployments should keep secrets out of the repository.",
    "The project uses a sandbox host by default.",
    "The password policy is documented in AGENTS.md.",
    "Run `ls -la` first, then read the file.",
    "sk-learn is not a credential; this sentence has no long value.",
];

describe("secret guard", () => {
    it.each(CREDENTIALS)("detects a %s", (_label, text) => {
        expect(containsSecret(text)).toBe(true);
        expect(findSecret(text)?.kind).toBeDefined();
        expect(() => assertNoSecrets(text)).toThrow(SecretDetectedError);
    });

    it.each(SAFE_TEXTS)("accepts safe text: %s", (text) => {
        expect(containsSecret(text)).toBe(false);
        expect(findSecret(text)).toBeUndefined();
        expect(() => assertNoSecrets(text)).not.toThrow();
    });

    it("reports the credential kind and subject in the error", () => {
        expect(() =>
            assertNoSecrets("-----BEGIN PRIVATE KEY-----", "memory entry")
        ).toThrow(/private key block/);
        expect(() => assertNoSecrets("password=correct-horse-battery")).toThrow(
            /must never contain secrets or credentials/
        );
        const error = (() => {
            try {
                assertNoSecrets("AKIAABCDEFGHIJKLMNOP", "memory title");
                return undefined;
            } catch (caught) {
                return caught;
            }
        })();
        expect(error).toBeInstanceOf(SecretDetectedError);
        if (error instanceof SecretDetectedError) {
            expect(error.kind).toBe("aws-access-key-id");
            expect(error.message).toContain("memory title");
        }
    });
});
