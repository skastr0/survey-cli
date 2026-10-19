import { registerContracts } from "../../core/discovery"
import {
  extractCreateInputSchema,
  extractGetInputSchema,
  extractListInputSchema,
  extractRunInputSchema,
  extractWaitInputSchema,
} from "./extract"
import {
  filesContentInputSchema,
  filesDeleteInputSchema,
  filesInspectInputSchema,
  filesListInputSchema,
  filesUploadInputSchema,
} from "./files"
import {
  parseCreateInputSchema,
  parseListInputSchema,
  parseResultInputSchema,
  parseRunInputSchema,
  parseUploadInputSchema,
  parseVersionsInputSchema,
  parseWaitInputSchema,
} from "./parse"

const filesOrbit = ["upload", "list", "inspect", "content", "delete"] as const
const parseOrbit = [
  "create",
  "upload",
  "list",
  "result",
  "wait",
  "run",
  "versions",
] as const
const extractOrbit = ["create", "get", "list", "wait", "run"] as const

registerContracts([
  {
    command: "llama files upload",
    description:
      "Upload a local file to LlamaCloud for parse, extract, classify, split, or other purposes. Input: {file_path, purpose, file_name?}, or an array for batch. Returns the file record {id, name, purpose}.",
    output:
      "{ id, name?, project_id?, file_type?, purpose?, expires_at?, external_file_id?, last_modified_at? } (provider file record); array input returns a batch summary { outcome, total, success_count, error_count, results: [{ index, ok, data | error }] }",
    inputSchema: filesUploadInputSchema,
    batch: true,
    orbit: filesOrbit,
    examples: [
      {
        name: "upload pdf for parse",
        input: { file_path: "./document.pdf", purpose: "parse" },
      },
    ],
  },
  {
    command: "llama files list",
    description:
      "List uploaded LlamaCloud files. Input (optional): {page_size?, page_token?, file_name?, file_ids?, external_file_id?}. Returns {items: [file records], next_page_token}.",
    output:
      "{ items: [{ id, name?, file_type?, purpose?, external_file_id?, last_modified_at? }], next_page_token?, total_size? }",
    inputSchema: filesListInputSchema,
    orbit: filesOrbit,
    examples: [
      { name: "first page", input: { page_size: 25 } },
      { name: "by file name", input: { file_name: "invoice.pdf" } },
    ],
  },
  {
    command: "llama files inspect",
    description:
      "Get uploaded file metadata. Input: {file_id}. Returns the provider file record {id, name, file_type, purpose, expires_at}.",
    output:
      "{ id, name?, project_id?, file_type?, purpose?, expires_at?, external_file_id?, last_modified_at?, download_url? } (provider file record; extra provider fields pass through)",
    inputSchema: filesInspectInputSchema,
    orbit: filesOrbit,
    examples: [
      { name: "file metadata", input: { file_id: "dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
    ],
  },
  {
    command: "llama files content",
    description:
      "Get a presigned download URL for an uploaded file. Input: {file_id, expires_at_seconds?}. Returns {url, expires_at, form_fields?}.",
    output:
      "{ url?, expires_at?, form_fields? }",
    inputSchema: filesContentInputSchema,
    orbit: filesOrbit,
    examples: [
      { name: "presigned download url", input: { file_id: "dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", expires_at_seconds: 3600 } },
    ],
  },
  {
    command: "llama files delete",
    description:
      "Delete an uploaded file (DELETE /api/v1/beta/files/{id}). Input: {file_id}. Returns {deleted: true, file_id}.",
    output:
      "{ deleted: true, file_id }",
    inputSchema: filesDeleteInputSchema,
    orbit: filesOrbit,
    examples: [
      { name: "delete a file", input: { file_id: "dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
    ],
  },
  {
    command: "llama parse create",
    description:
      "Start a LlamaParse v2 job from exactly one of file_id or source_url. Input: {file_id|source_url, tier?, version?}. Returns the job {id, status}; --wait returns the parse result instead.",
    output:
      "{ id, status, project_id?, tier?, name?, created_at?, error_message? } (provider parse job); with --wait: { job, markdown?, text?, ... } as in llama parse result",
    inputSchema: parseCreateInputSchema,
    orbit: parseOrbit,
    examples: [
      {
        name: "parse from file_id",
        input: {
          file_id: "dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          tier: "agentic",
          version: "latest",
        },
      },
      {
        name: "parse with saved configuration",
        description:
          "configuration_id payloads are sent without default tier/version overrides.",
        input: {
          file_id: "dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          configuration_id: "cfg-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        },
      },
    ],
  },
  {
    command: "llama parse upload",
    description:
      "Upload a local file and start a parse job in one multipart request. Input: {file_path, tier?, version?}. Returns the job {id, status}; poll with llama parse wait or pass --wait.",
    output:
      "{ id, status, project_id?, tier?, name?, created_at?, error_message? } (provider parse job); with --wait: { job, markdown?, text?, ... } as in llama parse result",
    inputSchema: parseUploadInputSchema,
    orbit: parseOrbit,
    examples: [
      { name: "upload and parse a local pdf", input: { file_path: "./document.pdf", tier: "agentic", version: "latest" } },
    ],
  },
  {
    command: "llama parse list",
    description:
      "List LlamaParse jobs. Input (optional): {page_size?, page_token?, status?}. Returns {items: [jobs {id, status, tier}], next_page_token}.",
    output:
      "{ items: [{ id, status, tier?, name?, created_at?, updated_at?, error_message? }], next_page_token?, total_size? }",
    inputSchema: parseListInputSchema,
    orbit: parseOrbit,
    examples: [
      { name: "recent parse jobs", input: { page_size: 10 } },
      { name: "completed only", input: { status: "COMPLETED" } },
    ],
  },
  {
    command: "llama parse result",
    description:
      "Get a parse job's status and expanded results once. Input: {job_id, expand?} (e.g. markdown, text, items). Returns {job: {id, status}, markdown?, text?, items?, metadata?}.",
    output:
      "{ job: { id, status, tier?, error_message? }, markdown?, text?, items?, metadata?, job_metadata?, markdown_full?, text_full?, result_content_metadata?, images_content_metadata? } (provider payload; content keys present per expand)",
    inputSchema: parseResultInputSchema,
    orbit: parseOrbit,
    examples: [
      { name: "markdown result", input: { job_id: "pjb-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", expand: ["markdown"] } },
    ],
  },
  {
    command: "llama parse wait",
    description:
      "Poll a parse job until COMPLETED; fails on FAILED, CANCELLED, or timeout. Input: {job_id, expand?, timeout_seconds?}. Returns the parse result {job, markdown?}; default expand markdown.",
    output:
      "{ job: { id, status: \"COMPLETED\" }, markdown?, text?, items?, metadata? } (same shape as llama parse result; content keys per expand)",
    inputSchema: parseWaitInputSchema,
    orbit: parseOrbit,
    examples: [
      {
        name: "wait for parse job",
        input: {
          job_id: "pjb-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          expand: ["markdown"],
          timeout_seconds: 300,
        },
      },
    ],
  },
  {
    command: "llama parse run",
    description:
      "Parse a local file, URL, or file_id and wait. Input: one of {file_path, file_id, source_url}, plus tier?, expand?. Returns the result {job, markdown?|text?}; default expand markdown, text for fast tier.",
    output:
      "{ job: { id, status: \"COMPLETED\" }, markdown?, text?, items?, metadata? } (same shape as llama parse result)",
    inputSchema: parseRunInputSchema,
    orbit: parseOrbit,
    examples: [
      {
        name: "parse local pdf to markdown",
        input: {
          file_path: "./document.pdf",
          tier: "agentic",
          version: "latest",
          expand: ["markdown"],
        },
      },
    ],
  },
  {
    command: "llama parse versions",
    description:
      "List available LlamaParse tier versions (GET /api/v2/parse/versions). Input (optional): {organization_id?, project_id?}. Returns the raw provider payload.",
    output:
      "Raw provider JSON ({ ... } or [ ... ]) from GET /api/v2/parse/versions, passed through unvalidated; no fields are modeled in code",
    inputSchema: parseVersionsInputSchema,
    orbit: parseOrbit,
    examples: [{ name: "list tier versions", input: {} }],
  },
  {
    command: "llama extract create",
    description:
      "Start a LlamaExtract v2 job. Input: {file_input (file_id or parse job id), configuration{data_schema}|configuration_id}. Returns the job {id, status}; --wait returns the completed job.",
    output:
      "{ id, status, file_input?, configuration?, configuration_id?, error_message?, extract_result?, extract_metadata? } (provider extract job; extract_result is set once COMPLETED)",
    inputSchema: extractCreateInputSchema,
    orbit: extractOrbit,
    examples: [
      {
        name: "extract from existing file_id",
        input: {
          file_input: "dfl-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          configuration: {
            tier: "agentic",
            data_schema: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
        },
      },
    ],
  },
  {
    command: "llama extract get",
    description:
      "Get an extract job once. Input: {job_id, expand?}. Returns the provider job {id, status, extract_result?, extract_metadata?, error_message?}.",
    output:
      "{ id, status, file_input?, configuration?, error_message?, extract_result?, extract_metadata?, metadata?, usage? } (provider extract job)",
    inputSchema: extractGetInputSchema,
    orbit: extractOrbit,
    examples: [
      { name: "extract job and results", input: { job_id: "ext-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
    ],
  },
  {
    command: "llama extract list",
    description:
      "List LlamaExtract jobs. Input (optional): {page_size?, page_token?, status?}. Returns {items: [jobs {id, status}], next_page_token}.",
    output:
      "{ items: [{ id, status, file_input?, created_at?, error_message? }], next_page_token?, total_size? }",
    inputSchema: extractListInputSchema,
    orbit: extractOrbit,
    examples: [
      { name: "recent extract jobs", input: { page_size: 10 } },
    ],
  },
  {
    command: "llama extract wait",
    description:
      "Poll an extract job until COMPLETED; fails on FAILED, CANCELLED, or timeout. Input: {job_id, expand?, timeout_seconds?}. Returns the completed job {id, status, extract_result}.",
    output:
      "{ id, status: \"COMPLETED\", extract_result?, extract_metadata?, usage? } (provider extract job)",
    inputSchema: extractWaitInputSchema,
    orbit: extractOrbit,
    examples: [
      { name: "wait for extract job", input: { job_id: "ext-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", timeout_seconds: 300 } },
    ],
  },
  {
    command: "llama extract run",
    description:
      "Upload a local file if needed, start extract, and wait. Input: {file_path|file_input, configuration{data_schema}|configuration_id}. Returns the completed job {id, status, extract_result}.",
    output:
      "{ id, status: \"COMPLETED\", file_input?, extract_result?, extract_metadata?, usage? } (provider extract job; extract_result holds the structured JSON)",
    inputSchema: extractRunInputSchema,
    orbit: extractOrbit,
    examples: [
      {
        name: "extract structured fields from a resume",
        input: {
          file_path: "./resume.pdf",
          configuration: {
            tier: "agentic",
            data_schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
                skills: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    ],
  },
])
