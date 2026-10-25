# Vendored auto-review patches

Applied to `vendor/auto-review.js` (upstream `lib/index.js`, rc.3):

1. The single `apply(ctx)` entry point becomes
   `createAutoReview(ctx, config, policy)`. The typed wrapper in `src/index.ts`
   supplies the fast/strong policy; the upstream fixed `REVIEW_POLICY` text is
   unchanged.
2. The built-in single-tier `classifyRisk`, `readDecision`, and `parseDecision`
   are removed. The wrapper's `src/policy.ts` implements routing, JSON
   validation, sudo escalation, fail-closed errors, and the per-call timeout.
3. On a reviewer denial under `approval/policy === "never"`, an in-process
   child (`session.header.origin === "subagent"` or `parentSession` present) is
   switched to the `ask` policy with `setApprovalPolicy()` before the tools
   pipeline resolves the `ask`. A root agent keeps the upstream terminal denial.
   The switch is skipped when the child is already under `ask`.
4. Reviewer failures now report the failing tier in the model-facing error.
5. The diagnostic plugin name is `nokoribi-reviewer`.

No other upstream behavior is changed. The wrapper keeps the upstream
`reviewUserText` and `REVIEW_POLICY` exports.
