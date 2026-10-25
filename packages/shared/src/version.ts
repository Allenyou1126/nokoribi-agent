/** Version used when the launcher does not provide one. */
export const DEFAULT_VERSION: string = "0.0.0-dev";

/** Resolve the runtime version from the launcher environment. */
export function resolveVersion(
    env: Record<string, string | undefined> = process.env
): string {
    const value = env.NOKORIBI_VERSION?.trim();
    return value === undefined || value === "" ? DEFAULT_VERSION : value;
}
