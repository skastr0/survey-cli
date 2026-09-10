import { Effect, Schema } from "effect"

import type { AppEnv } from "../core/env"

import { makeJsonCommand } from "../core/command"
import { registerContract } from "../core/discovery"
import { StoreError } from "../core/errors"
import { storePath } from "../core/paths"
import { keenableApi } from "../providers/keenable"

export const SqlInput = Schema.Struct({
  query: Schema.NonEmptyString,
  local: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int),
})
export type SqlInput = typeof SqlInput.Type

const FORBIDDEN_LOCAL = /^\s*(insert|update|delete|drop|alter|create|attach|pragma|vacuum|replace)\b/i

export const sqlQuery = Effect.fn("sqlQuery")(function* (input: SqlInput) {
  if (input.local) {
    if (FORBIDDEN_LOCAL.test(input.query)) {
      return yield* new StoreError({
        operation: "sql.local",
        message: "local queries are read-only (SELECT only)",
      })
    }
    const path = yield* storePath
    const rows = yield* Effect.tryPromise({
      try: async () => {
        const { Database } = await import("bun:sqlite")
        const db = new Database(path, { readonly: true })
        try {
          return db.query(input.query).all()
        } finally {
          db.close()
        }
      },
      catch: (error) =>
        new StoreError({
          operation: "sql.local",
          message: error instanceof Error ? error.message : String(error),
        }),
    })
    const limited = input.limit ? rows.slice(0, input.limit) : rows
    return { engine: "sqlite", path, rows: limited, count: limited.length }
  }

  const result = yield* keenableApi.select({ query: input.query } as never) as Effect.Effect<
    unknown,
    unknown,
    AppEnv
  >
  return { engine: "keenable", result }
})

export const sqlCommand = makeJsonCommand({
  name: "sql",
  commandName: "sql",
  description: "Run a SQL query — Keenable SELECT over the live web, or local store.db with local:true",
  schema: SqlInput,
  run: (input) => sqlQuery(input),
})

registerContract({
  command: "sql",
  description: "SQL over live web (Keenable) or the local survey store",
  inputSchema: SqlInput,
  examples: [
    { name: "keenable select", input: { query: "SELECT * FROM web_search('effect ts') LIMIT 5" } },
    {
      name: "local sources",
      input: { query: "SELECT provider, COUNT(*) FROM sources GROUP BY provider", local: true },
    },
  ],
})
