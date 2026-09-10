# @skastr0/survey

Consolidated researcher toolkit CLI — Exa, Firecrawl, Parallel, Keenable, and
LlamaCloud behind one JSON-first binary with cross-provider search, fetch,
extract, research, verify, runs, sources, monitor, and sql.

Installs a platform-specific compiled Bun binary; no Bun or Node runtime needed
to run `survey` (Node ≥18 is only used by the tiny resolver shim).

```bash
npm i -g @skastr0/survey
survey doctor
survey search '{"query": "effect v4 schema"}'
survey exa web-search '{"query": "..."}'
survey firecrawl scrape '{"url": "..."}'
```
