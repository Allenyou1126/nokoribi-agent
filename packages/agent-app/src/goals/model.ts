import type { GoalModelRef } from "@nokoribi/shared";

/**
 * Parse one exact `provider/model` route.
 * @param value - route text from a command or tool argument.
 * @returns the parsed route, or undefined when malformed.
 */
export function parseModelRoute(value: string): GoalModelRef | undefined {
    const trimmed = value.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) return undefined;
    const provider = trimmed.slice(0, slash).trim();
    const model = trimmed.slice(slash + 1).trim();
    if (provider === "" || model === "") return undefined;
    return { provider, model };
}

/**
 * Parse the deployment allowlist, rejecting malformed or duplicate routes.
 * @param values - comma-split route strings from configuration.
 * @returns detached exact routes in configuration order.
 * @throws when a route is malformed or repeated.
 */
export function parseAllowedModels(values: readonly string[]): GoalModelRef[] {
    const routes: GoalModelRef[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (value.trim() === "") continue;
        const route = parseModelRoute(value);
        if (route === undefined) {
            throw new Error(
                `invalid goal model route ${JSON.stringify(value)}; ` +
                    "expected provider/model"
            );
        }
        const key = `${route.provider}\0${route.model}`;
        if (seen.has(key)) {
            throw new Error(
                `duplicate goal model route ${JSON.stringify(value)}`
            );
        }
        seen.add(key);
        routes.push(route);
    }
    return routes;
}

/**
 * Render a route for prompts, errors, and status output.
 * @param route - exact provider/model route.
 * @returns `provider/model` with an optional effort suffix.
 */
export function formatModelRoute(route: GoalModelRef): string {
    const effort = route.reasoningEffort?.trim();
    return effort === undefined || effort === ""
        ? `${route.provider}/${route.model}`
        : `${route.provider}/${route.model} (${effort})`;
}
