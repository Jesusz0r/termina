import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AgentTui } from "../../../agent-core/tui.ts";
import { sourceTail } from "../../../agent-core/tui/layout.ts";
import { TRANSCRIPT_TRIM_TARGET, TRUNCATION_MARKER } from "../../../agent-core/tui/transcript.ts";
import { cellWidth, formatPickerRow, matchingSlashCommands, SLASH_COMMANDS, skillCommandRows } from "../../../agent-core/tui-text.ts";

function makeTui() {
  return new AgentTui({
    stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
    stdin: { isTTY: false },
    onSubmit: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  });
}

describe("TUI same-file helpers (#352)", () => {
  it("keeps pickerHead local and shared by the picker heads", () => {
    const src = readFileSync(new URL("../../../agent-core/tui-text.ts", import.meta.url), "utf8");
    expect(src).toMatch(/function pickerHead\(/);
    expect(src).not.toMatch(/export function pickerHead/);
    expect(src).toContain('pickerHead(line, space, commands, ["/login", "/logout"])');
    expect(src).toContain('pickerHead(line, space, commands, ["/models", "/model"])');
    expect(src).toContain('pickerHead(line, space, commands, ["/effort"])');
    expect(src).toContain('pickerHead(line, space, commands, ["/skills"])');
    expect(src).toContain('pickerHead(line, space, commands, ["/permissions"])');
  });

  it("prefix-matches slash names until a picker head is exact", () => {
    expect(matchingSlashCommands("/log").map((row) => row.name)).toEqual(["/login", "/logout"]);
    expect(matchingSlashCommands("/mode").map((row) => row.name)).toEqual(["/model", "/models"]);
    expect(matchingSlashCommands("/effor").map((row) => row.name)).toEqual(["/effort"]);
    expect(matchingSlashCommands("/permiss").map((row) => row.name)).toEqual(["/permissions"]);
    expect(matchingSlashCommands("/p").map((row) => row.name)).toEqual(["/plan", "/permissions"]);
    expect(matchingSlashCommands("/pla").map((row) => row.name)).toEqual(["/plan"]);
    expect(matchingSlashCommands("/login").every((row) => !row.name.startsWith("/"))).toBe(true);
    expect(matchingSlashCommands("/effort").map((row) => row.name)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(matchingSlashCommands("/permissions").map((row) => row.submit)).toEqual([
      "/permissions ask",
      "/permissions dangerous",
      "/permissions always",
    ]);
    expect(matchingSlashCommands("/models", SLASH_COMMANDS).map((row) => row.name)).toEqual(["/models"]);
  });

  it("lists skills under /skills and submits the selected name", () => {
    const rows = skillCommandRows([
      { name: "review", description: "review the diff" },
      { name: "qa", description: "run implementation QA" },
    ]);
    expect(matchingSlashCommands("/sk").map((row) => row.name)).toEqual(["/skills"]);
    expect(matchingSlashCommands("/skills").map((row) => row.name)).toEqual(["/skills"]);
    expect(matchingSlashCommands("/skills", SLASH_COMMANDS, [], [], rows).map((row) => row.name)).toEqual([
      "review",
      "qa",
    ]);
    expect(matchingSlashCommands("/skills q", SLASH_COMMANDS, [], [], rows).map((row) => row.submit)).toEqual([
      "/skills qa",
    ]);
    const submitted: string[] = [];
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => submitted.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    tui.setSkillRows(rows);
    tui.feed("/sk\r");
    expect(submitted).toEqual([]);
    expect(tui.frame()).toContain("review");
    expect(tui.frame()).toContain("qa");
    tui.feed("\x1b[B\r");
    expect(submitted).toEqual(["/skills qa"]);
  });

  it("skips unusable skill names and keeps picker rows inside the terminal width", () => {
    expect(
      skillCommandRows([
        { name: "ok", description: "ready" },
        { name: "bad\nname", description: "nope" },
        { name: "\x07bell", description: "nope" },
        { name: "  ", description: "nope" },
      ]).map((row) => row.name),
    ).toEqual(["ok"]);
    const longHint = "Use this skill when asked to verify, QA, validate, inspect, or review a very long trigger.";
    const row = formatPickerRow("implementation-qa", longHint, 40, true);
    expect(cellWidth(row)).toBeLessThanOrEqual(40);
    expect(row.startsWith("▸ ")).toBe(true);
  });

  it("caps a live stream with sourceTail", () => {
    const app = readFileSync(new URL("../../../agent-core/tui/app.ts", import.meta.url), "utf8");
    expect(app).toMatch(/const tail = sourceTail\(entry\.text, budget\);/);
    expect(app).toMatch(/const next = TRUNCATION_MARKER \+ tail\.text;/);
    expect(app).not.toMatch(/graphemeSafeTail\(entry\.text/);

    const drop = "DROP-PARTIAL-HEAD";
    const keep = "KEEP-SOURCE-TAIL";
    const original = `${drop}\n${"x".repeat(410_000)}\n${keep}`;
    const tui = makeTui();
    tui.appendAssistant(original);
    const text = String((tui as unknown as { entries: Array<{ text: string }> }).entries[0]?.text ?? "");
    const budget = Math.max(0, TRANSCRIPT_TRIM_TARGET - TRUNCATION_MARKER.length);
    expect(text).toBe(TRUNCATION_MARKER + sourceTail(original, budget).text);
    expect(text).toContain(keep);
    expect(text).not.toContain(drop);
  });

  it("packs the title in titleLine and leaves SGR/composer in buildFrame", () => {
    const app = readFileSync(new URL("../../../agent-core/tui/app.ts", import.meta.url), "utf8");
    expect(app).toMatch(/private titleLine\(cols: number\): string/);
    expect(app).toMatch(/const title = this\.titleLine\(cols\);/);
    expect(app).toMatch(/lines\.push\(boxBorderRow\(cols, "┌", "─", "┐"\)\);/);
    expect(app).toContain("\\x1b[30;104m");
    expect(app).toContain("\\x1b[1;38;5;229;48;5;58m");

    const tui = makeTui();
    tui.setStatus({ model: "anthropic/claude", effort: "max", permissions: "ask" });
    tui.setPendingImageCount(2);
    tui.setQueued("fix the test");
    const host = tui as unknown as {
      titleLine(cols: number): string;
      buildFrame(size: { cols: number; rows: number }): { text: string };
    };
    const title = host.titleLine(80);
    const frame = host.buildFrame({ cols: 80, rows: 24 }).text;
    expect(frame.split("\n").at(-1)).toBe(title);
    expect(title).toContain("▸ termina");
    expect(title).toContain(" · max");
    expect(title).toContain("perm ask");
    expect(title).toContain("2 img");
    expect(title).toContain("queued");
    const wide = host.titleLine(120);
    expect(wide).toContain("anthropic/claude · max");
    expect(title).toBe(title.trimEnd());
    expect(wide).toBe(wide.trimEnd());
  });
});
