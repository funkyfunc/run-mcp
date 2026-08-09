# Releasing

Publishing runs in CI via npm **trusted publishing (OIDC)** — no npm token, no
2FA/security-key in the loop. `.github/workflows/release.yml` triggers on a
version tag, runs the full suite on Linux + macOS, then publishes with build
provenance. **Pushing the tag is the approval** — there is no manual gate (the
`release` environment exists only to scope the npm trusted publisher; it has no
protection rules, matching `terminal-driver-mcp`).

## Per-release flow

1. Bump `version` in `package.json` — it is the **only** place the version
   lives. `tsup.config.ts` injects it as `PKG_VERSION` at build time, so the
   CLI, the agent server, and the MCP client identity all follow automatically.
2. Move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`.
3. Commit and land on `main` (green CI).
4. Tag and push:
   ```sh
   git tag -a vX.Y.Z -m "run-mcp vX.Y.Z: <summary>"
   git push origin vX.Y.Z
   ```
5. CI tests and publishes to npm via OIDC. Done.

The workflow fails fast if the tag doesn't match `package.json`, so a
mismatched tag can't publish.

## One-time setup

Both are done once and never again. **Neither can be scripted** — they are UI-only.

### 1. npm trusted publisher (on npmjs.com)

npmjs.com → the `run-mcp` package → **Settings** → **Trusted Publisher** → add a
**GitHub Actions** publisher:

- Organization / user: `funkyfunc`
- Repository: `run-mcp`
- Workflow filename: `release.yml`
- Environment: `release`

### 2. GitHub `release` environment (no protection rules)

Repo → **Settings** → **Environments** → **New environment** → `release`, with
**no required reviewers**. Its only job is matching the trusted-publisher config
above. To add a human gate later, put a required reviewer on the environment —
the workflow needs no change (this is how `browser-dvr-mcp` is configured).

## Notes

- Needs npm ≥ 11.5.1 in the runner for OIDC; the workflow upgrades npm
  explicitly since `actions/setup-node` ships an older version.
- Provenance requires a public repo and `id-token: write`.
- `prepublishOnly` runs the **full** build, not just `tsup`, because
  `npm run build` also regenerates the README's CLI help tables. CI additionally
  fails if a commit leaves those tables stale.
- Legacy 2FA-bypass automation tokens are being restricted by npm
  (Aug 2026 / Jan 2027); OIDC needs no stored secret and is the future-proof path.
- Local `npm publish` still works as a fallback but requires the interactive
  security-key/Touch ID step — prefer the CI path.
