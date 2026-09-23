/** Read-only prefix measurements. No provider calls, token estimates or prompt
 * text in the report. Real front matter + explicitly synthetic MCP/history
 * fixtures; these byte counts are not cache-hit or billing measurements.
 *
 * node --experimental-strip-types --no-warnings scripts/prefix-measure.ts [project-root]
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildFrozenSystem } from "../agent-core/main/front-matter.ts";
import { buildRequestOverlay, projectRequest } from "../agent-core/request-projection.ts";
import { mcpClientTools, mcpToolDefs, searchMcpTools, selectMcpTools } from "../agent-core/mcp.ts";
import { responsesBody } from "../agent-core/openai-compat/responses.ts";
import type { KernelMessage, ToolDef } from "../agent-core/openai-compat/types.ts";

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Compare complete serialized input items, not an accidental shared substring
 * of the changed first item. Provider-internal token framing remains unknown. */
export function matchingInputPrefix(before: unknown[], after: unknown[]) {
  let items = 0;
  let serializedItemBytes = 0;
  while (items < before.length && items < after.length) {
    const text = JSON.stringify(before[items]);
    if (text !== JSON.stringify(after[items])) break;
    serializedItemBytes += Buffer.byteLength(text, "utf8");
    items++;
  }
  return { items, serializedItemBytes };
}

export function measurePrefix(opts: Parameters<typeof buildFrozenSystem>[0]) {
  const frozen = buildFrozenSystem(opts);
  const catalog = selectMcpTools(Array.from({ length: 32 }, (_, i) => ({
    name: `operation_${i}`, original: `operation_${i}`, server: "measurement",
    description: `Operation ${i}: ${"synthetic tool documentation. ".repeat(30)}`,
    input_schema: { type: "object", properties: { value: { type: "string", description: "Input value" } }, required: ["value"] },
  })));
  const deferred = mcpClientTools([], catalog);
  const toolsOnlyBody = (tools: Array<Record<string, unknown>>) => responsesBody("measurement-only", "", [], tools as ToolDef[], {});
  const eagerBytes = bytes(toolsOnlyBody(mcpToolDefs(catalog)).tools);
  const deferredBytes = bytes(toolsOnlyBody(deferred).tools);
  const discoveryBytes = Buffer.byteLength(searchMcpTools(catalog, { query: catalog[0]!.name }), "utf8");
  const history: Array<{ role: "user" | "assistant"; content: string }> = Array.from({ length: 16 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `Message ${i}: ${"stable history. ".repeat(128)}`,
  }));
  const body = (messages: typeof history, context: string) => {
    const projected = projectRequest({ messages, overlay: buildRequestOverlay({ hostContext: context }) });
    if (!projected.ok) throw new Error(projected.error);
    return responsesBody("measurement-only", frozen.system, projected.messages as KernelMessage[], deferred as ToolDef[], {});
  };
  const before = body(history, "file.ts: revision A");
  const nextHistory: typeof history = [...history, { role: "user", content: "Next task" }];
  const compare = (after: Record<string, unknown>) => ({
    instructionsIdentical: before.instructions === after.instructions,
    toolsIdentical: JSON.stringify(before.tools) === JSON.stringify(after.tools),
    matchingInputPrefix: matchingInputPrefix(before.input as unknown[], after.input as unknown[]),
    previousInputItems: (before.input as unknown[]).length,
    previousSerializedInputBytes: bytes(before.input),
  });
  return {
    units: "UTF-8 bytes, not tokens",
    scope: "Local front matter; synthetic 32-tool catalog and 16-message Responses serialization. No provider request sent.",
    environmentProbes: opts.probes !== false,
    system: { totalBytes: Buffer.byteLength(frozen.system, "utf8"), sectionBytes: frozen.sectionBytes },
    mcpFixture: {
      selectedTools: catalog.length,
      eagerSerializedToolsBytes: eagerBytes,
      deferredSerializedToolsBytes: deferredBytes,
      initialReductionBytes: eagerBytes - deferredBytes,
      firstDiscoveryResultBytes: discoveryBytes,
      note: "MCP contribution only; built-ins excluded. Discovery adds a model turn and history content; no net cost claim.",
    },
    crossPromptFixture: {
      unchangedOverlay: compare(body(nextHistory, "file.ts: revision A")),
      changedOverlay: compare(body(nextHistory, "file.ts: revision B")),
      note: "Whole serialized input-item equality, without cache markers. Not a prediction of provider cache hits or partial-item matching.",
    },
    providerMeasuredCacheHitRate: null,
    providerMeasuredTokenSavings: null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(measurePrefix({
      cwd: resolve(process.argv[2] ?? process.cwd()),
      userAgentsPath: join(homedir(), ".agents", "AGENTS.md"),
      userSkillDir: join(homedir(), ".agents", "skills"),
      probes: false,
    }), null, 2));
  } catch (error) {
    console.error(`prefix-measure: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
