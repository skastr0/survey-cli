import type { SourceSummary } from "./source"

export interface ToolRun {
  readonly mode: string
  readonly version: string | null
}

export const toolEnvelope = (
  tool: string,
  operation: string,
  run: ToolRun,
  source: SourceSummary,
  startedAt: number,
) => ({
  tool: { name: tool, mode: run.mode, version: run.version },
  operation,
  source,
  elapsed_ms: Date.now() - startedAt,
})
