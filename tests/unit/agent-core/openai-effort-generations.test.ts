import { describe, it, expect } from "vitest";
import { providerProtocol } from "../../../agent-core/auth.ts";
import {
  clampEffortLevel,
  reasoningEffortFor,
  supportedEffortLevels,
  type EffortLevel,
} from "../../../agent-core/models/capabilities.ts";

// Refs #200: per-generation OpenAI effort rows, each verified against its own
// live model page (fetched 2026-09-14). Every offered wire value must be
// within the page's documented list for that generation.
const GENERATIONS: Array<{
  model: string;
  levels: EffortLevel[];
  wire: Record<string, string>;
  page: string;
}> = [
  {
    model: "gpt-5",
    levels: ["minimal", "low", "medium", "high"],
    wire: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
    page: "https://developers.openai.com/api/docs/models/gpt-5",
  },
  {
    model: "gpt-5-mini",
    levels: ["minimal", "low", "medium", "high"],
    wire: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
    page: "https://developers.openai.com/api/docs/models/gpt-5",
  },
  {
    model: "gpt-5-2025-08-07",
    levels: ["minimal", "low", "medium", "high"],
    wire: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
    page: "https://developers.openai.com/api/docs/models/gpt-5",
  },
  {
    model: "gpt-5.1",
    levels: ["off", "low", "medium", "high"],
    wire: { off: "none", low: "low", medium: "medium", high: "high" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.1",
  },
  {
    model: "gpt-5.1-2025-11-13",
    levels: ["off", "low", "medium", "high"],
    wire: { off: "none", low: "low", medium: "medium", high: "high" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.1",
  },
  {
    model: "gpt-5.2",
    levels: ["off", "low", "medium", "high", "xhigh"],
    wire: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.2",
  },
  {
    model: "gpt-5.2-2025-12-11",
    levels: ["off", "low", "medium", "high", "xhigh"],
    wire: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.2",
  },
  {
    model: "gpt-5.4",
    levels: ["off", "low", "medium", "high", "xhigh"],
    wire: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.4",
  },
  {
    model: "gpt-5.5",
    levels: ["off", "low", "medium", "high", "xhigh"],
    wire: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.5",
  },
  {
    model: "gpt-5.6-sol",
    levels: ["off", "low", "medium", "high", "xhigh", "max"],
    wire: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  {
    model: "gpt-5.2-codex",
    levels: ["low", "medium", "high", "xhigh"],
    wire: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.2-codex",
  },
  {
    model: "gpt-5.3-codex",
    levels: ["low", "medium", "high", "xhigh"],
    wire: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    page: "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
  },
  {
    model: "gpt-6-astra",
    levels: ["low", "medium", "high", "xhigh", "max"],
    wire: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    page: "https://developers.openai.com/api/docs/models/gpt-6-astra",
  },
];

describe("openai per-generation effort rows (refs #200)", () => {
  for (const row of GENERATIONS) {
    it(`${row.model} offers exactly the documented levels (${row.page})`, () => {
      const proto = providerProtocol("openai", row.model);
      expect(supportedEffortLevels("openai", row.model, proto)).toEqual(row.levels);
      for (const [level, wire] of Object.entries(row.wire)) {
        expect(reasoningEffortFor("openai", row.model, level as EffortLevel, proto)).toBe(wire);
      }
    });

    it(`${row.model} compaction summary sends a documented wire value`, () => {
      // Mirrors summaryRequestPolicy: clamp + wire "off" through capabilities.
      const proto = providerProtocol("openai", row.model);
      const effort = clampEffortLevel("openai", row.model, "off", proto);
      const reasoning = reasoningEffortFor("openai", row.model, "off", proto);
      expect(row.levels).toContain(effort);
      expect(Object.values(row.wire)).toContain(reasoning);
    });
  }

  it("gpt-5.0 never sends undocumented none; hidden levels clamp upward", () => {
    const proto = providerProtocol("openai", "gpt-5");
    expect(reasoningEffortFor("openai", "gpt-5", "off", proto)).toBe("minimal");
    const proto51 = providerProtocol("openai", "gpt-5.1");
    expect(reasoningEffortFor("openai", "gpt-5.1", "minimal", proto51)).toBe("low");
    const proto52 = providerProtocol("openai", "gpt-5.2");
    expect(reasoningEffortFor("openai", "gpt-5.2", "minimal", proto52)).toBe("low");
    expect(reasoningEffortFor("openai", "gpt-5.2", "max", proto52)).toBe("xhigh");
  });
});
