import { describe, it, expect } from "vitest";
import * as compat from "../../../agent-core/openai-compat.ts";

// Refs #198: response.incomplete / response.failed terminal envelopes must
// unpack nested usage like response.completed; incomplete must also unpack
// output items and surface stopReason "incomplete" (truncation).

function incompleteEvents() {
  return [
    {
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 120, output_tokens: 64, total_tokens: 184 },
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "sig-1",
            summary: [{ type: "summary_text", text: "partial thought" }],
          },
        ],
      },
    },
  ];
}

function failedEvents() {
  return [
    {
      type: "response.failed",
      error: { message: "boom" },
      response: {
        status: "failed",
        error: { code: "server_error", message: "boom" },
        usage: { input_tokens: 40, output_tokens: 7, total_tokens: 47 },
      },
    },
  ];
}

describe("responses incomplete/failed envelopes (refs #198)", () => {
  it("unpacks nested usage + output on response.incomplete with truncation stopReason", () => {
    const result = compat.responsesResultFromEvents(incompleteEvents(), () => {}, 0);
    expect(result.stopReason).toBe("incomplete");
    expect(compat.isTruncatedStopReason(result.stopReason)).toBe(true);
    expect(result.usage).toMatchObject({ input: 120, output: 64 });
    expect(result.error).toBeUndefined();
    expect(result.blocks).toContainEqual({
      type: "thinking",
      thinking: "partial thought",
      signature: "sig-1",
      id: "rs_1",
    });
  });

  it("unpacks nested usage on response.failed alongside the error", () => {
    const result = compat.responsesResultFromEvents(failedEvents(), () => {}, 0);
    expect(result.error).toBe("boom");
    expect(result.usage).toMatchObject({ input: 40, output: 7 });
  });

  it("keeps response.completed behavior unchanged", () => {
    const result = compat.responsesResultFromEvents(
      [
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            output: [],
          },
        },
      ],
      () => {},
      0,
    );
    expect(result.stopReason).toBe("stop");
    expect(compat.isTruncatedStopReason(result.stopReason)).toBe(false);
    expect(result.usage).toMatchObject({ input: 10, output: 5 });
  });

  it("extends the truncation predicate with incomplete only", () => {
    expect(compat.isTruncatedStopReason("incomplete")).toBe(true);
    expect(compat.isTruncatedStopReason("length")).toBe(true);
    expect(compat.isTruncatedStopReason("failed")).toBe(false);
    expect(compat.isTruncatedStopReason("stop")).toBe(false);
    expect(compat.isTruncatedStopReason(null)).toBe(false);
  });
});
