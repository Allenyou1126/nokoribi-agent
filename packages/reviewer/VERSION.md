# Vendored auto-review

- Upstream package: `@deepseek-ai/dsh-experimental-auto-review`
- Upstream version: `0.2.1-rc.3`
- Upstream source file: `lib/index.js`
- Upstream source SHA-256: `14b0fec944f734a888468b75ee9d7ae121383f018ce5bf76c4506393a910787f`
- License: MIT (see `LICENSE`)
- Vendored for: fast/strong reviewer routing, sudo escalation, reviewer timeout,
  and in-process child approval bridging on the Nokoribi IM profile.

The vendored file is the upstream compiled module, copied into
`vendor/auto-review.js`. Our typed policy lives in `src/policy.ts`; the patch
list is in `PATCHES.md`. When bumping DSH, copy the new upstream file, re-apply
the patches, and update this file.
