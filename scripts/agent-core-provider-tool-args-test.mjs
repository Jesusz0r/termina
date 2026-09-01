/** Provider tool calls must carry an identity and object-shaped arguments. */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";

const compat = await import("../agent-core/openai-compat.ts");
const core = await import("../agent-core/main.ts");

function completion(id, name, args) {
  return compat.completionResultFromEvents([
    {
      choices: [{
        delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] },
        finish_reason: "tool_calls",
      }],
    },
  ], () => {}, 0);
}

function responses(id, name, args) {
  return compat.responsesResultFromEvents([
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: id ? "item-1" : "", call_id: id, name, arguments: args },
    },
  ], () => {}, 0);
}

function google(name, args) {
  return compat.googleResultFromEvents([
    { candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] },
  ], () => {}, 0);
}

function malformedCompletionCall(raw) {
  return compat.completionResultFromEvents([
    { choices: [{ delta: { tool_calls: [raw] }, finish_reason: "tool_calls" }] },
  ], () => {}, 0);
}

function malformedGoogleCall(raw) {
  return compat.googleResultFromEvents([
    { candidates: [{ content: { parts: [{ functionCall: raw }] }, finishReason: "STOP" }] },
  ], () => {}, 0);
}

function atomicCompletion(secondArgs) {
  return compat.completionResultFromEvents([
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: "call-valid", function: { name: "read_file", arguments: "{}" } },
      { index: 1, id: "call-invalid", function: { name: "bash", arguments: secondArgs } },
    ] }, finish_reason: "tool_calls" }] },
  ], () => {}, 0);
}

function atomicResponses(secondArgs) {
  return compat.responsesResultFromEvents([
    { type: "response.output_item.done", item: { type: "function_call", id: "item-valid", call_id: "call-valid", name: "read_file", arguments: "{}" } },
    { type: "response.output_item.done", item: { type: "function_call", id: "item-invalid", call_id: "call-invalid", name: "bash", arguments: secondArgs } },
  ], () => {}, 0);
}

function sseStream(lines) {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        const payload = line === "[DONE]" ? line : JSON.stringify(line);
        controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
}

function atomicGoogle(secondArgs) {
  return compat.googleResultFromEvents([
    { candidates: [{ content: { parts: [
      { functionCall: { name: "read_file", args: {} } },
      { functionCall: { name: "bash", args: secondArgs } },
    ] }, finishReason: "STOP" }] },
  ], () => {}, 0);
}

function assertRejected(label, result, reason) {
  assert.match(result.error ?? "", reason, `${label}: must return a provider protocol error`);
  assert.equal(
    result.blocks.some((block) => block.type === "tool_use"),
    false,
    `${label}: must not emit an executable tool block`,
  );
}

for (const [label, make] of [
  ["Chat Completions", completion],
  ["Responses", responses],
]) {
  assertRejected(`${label} malformed JSON`, make("call-1", "bash", "{"), /tool call arguments.*JSON object/i);
  for (const raw of ["null", "[]", '"text"', "1", "true"]) {
    assertRejected(`${label} non-object ${raw}`, make("call-1", "bash", raw), /tool call arguments.*JSON object/i);
  }
  assertRejected(`${label} empty id`, make("", "bash", "{}"), /tool call identity/i);
  assertRejected(`${label} empty name`, make("call-1", "", "{}"), /tool call identity/i);
  assertRejected(`${label} whitespace id`, make("   ", "bash", "{}"), /tool call identity/i);
  assertRejected(`${label} whitespace name`, make("call-1", " \t ", "{}"), /tool call identity/i);
  assertRejected(`${label} missing arguments`, make("call-1", "bash", undefined), /tool call arguments.*JSON object/i);
  const valid = make("call-1", "bash", "{}");
  assert.equal(valid.error, undefined, `${label}: valid empty object must remain valid`);
  assert.deepEqual(valid.blocks.find((block) => block.type === "tool_use")?.input, {});
}

