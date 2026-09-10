import { Effect, FileSystem, Path } from "effect"

import { ARTIFACT_DIR_ENV, CLI_DATA_DIR_NAME, CLI_HOME_ENV } from "./constants"
import { ConfigurationError } from "./errors"

const homeDir = () =>
  Effect.sync(() => {
    const home = Bun.env.HOME ?? process.env.HOME
    if (!home || home.trim().length === 0) {
      throw new Error("HOME is not set")
    }
    return home
  }).pipe(
    Effect.mapError(
      () =>
        new ConfigurationError({
          field: "HOME",
          message: "HOME environment variable is not set",
        }),
    ),
  )

export const surveyHome = Effect.gen(function* () {
  const override = Bun.env[CLI_HOME_ENV]?.trim()
  if (override && override.length > 0) {
    return override
  }

  const path = yield* Path.Path
  const home = yield* homeDir()
  return path.join(home, ".config", CLI_DATA_DIR_NAME)
})

export const ensureSurveyHome = Effect.gen(function* () {
  const dir = yield* surveyHome
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.mapError(
      (error) =>
        new ConfigurationError({
          field: CLI_HOME_ENV,
          message: `Cannot create survey home ${dir}: ${error.message}`,
        }),
    ),
  )
  return dir
})

export const artifactDir = Effect.gen(function* () {
  const override = Bun.env[ARTIFACT_DIR_ENV]?.trim()
  if (override && override.length > 0) {
    return override
  }

  const path = yield* Path.Path
  const home = yield* ensureSurveyHome
  const dir = path.join(home, "artifacts")
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.mapError(
      (error) =>
        new ConfigurationError({
          field: ARTIFACT_DIR_ENV,
          message: `Cannot create artifact directory ${dir}: ${error.message}`,
        }),
    ),
  )
  return dir
})

export const storePath = Effect.gen(function* () {
  const path = yield* Path.Path
  const home = yield* ensureSurveyHome
  return path.join(home, "store.db")
})

export const authPath = Effect.gen(function* () {
  const path = yield* Path.Path
  const home = yield* ensureSurveyHome
  return path.join(home, "auth.json")
})
