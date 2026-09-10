import type { FileSystem, Path } from "effect"
import type { HttpClient } from "effect/unstable/http"

import type { Store } from "./store"

/** Services provided by the runtime layer at src/cli.ts. */
export type AppEnv = HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Store
