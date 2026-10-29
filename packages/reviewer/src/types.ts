/** One configured reviewer model route. */
export interface ReviewerRoute {
    readonly provider: string;
    readonly model: string;
    /** Adapter-owned reasoning effort; empty string means the adapter default. */
    readonly reasoningEffort?: string;
}

/** Reviewer configuration owned by the vendored auto-review plugin. */
export interface AutoReviewConfig {
    readonly fast: ReviewerRoute;
    readonly strong: ReviewerRoute;
    /** Per-call reviewer deadline in milliseconds. */
    readonly timeoutMs: number;
    /** Tool names that bypass the Auto review gate; empty reviews everything. */
    readonly exemptTools: readonly string[];
}

/** Risk classes accepted by the upstream reviewer protocol. */
export type ReviewRisk = "low" | "medium" | "high";

/** One validated reviewer decision. */
export type ReviewDecision =
    | { readonly risk: "low" | "medium"; readonly decision: "allow" }
    | {
          readonly risk: "medium" | "high";
          readonly decision: "deny";
          readonly reason?: string;
      };

/** One pending action as reconstructed from the session log. */
export interface ReviewAction {
    readonly mode: "native" | "ptc-inner";
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly arguments: unknown;
}

/** Frozen reviewer input: route, cwd, instructions, history, and pending action. */
export interface ReviewSnapshot {
    readonly provider: string;
    readonly model: string;
    readonly cwd: string;
    readonly projectInstructions: readonly unknown[];
    readonly history: readonly unknown[];
    readonly action: ReviewAction;
}

/** Policy seam implemented by this package and called by the vendored pipeline. */
export interface ReviewPolicy {
    review(
        snapshot: ReviewSnapshot,
        signal: AbortSignal
    ): Promise<ReviewDecision>;
}
