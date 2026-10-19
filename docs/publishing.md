# Publishing and Releases

survey is distributed through npm only.

| Package | Contents |
|---|---|
| `@skastr0/survey` | Node wrapper (`bin/survey.js`) that runs the platform binary; `@firecrawl/anydoc` and `@firecrawl/pdf-inspector` as optional dependencies |
| `@skastr0/survey-darwin-arm64` | Bun standalone binary |
| `@skastr0/survey-darwin-x64` | Bun standalone binary |
| `@skastr0/survey-linux-arm64` | Bun standalone binary |
| `@skastr0/survey-linux-x64` | Bun standalone binary |

The workspace root `package.json` is `private: true`; publishable manifests
live in `packages/npm/*`. `bun run build:npm` copies the binaries from `dist/`
and the LICENSE into them. Windows is not built.

## Versioning

One version is pinned in seven places: the root `package.json`, the five
`packages/npm/*/package.json` files (including the wrapper's
`optionalDependencies`), and `CLI_VERSION` in `src/core/constants.ts`. Never edit
them by hand:

```bash
bun run bump              # patch
bun scripts/bump.ts minor # or major, or an exact x.y.z
```

The CLI protocol (command paths, input schemas, envelopes, error types, exit
codes) is the public surface. While at `0.x`, a minor bump may change it; record
every change to it in `CHANGELOG.md`.

## Release Steps

1. On `main`, with a clean tree: `bun run verify` and `bun run smoke`
   (optionally `bun scripts/smoke.ts dist/survey-darwin-arm64 --live`).
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version
   and date.
3. `bun run bump` and commit as `chore: bump version to x.y.z` (include the
   CHANGELOG change).
4. Tag `vx.y.z` on that commit.
5. Push `main` and the tag. Pushing the tag is the publish decision: it needs
   explicit approval.
6. `.github/workflows/npm-publish.yml` runs on `v*` tags in the protected
   `release` environment. It runs `verify` and `pack:dry-run`, then publishes
   the four platform packages and the wrapper with `--provenance` through npm
   trusted publishing (OIDC). It skips any `name@version` that already exists,
   so a failed run can be re-run safely.

## Verify a Release

```bash
npm view @skastr0/survey@x.y.z dist --json --prefer-online
npx -y @skastr0/survey@x.y.z --version
bunx @skastr0/survey@x.y.z doctor
```

## Rollback

npm versions are immutable. Fix a bad release by publishing a new patch, and
deprecate the bad version (`npm deprecate @skastr0/survey@x.y.z "<reason>"`)
or move the `latest` dist-tag back.

## Trusted Publishing Setup

Each of the five packages needs an npm trusted publisher for
`skastr0/survey-cli`, workflow `npm-publish.yml`, environment `release`. The
workflow needs `id-token: write` and must not set `registry-url` on
`actions/setup-node`: its `NODE_AUTH_TOKEN` placeholder blocks the OIDC
exchange (see the 0.1.1 publish fixes).
