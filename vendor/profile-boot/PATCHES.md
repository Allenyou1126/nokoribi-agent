# Vendored profile-boot patches

Applied to `profile-boot.js` (upstream `lib/profile-boot-C14i-8IN.js`):

1. `PROCESS_SHUTDOWN_TIMEOUT_MS` is configurable via
   `NOKORIBI_SHUTDOWN_TIMEOUT_MS` (default 30000 ms instead of 5000 ms), so the
   daemon can wait for the in-flight turn before the process exits.
2. The diagnostic name is `nokoribi-agent` instead of `dsh`.
3. `INSTALL_ANCHOR` can be overridden with `NOKORIBI_INSTALL_ANCHOR`; the
   launcher passes its own `package.json` path. The launcher always supplies a
   `resolvedProfile`, so this constant is only a defensive fallback.

No other behavior is changed. When bumping the DSH version, re-copy the
upstream profile-boot chunk, re-apply these three patches, and update
`VERSION.md`.
