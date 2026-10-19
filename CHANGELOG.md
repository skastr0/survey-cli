# Changelog

All notable changes to this project are documented here. The public surface
is the CLI protocol: command paths, JSON input schemas, envelopes, error
types, and exit codes. It follows Semantic Versioning; while the version is
`0.x`, minor releases may change that surface.

## [Unreleased]

## [0.1.5] - 2026-10-19

First release since 0.1.1. Versions 0.1.2–0.1.4 were bumped in the workspace
but never tagged or published.

### Added

- **Keyless access.** A provider tier model resolves each provider ×
  capability to `keyed | public | local | unavailable` and `free | paid`.
  Unified `search`, `fetch`, and `extract` route through it, so Exa, Parallel,
  Firecrawl, and Keenable work without keys (Exa and Parallel via their hosted
  MCP free tiers; responses carry `auth_mode`). `tier: "free"` restricts a call
  to providers that spend no account credits; results report
  `routing {provider, mode, cost}`.
- **TinyFish provider**: search, fetch, browser agent, research, profiles,
  vault, monitors, usage. TinyFish also joins unified search, the fetch
  fallback chain, the research jury, and `monitor`.
- **Local document tools** `anydoc` and `pdf-inspector` (keyless, offline),
  shipped as optional dependencies of the npm wrapper. Unified `convert` and
  `extract` route local first; `convert {dir}` and `corpus add {dir}` ingest a
  whole folder, skipping files whose sha256 is unchanged.
- **Local corpus**: fetched pages, conversions, TinyFish results, and
  research/verify reports are versioned and FTS5-indexed in `store.db`
  (`corpus add|search|grep|read|diff|versions|list|stats|remove|prune`).
  `fetch` gains a `max_age_ms` cache and a `changed` flag; `search {read_top}`
  reads the top fused results into the corpus.
- **Composition**: `pipe` runs declarative multi-step pipelines over survey
  commands; `mcp serve` exposes every command as an MCP tool over stdio
  (`mcp tools`, `mcp config` for client setup, per-call `timeout_ms`).
- **Research**: `papers` (Firecrawl Research Index with an arXiv web fallback),
  `firecrawl research *` paper commands, and `domain: auto|web|academic` on
  `research` and `verify`; `compare` shows providers side by side; `watch`
  detects page changes.
- **Agent discovery**: every `--help` ends with a CONTRACT section (input mode,
  required fields, return shape, examples, schema pointer). `capabilities`
  lists each command's real flags, input mode, required fields, exit codes,
  error details contract, artifact policy, tier matrix, and keyless
  capabilities. `doctor` adds a readiness summary, per-capability access, and a
  `next_step` per missing key. `schema show` adds input mode, required fields,
  flags, output, lifecycle, and example names. Artifact records carry
  `created_at` and a read-back `next_step`.

### Changed

- Unified search fuses results with Reciprocal Rank Fusion and reports
  per-provider `ranks`; raw cross-provider scores are no longer compared.
- `capabilities` no longer claims `--timeout`, `--wait`, and
  `--idempotency-key` are global; see `commands[].flags`.
- Schema mismatches are `JsonInputError` with `reason: "InvalidShape"` and
  `details.issues[{path, message}]`; unparseable text keeps
  `reason: "InvalidJson"` with the parser's message. Every failure carries
  `details.retryable` and `details.hint`, plus `next_step` where a recovery
  call exists.

### Fixed

- Unknown commands, unknown flags, and missing arguments printed help to stdout
  with a `ShowHelp` envelope; they now emit one `CliUsageError` on stderr and
  exit 1 with empty stdout.
- Unified `extract`, `fetch`, and `runs wait` failed with plain objects
  (`"[object Object]"`); they raise typed errors, and fetch reports every
  attempted provider.
- `runs`: Llama parse status, Parallel FindAll ids, and Firecrawl batch
  endpoints were wrong, so some runs never left `running`.
- `pipe` children return inline data instead of artifact pointers, timed-out
  steps are killed, and no-input commands run.
- `mcp serve` no longer answers notifications or crashes on malformed messages.
- Corpus search quotes stray `AND/OR/NOT`, file keys keep `#`/`?`, and empty
  diffs have no phantom line.
- Advertised input schemas no longer show phantom `null` branches; `runs`,
  `sources`, `llama`, `exa`, and `parallel monitors list` have complete
  contracts.

## [0.1.1] - 2026-09-13

### Fixed

- Unified `fetch` reads content under the `data` key for Firecrawl and
  Keenable responses.
- npm publishing uses trusted publishing with provenance.

## [0.1.0] - 2026-09-10

### Added

- Initial release: one JSON-first Effect v4 binary over Exa, Firecrawl,
  Parallel, Keenable, and LlamaCloud, with unified `search`, `fetch`,
  `extract`, `research`, `verify`, `monitor`, `sql`, `runs`, and `sources`.
- npm wrapper `@skastr0/survey` with per-platform binary packages for macOS
  and Linux.
