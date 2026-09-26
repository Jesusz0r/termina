/** Portable read contracts: separate operations make incompatible modes
 * unrepresentable without relying on provider-specific schema unions. */
import { READ_BATCH_CAP } from "./file-ops.ts";

export const READ_TOOL_DEFS: Array<Record<string, unknown>> = [
  {
    name: "read_file",
    description: "Read one text file or list one directory relative to the working directory. Results start with a path and line-range header, then file bytes; copy those bytes into edit old_text. Caps near 40 KB. start_line and end_line are inclusive. Use offset only to continue a truncated read, not with line ranges. To read multiple whole files, use read_files instead.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "File or directory path." },
        offset: { type: "integer", minimum: 0, description: "Continuation byte offset; do not combine with line ranges." },
        start_line: { type: "integer", minimum: 1, description: "1-based inclusive start line." },
        end_line: { type: "integer", minimum: 1, description: "1-based inclusive end line." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_files",
    description: "Read multiple whole text files or list directories in one bounded 40 KB result. Omitted tail paths are named; read them explicitly. For line ranges or continuation offsets use read_file instead.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: {
          type: "array", minItems: 1, maxItems: READ_BATCH_CAP, uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 1024 },
          description: `Up to ${READ_BATCH_CAP} distinct file or directory paths relative to the working directory.`,
        },
      },
      required: ["paths"],
    },
  },
];
