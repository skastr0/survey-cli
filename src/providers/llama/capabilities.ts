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
      "Upload a local file for parse, extract, classify, split, or other purposes.",
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
    description: "List uploaded files with optional filters.",
    inputSchema: filesListInputSchema,
    orbit: filesOrbit,
  },
  {
    command: "llama files inspect",
    description: "Get uploaded file metadata by file_id.",
    inputSchema: filesInspectInputSchema,
    orbit: filesOrbit,
  },
  {
    command: "llama files content",
    description: "Get a presigned download URL for an uploaded file.",
    inputSchema: filesContentInputSchema,
    orbit: filesOrbit,
  },
  {
    command: "llama files delete",
    description: "Delete an uploaded file.",
    inputSchema: filesDeleteInputSchema,
    orbit: filesOrbit,
  },
  {
    command: "llama parse create",
    description: "Start a parse job from file_id or source_url.",
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
      "Upload a local file and start a parse job in one multipart request.",
    inputSchema: parseUploadInputSchema,
    orbit: parseOrbit,
  },
  {
    command: "llama parse list",
    description: "List parse jobs.",
    inputSchema: parseListInputSchema,
    orbit: parseOrbit,
  },
  {
    command: "llama parse result",
    description: "Get parse job status and expanded results.",
    inputSchema: parseResultInputSchema,
    orbit: parseOrbit,
  },
  {
    command: "llama parse wait",
    description: "Poll a parse job until it is terminal.",
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
      "Parse a local file, URL, or file_id and wait. Default expand is markdown, or text for the fast tier.",
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
    description: "List available LlamaParse tier versions.",
    orbit: parseOrbit,
  },
  {
    command: "llama extract create",
    description: "Start an extract v2 job from a file_id or parse job id.",
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
    description: "Get extract job status and results.",
    inputSchema: extractGetInputSchema,
    orbit: extractOrbit,
  },
  {
    command: "llama extract list",
    description: "List extract jobs.",
    inputSchema: extractListInputSchema,
    orbit: extractOrbit,
  },
  {
    command: "llama extract wait",
    description: "Poll an extract job until it is terminal.",
    inputSchema: extractWaitInputSchema,
    orbit: extractOrbit,
  },
  {
    command: "llama extract run",
    description:
      "Upload a local file if needed, start extract, and wait for structured JSON.",
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
