# Changelog

All notable changes to this project are documented here. The public surface
is the CLI protocol: command paths, JSON input schemas, envelopes, error
types, and exit codes. It follows Semantic Versioning; while the version is
`0.x`, minor releases may change that surface.

## [Unreleased]

## [0.1.9] - 2026-10-22

### Added

- `survey guide`: the agent playbook embedded in the binary — an overview and
  topic list, one topic with the live contracts (description, output, example)
  of its commands, or `{"format":"skill"}` for the whole playbook as SKILL.md.
  Root `--help` and `capabilities.discovery` point to it first.
  `skills/survey/SKILL.md` is now rendered from the same source.

## [0.1.8] - 2026-10-21

### Changed

- Keenable is the preferred provider (it leads the Vals Web Search Index,
  Oct 2026). Unified `search` fuses with weighted Reciprocal Rank Fusion,
  Keenable 1.5× by default, so fused lists read Keenable-first while URLs
  corroborated by two other providers still lead; `{weights}` overrides per
  call and responses report `fusion {method, k, weights}`. Keenable is first in
  search routing and in the `fetch` fallback chain
  (keenable → firecrawl → tinyfish → exa → parallel).

## [0.1.7] - 2026-10-19

First release since 0.1.1. Versions 0.1.2–0.1.5 were never tagged; v0.1.6
was tagged but its publish stopped on a CI test failure, so nothing between
0.1.1 and 0.1.7 reached npm.

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
  reads the top fused results into the corpus. Agents curate and hand off with
  `corpus tag`, `corpus links` (outbound URLs, `new_only` for unread ones),
  `corpus export` (jsonl, markdown, or a markdown bundle), and `corpus import`
  (idempotent jsonl round-trip with version history).
- **Composition**: `pipe` runs declarative multi-step pipelines over survey
  commands; `mcp serve` exposes every command as an MCP tool over stdio
  (`mcp tools`, `mcp config` for client setup, per-call `timeout_ms`).
- **Research**: `papers` (Firecrawl Research Index with an arXiv web fallback),
  `firecrawl research *` paper commands, and `domain: auto|web|academic` on
  `research` and `verify`; `compare` shows providers side by side; `watch`
  detects page changes. `research start|check|wait|inspect` runs the jury
  without blocking. `verify` and research citations count independent
  sources: the same page, registrable domain, or syndicated copy counts once
  (`independent_sources`, `source_groups`, `confidence_basis`).
- **Agent discovery**: every `--help` ends with a CONTRACT section (input mode,
  required fields, return shape, examples, schema pointer). `capabilities`
  lists each command's real flags, input mode, required fields, exit codes,
  error details contract, artifact policy, tier matrix, and keyless
  capabilities. `doctor` adds a readiness summary, per-capability access, and a
  `next_step` per missing key. `schema show` adds input mode, required fields,
  flags, output, lifecycle, and example names. Artifact records carry
  `created_at` and a read-back `next_step`.
- Every provider and capability contract documents its `output` (the shape of
  `data`) and says what it does, its key inputs, and what it returns; MCP tool
  descriptions include the output shape.
- `NotFoundError` for well-formed requests naming something absent, and
  `capabilities.errors.types` catalogs every error type.

### Changed

- Unified search fuses results with Reciprocal Rank Fusion and reports
  per-provider `ranks`; raw cross-provider scores are no longer compared.
- `capabilities` no longer claims `--timeout`, `--wait`, and
  `--idempotency-key` are global. By default it prints one line per command
  (summary, input mode, flags); `{"detail":"full"}` and
  `{"command":"<prefix or glob>"}` return full rows.
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
- Concurrent survey processes (pipe `foreach`, parallel agents) failed with
  `database is locked` or `no such table`; writes and first-run migrations now
  take the SQLite write lock up front and wait up to 15 s.
- Live validation against every provider fixed: Llama parse decode
  (`user_metadata: null`), Exa keyless fetch truncation, Parallel keyless
  `num_results`, Parallel task schema defaults, Exa verify citations, objective-
  only `extract`, and unrecorded async Firecrawl extract runs.
- `pipe` exits 1 when any step failed; `research start` fails when no member
  can start; missing corpus documents, runs, and research ids raise
  `NotFoundError`; `runs inspect` returns the refreshed status and run
  `payload` is an object, not a JSON string.
- Pipe references: `$.50`-style strings stay literal, `{{ name }}` that is not
  a reference passes through, and malformed slices are rejected.
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
