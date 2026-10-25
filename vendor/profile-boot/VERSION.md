# Vendored profile-boot

- Upstream package: `@deepseek-ai/dsh`
- Upstream version: `0.2.1-rc.3`
- Upstream source file: `lib/profile-boot-C14i-8IN.js`
- License: MIT (see `LICENSE`)
- Vendored for: the thin `@nokoribi/launcher` boot path, without depending on
  the full `@deepseek-ai/dsh` CLI package.

The file is the upstream compiled chunk, renamed to `profile-boot.js`; a small
wrapper (`index.js`) exposes readable names, and `index.d.ts` declares the
subset used by this repository. Patches are listed in `PATCHES.md`.