for (const value of [null, [], "text", 1, true]) {
  assertRejected(`Google non-object ${JSON.stringify(value)}`, google("bash", value), /tool call arguments.*JSON object/i);
}
assertRejected("Google empty name", google("", {}), /tool call identity/i);
assertRejected("Google whitespace name", google(" \t ", {}), /tool call identity/i);
assertRejected("Google missing arguments", google("bash", undefined), /tool call arguments.*JSON object/i);
const validGoogle = google("bash", {});
assert.equal(validGoogle.error, undefined, "Google valid empty object must remain valid");
assert.deepEqual(validGoogle.blocks.find((block) => block.type === "tool_use")?.input, {});
assertRejected("Chat Completions malformed tool entry", malformedCompletionCall(null), /malformed tool call/i);
assertRejected("Google malformed tool entry", malformedGoogleCall(null), /malformed tool call/i);
assertRejected("Responses malformed tool entry", responses(undefined, undefined, undefined), /tool call identity/i);
assertRejected("Chat Completions multi-call rejection is atomic", atomicCompletion("null"), /tool call arguments.*JSON object/i);
assertRejected("Responses multi-call rejection is atomic", atomicResponses("null"), /tool call arguments.*JSON object/i);
assertRejected("Google multi-call rejection is atomic", atomicGoogle(null), /tool call arguments.*JSON object/i);
const responsesCombinedError = compat.responsesResultFromEvents([
  { type: "response.failed", error: { message: "upstream failed" } },
  { type: "response.output_item.done", item: { type: "function_call", id: "item-invalid", call_id: "call-invalid", name: "bash", arguments: "null" } },
], () => {}, 0);
assert.match(responsesCombinedError.error ?? "", /^provider protocol error: tool call arguments/i);
assert.match(responsesCombinedError.error ?? "", /upstream failed/i);

for (const [label, events] of [
  ["Chat missing index", [
    { choices: [{ delta: { tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ]],
  ["Chat non-integer index", [
    { choices: [{ delta: { tool_calls: [{ index: "0", id: "call-1", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ]],
  ["Chat conflicting call identity", [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-2", function: { name: "read_file", arguments: "" } }] }, finish_reason: "tool_calls" }] },
  ]],
  ["Chat duplicate index in one delta", [
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: "call-1", function: { name: "read_file", arguments: "{\"path\":" } },
      { index: 0, id: "call-1", function: { name: "read_file", arguments: "\"package.json\"}" } },
    ] }, finish_reason: "tool_calls" }] },
  ]],
  ["Chat call id moved to another index", [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call-1", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ]],
]) {
  assertRejected(label, compat.completionResultFromEvents(events, () => {}, 0), /tool call|index|conflict/i);
}

const chatOfficialNullContinuation = compat.completionResultFromEvents([
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call-null-continuation",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":" },
        }],
      },
    }],
  },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: null,
          type: null,
          function: { name: null, arguments: "\"package.json\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  },
], () => {}, 0);
assert.equal(chatOfficialNullContinuation.error, undefined, "official null continuation metadata must be treated as omitted");
assert.deepEqual(
  chatOfficialNullContinuation.blocks.find((block) => block.type === "tool_use")?.input,
  { path: "package.json" },
);

for (const [label, toolCall] of [
  ["id", { index: 0, id: null, type: "function", function: { name: "read_file", arguments: "{}" } }],
  ["type", { index: 0, id: "call-null-first", type: null, function: { name: "read_file", arguments: "{}" } }],
  ["name", { index: 0, id: "call-null-first", type: "function", function: { name: null, arguments: "{}" } }],
]) {
  assertRejected(
    `Chat null ${label} on first fragment`,
    compat.completionResultFromEvents([{ choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: "tool_calls" }] }], () => {}, 0),
    /tool call|identity/i,
  );
}

