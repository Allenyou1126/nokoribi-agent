import type { Context } from "@deepseek-ai/cordis";

import type {
    AutoReviewConfig,
    ReviewPolicy,
    ReviewSnapshot,
} from "../src/types.js";

export declare const name: string;
export declare const inject: string[];
export declare const REVIEW_POLICY: string;
export declare function reviewUserText(snapshot: ReviewSnapshot): string;
export declare function createAutoReview(
    ctx: Context,
    config: AutoReviewConfig,
    policy: ReviewPolicy
): void;
