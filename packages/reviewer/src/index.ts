import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-llm";

import {
    createAutoReview,
    inject as upstreamInject,
} from "../vendor/auto-review.js";
import { createPolicy } from "./policy.js";
import type { AutoReviewConfig } from "./types.js";

export { Config } from "./config.js";
export { isPrivilegedAction, parseDecision, createPolicy } from "./policy.js";
export type {
    AutoReviewConfig,
    ReviewAction,
    ReviewDecision,
    ReviewPolicy,
    ReviewRisk,
    ReviewSnapshot,
    ReviewerRoute,
} from "./types.js";

/** Loader plugin label; distinct from the upstream experimental package. */
export const name: string = "nokoribi-reviewer";

/** Host services required before Auto may be advertised. */
export const inject: string[] = upstreamInject;

/**
 * Install the patched Auto review gate with the configured fast/strong routes.
 * @param ctx - Cordis context owning the tool and permission seams.
 * @param config - validated reviewer configuration.
 */
export function apply(ctx: Context, config: AutoReviewConfig): void {
    createAutoReview(ctx, config, createPolicy(ctx.llm, config));
}
