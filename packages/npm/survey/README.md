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

## Local document tools

`@firecrawl/anydoc` and `@firecrawl/pdf-inspector` are optional dependencies of this package, so a
normal `npm i -g @skastr0/survey` also installs them (where a native build exists for your platform;
pdf-inspector has none for darwin-x64). `survey doctor` reports `local_tools[].mode`, and
`survey convert '{"path":"./file.pdf"}'` uses them with no API key and no network.
