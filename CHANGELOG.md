# Changelog

All notable changes to this project are documented here. The public surface
is the CLI protocol: command paths, JSON input schemas, envelopes, error
types, and exit codes. It follows Semantic Versioning; while the version is
`0.x`, minor releases may change that surface.

## [Unreleased]

The workspace version was bumped to 0.1.2 and 0.1.3 without a tag or npm
release; everything since 0.1.1 ships together in the next tagged release.

### Added

- Local research corpus: every fetched page, file, and note is versioned and
  FTS5-indexed (`corpus add|search|grep|read|diff|versions|stats`); search
  hits report best-matching line numbers. `fetch` stores pages in the corpus
  with a `max_age_ms` cache and a `changed` flag.
- `pipe`: declarative multi-step pipelines over survey commands.
- `mcp serve`: every registered command as an MCP tool over stdio.
- `compare` (providers side by side) and `watch` (page change detection).
- TinyFish provider (search, fetch, browser agent, research, monitors) and
  TinyFish in unified search, fetch fallback, research jury, and monitor.
- Keyless local document providers `anydoc` and `pdf-inspector`, local-first
  routing in unified `convert`/`extract`, conversions remembered in the
  corpus; both tools ship as optional dependencies of the npm wrapper.
- Unified search fuses results with Reciprocal Rank Fusion and reports
  per-provider ranks.
- Every `--help` ends with a CONTRACT section: input mode and required
  fields, return shape, lifecycle, example names, and the `schema show` call.
- `capabilities` lists each command's real flags (read from the parser),
  input mode, and required fields, plus exit codes, the error details
  contract, artifact policy, and which commands accept `--idempotency-key`.
- `schema show` adds input mode, batch support, required fields, flags,
  output notes, lifecycle, and example names; `doctor` adds a readiness
  summary and a `next_step` for each provider missing a key.
- Artifact records carry `created_at` and a read-back `next_step`.

### Changed

- `capabilities` no longer claims `--timeout`, `--wait`, and
  `--idempotency-key` are global; see `commands[].flags`.
- Schema mismatches are `JsonInputError` with `reason: "InvalidShape"` and
  `details.issues[{path, message}]`; unparseable text keeps
  `reason: "InvalidJson"` with the parser's message.
- Every failure envelope carries `details.retryable` and `details.hint`;
  input errors add a `next_step` naming `survey schema show "<command>"`.

### Fixed

- Unknown commands, unknown flags, and missing arguments no longer print help
  to stdout with a `~effect/cli/CliError/ShowHelp` envelope. They emit one
  `CliUsageError` envelope on stderr (issues, suggestions, next_step), exit 1.
- Failures raised as plain `{ _tag }` records (for example unified `extract`
  without `PARALLEL_API_KEY`) rendered as `{ type: "Error", message:
  "[object Object]" }`; they now render as their typed error.
- Defects render the underlying message with the trace in `details.trace`
  and name the failing command.
- Advertised input schemas no longer show phantom `null` branches; `runs`,
  `sources`, `llama`, and `exa` commands have complete contracts.

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
