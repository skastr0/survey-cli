import { Effect, Option, Schema } from "effect"
import { Command } from "effect/unstable/cli"

import {
  applyOutputPolicy,
  concurrencyFlag,
  jsonInputArg,
  makeJsonCommand,
  optionalJsonInputArg,
  outputFlag,
} from "../../core/command"
import { runMutationBatch } from "../../core/batch"
import { CommandInputError } from "../../core/errors"
import { decodeJsonValue, loadJsonInput } from "../../core/json"
import { executeJsonCommand } from "../../core/output"
import {
  deleteFile,
  FILE_PURPOSES,
  getFile,
  getFileContent,
  listFiles,
  uploadFile,
} from "./api"

const FilePurposeSchema = Schema.Literals(FILE_PURPOSES)

export const filesUploadInputSchema = Schema.Struct({
  file_path: Schema.String,
  purpose: FilePurposeSchema,
  file_name: Schema.optional(Schema.String),
  external_file_id: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const filesInspectInputSchema = Schema.Struct({
  file_id: Schema.String,
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const filesContentInputSchema = Schema.Struct({
  file_id: Schema.String,
  expires_at_seconds: Schema.optional(Schema.Number),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const filesListInputSchema = Schema.Struct({
  page_size: Schema.optional(Schema.Number),
  page_token: Schema.optional(Schema.String),
  file_name: Schema.optional(Schema.String),
  file_ids: Schema.optional(Schema.Array(Schema.String)),
  external_file_id: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

export const filesDeleteInputSchema = filesInspectInputSchema

type FilesUploadItem = typeof filesUploadInputSchema.Type

const validatePositiveInteger = (field: string, value: number | undefined) => {
  if (value === undefined) {
    return Effect.void
  }

  if (!Number.isInteger(value) || value <= 0) {
    return Effect.fail(
      new CommandInputError({
        field,
        message: `${field} must be a positive integer`,
      }),
    )
  }

  return Effect.void
}

const validateUploadItem = (item: FilesUploadItem) =>
  Effect.gen(function* () {
    if (item.file_path.trim().length === 0) {
      yield* Effect.fail(
        new CommandInputError({
          field: "file_path",
          message: "file_path is required",
        }),
      )
    }

    if (item.file_name !== undefined && item.file_name.trim().length === 0) {
      yield* Effect.fail(
        new CommandInputError({
          field: "file_name",
          message: "file_name cannot be empty",
        }),
      )
    }
  })

const uploadOne = (item: FilesUploadItem) =>
  uploadFile({
    filePath: item.file_path,
    purpose: item.purpose,
    ...(item.file_name !== undefined ? { fileName: item.file_name } : {}),
    ...(item.external_file_id !== undefined
      ? { externalFileId: item.external_file_id }
      : {}),
    ...(item.organization_id !== undefined
      ? { organizationId: item.organization_id }
      : {}),
    ...(item.project_id !== undefined ? { projectId: item.project_id } : {}),
  })

const filesUploadCommand = Command.make(
  "upload",
  { input: jsonInputArg, concurrency: concurrencyFlag, output: outputFlag },
  ({ input, concurrency, output }) =>
    executeJsonCommand(
      "llama files upload",
      Effect.gen(function* () {
        const decoded = yield* loadJsonInput(Schema.Unknown, input)

        if (!Array.isArray(decoded)) {
          const item = yield* loadJsonInput(filesUploadInputSchema, input)
          yield* validateUploadItem(item)
          const data = yield* uploadOne(item)
          return yield* applyOutputPolicy({
            command: "llama files upload",
            mode: output,
            data,
          })
        }

        const summary = yield* runMutationBatch({
          input,
          concurrency,
          itemSchema: filesUploadInputSchema,
          validate: validateUploadItem,
          run: (item) => uploadOne(item),
        })

        return yield* applyOutputPolicy({
          command: "llama files upload",
          mode: output,
          data: summary,
        })
      }),
    ),
).pipe(Command.withDescription("Upload one or more local files to LlamaCloud"))

const filesInspectCommand = makeJsonCommand({
  name: "inspect",
  commandName: "llama files inspect",
  description: "Get uploaded file metadata by file_id",
  schema: filesInspectInputSchema,
  run: (payload) =>
    Effect.gen(function* () {
      if (payload.file_id.trim().length === 0) {
        return yield* new CommandInputError({
          field: "file_id",
          message: "file_id is required",
        })
      }

      return yield* getFile({
        fileId: payload.file_id,
        ...(payload.organization_id !== undefined
          ? { organization_id: payload.organization_id }
          : {}),
        ...(payload.project_id !== undefined ? { project_id: payload.project_id } : {}),
      })
    }),
})

const filesContentCommand = makeJsonCommand({
  name: "content",
  commandName: "llama files content",
  description: "Get a presigned download URL for an uploaded file",
  schema: filesContentInputSchema,
  run: (payload) =>
    Effect.gen(function* () {
      if (payload.file_id.trim().length === 0) {
        return yield* new CommandInputError({
          field: "file_id",
          message: "file_id is required",
        })
      }

      yield* validatePositiveInteger("expires_at_seconds", payload.expires_at_seconds)

      return yield* getFileContent({
        fileId: payload.file_id,
        ...(payload.expires_at_seconds !== undefined
          ? { expiresAtSeconds: payload.expires_at_seconds }
          : {}),
        ...(payload.organization_id !== undefined
          ? { organization_id: payload.organization_id }
          : {}),
        ...(payload.project_id !== undefined ? { project_id: payload.project_id } : {}),
      })
    }),
})

const filesListCommand = Command.make(
  "list",
  { input: optionalJsonInputArg, output: outputFlag },
  ({ input, output }) =>
    executeJsonCommand(
      "llama files list",
      Effect.gen(function* () {
        const payload = Option.isNone(input)
          ? yield* decodeJsonValue(filesListInputSchema, {}, "default")
          : yield* loadJsonInput(filesListInputSchema, input.value)
        yield* validatePositiveInteger("page_size", payload.page_size)

        const data = yield* listFiles({
          ...(payload.page_size !== undefined ? { pageSize: payload.page_size } : {}),
          ...(payload.page_token !== undefined ? { pageToken: payload.page_token } : {}),
          ...(payload.file_name !== undefined ? { fileName: payload.file_name } : {}),
          ...(payload.file_ids !== undefined ? { fileIds: payload.file_ids } : {}),
          ...(payload.external_file_id !== undefined
            ? { externalFileId: payload.external_file_id }
            : {}),
          ...(payload.organization_id !== undefined
            ? { organizationId: payload.organization_id }
            : {}),
          ...(payload.project_id !== undefined ? { projectId: payload.project_id } : {}),
        })

        return yield* applyOutputPolicy({
          command: "llama files list",
          mode: output,
          data,
        })
      }),
    ),
).pipe(Command.withDescription("List uploaded files with optional filters"))

const filesDeleteCommand = makeJsonCommand({
  name: "delete",
  commandName: "llama files delete",
  description: "Delete an uploaded file",
  schema: filesDeleteInputSchema,
  run: (payload) =>
    Effect.gen(function* () {
      if (payload.file_id.trim().length === 0) {
        return yield* new CommandInputError({
          field: "file_id",
          message: "file_id is required",
        })
      }

      return yield* deleteFile({
        fileId: payload.file_id,
        ...(payload.organization_id !== undefined
          ? { organization_id: payload.organization_id }
          : {}),
        ...(payload.project_id !== undefined ? { project_id: payload.project_id } : {}),
      })
    }),
})

export const filesCommand = Command.make("files").pipe(
  Command.withDescription("LlamaCloud file upload and management"),
  Command.withSubcommands([
    filesUploadCommand,
    filesListCommand,
    filesInspectCommand,
    filesContentCommand,
    filesDeleteCommand,
  ]),
)