const chatNullContinuationConflict = compat.completionResultFromEvents([
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call-stable",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":" },
        }],
      },
    }],
  },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: null,
          type: null,
          function: { name: null, arguments: "\"package.json\"}" },
        }],
      },
    }],
  },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call-attacker",
          type: "function",
          function: { name: "write_file", arguments: "{}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  },
], () => {}, 0);
assertRejected("Chat non-null identity after null continuation conflicts", chatNullContinuationConflict, /tool call|identity|conflict/i);

const responsesConflictingCallId = compat.responsesResultFromEvents([
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"package" },
  },
  {
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: "item-1",
    call_id: "call-2",
    delta: ".json\"}",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"package.json\"}" },
  },
], () => {}, 0);
assertRejected("Responses conflicting call id", responsesConflictingCallId, /tool call|identity|conflict/i);

const responsesOutputIndexChanged = compat.responsesResultFromEvents([
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "{}" },
  },
  {
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: "item-1",
    call_id: "call-1",
    delta: "{}",
  },
], () => {}, 0);
assertRejected("Responses output index changed", responsesOutputIndexChanged, /tool call|index|conflict/i);

const responsesMalformedArgumentDelta = compat.responsesResultFromEvents([
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "" },
  },
  {
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: "item-1",
    call_id: "call-1",
    delta: { text: "{}" },
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "{}" },
  },
], () => {}, 0);
assertRejected("Responses malformed argument delta", responsesMalformedArgumentDelta, /tool call arguments|malformed/i);

const chatNullArgumentSnapshot = compat.completionResultFromEvents([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{}" } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: null } }] }, finish_reason: "tool_calls" }] },
], () => {}, 0);
assertRejected("Chat null argument snapshot", chatNullArgumentSnapshot, /tool call arguments|malformed/i);

const responsesNullArgumentSnapshot = compat.responsesResultFromEvents([
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "{}" },
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: null },
  },
], () => {}, 0);
assertRejected("Responses null argument snapshot", responsesNullArgumentSnapshot, /tool call arguments|malformed/i);

for (const [label, terminal, late] of [
  ["Responses", { type: "response.completed", response: { status: "completed", output: [] } }, { type: "response.output_item.added", item: { type: "function_call", id: "item-2", call_id: "call-2", name: "write_file", arguments: "{}" } }],
  ["Chat", { choices: [{ finish_reason: "stop" }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: "late", function: { name: "write_file", arguments: "{}" } }] } }] }],
  ["Google", { candidates: [{ finishReason: "STOP" }] }, { candidates: [{ content: { parts: [{ functionCall: { name: "write_file", args: {} } }] } }] }],
]) {
  await assert.rejects(
    compat.readSseJson(sseStream([terminal, late])),
    /terminal|after|complete/i,
    `${label}: events after terminal completion must be rejected`,
  );
}

const usageAfterChatFinish = await compat.readSseJson(sseStream([
  { choices: [{ finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  "[DONE]",
]));
assert.equal(usageAfterChatFinish.length, 2, "Chat usage-only trailer after finish_reason remains valid");
await assert.rejects(
  compat.readSseJson(sseStream([
    { choices: [{ finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "late", function: { name: "write_file", arguments: "{}" } }] } }] },
  ])),
  /terminal|after|complete/i,
  "Chat tool fragments after the usage trailer must be rejected",
);

assert.equal(typeof core.providerToolAdmissionError, "function", "main must expose the provider admission invariant");
assert.match(
  core.providerToolAdmissionError([{ type: "tool_use", id: "call-1", name: "bash", input: [] }]) ?? "",
  /tool call arguments.*object/i,
);
assert.match(
  core.providerToolAdmissionError([{ type: "tool_use", id: "", name: "bash", input: {} }]) ?? "",
  /tool call identity/i,
);
assert.equal(
  core.providerToolAdmissionError([{ type: "tool_use", id: "call-1", name: "bash", input: {} }]),
  null,
);

console.log("agent-core provider tool argument contract passed");
