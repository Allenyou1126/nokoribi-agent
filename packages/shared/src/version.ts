import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Version used when the launcher does not provide one. */
export const DEFAULT_VERSION: string = "0.0.0-dev";

/** Resolve the runtime version from the launcher environment. */
export function resolveVersion(
    env: Record<string, string | undefined> = process.env
): string {
    const value = env.NOKORIBI_VERSION?.trim();
    return value === undefined || value === "" ? DEFAULT_VERSION : value;
}

/**
 * Read an installed package's manifest version for diagnostics.
 * @param specifier - package name whose package.json is exported.
 * @returns the version, or `unknown` when resolution fails.
 */
export function resolvePackageVersion(specifier: string): string {
    try {
        const require = createRequire(import.meta.url);
        const path = require.resolve(`${specifier}/package.json`);
        const manifest = JSON.parse(readFileSync(path, "utf8")) as {
            version?: unknown;
        };
        return typeof manifest.version === "string"
            ? manifest.version
            : "unknown";
    } catch {
        return "unknown";
    }
}
