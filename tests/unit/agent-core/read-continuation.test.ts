import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emitNumberedPage,
  emitPlainPage,
  readProjectFile,
} from "../../../agent-core/main/file-ops.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "termina-read-continuation-"));
  roots.push(root);
  return root;
}

function stripRow(line: string): string {
  const bar = line.indexOf("|");
  if (bar < 0) throw new Error(`expected a numbered row, got: ${line.slice(0, 60)}`);
  return line.slice(bar + 1);
}

/**
 * Follow every advertised offset continuation and rebuild the source from
 * display rows only. A whole-line page ends at a boundary exactly when its
 * marker names a start_line; a partial page concatenates with the next page.
 */
function readAllNumbered(root: string, rel: string, source: string): { text: string; rows: string[]; pages: number } {
  let acc = "";
  const rows: string[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    pages++;
    if (pages > 50) throw new Error("continuation chain did not terminate");
    const got = readProjectFile(root, { path: rel, offset });
    if (got.isError) throw new Error(got.content);
    expect(Buffer.byteLength(got.content, "utf8")).toBeLessThanOrEqual(40 * 1024);
    const lines = got.content.split("\n");
    if (lines[0]?.startsWith("[package instructions:")) lines.shift();
    const markerIdx = lines.findIndex((l) => l.startsWith("[truncated"));
    const body = markerIdx >= 0 ? lines.slice(0, markerIdx) : lines;
    const marker = markerIdx >= 0 ? lines[markerIdx]! : null;
    const pageRows = body.map(stripRow);
    rows.push(...pageRows);
    for (let i = 0; i < pageRows.length - 1; i++) acc += `${pageRows[i]}\n`;
    if (pageRows.length > 0) acc += pageRows[pageRows.length - 1];
    if (!marker) {
      if (source.endsWith("\n")) acc += "\n";
      break;
    }
    const next = Number(marker.match(/read_file offset (\d+)/)?.[1]);
    if (!Number.isSafeInteger(next) || next <= offset) throw new Error(`continuation did not advance: ${marker}`);
    // Whole-line pages name a start_line; partial pages resume mid-line.
    if (marker.includes("start_line")) acc += "\n";
    offset = next;
  }
  return { text: acc, rows, pages };
}

describe("numbered read continuation (#156)", () => {
  it("reconstructs many short lines with no gaps or duplication", () => {
    const root = project();
    const rows: string[] = [];
    for (let i = 1; i <= 8000; i++) rows.push(`row-${String(i).padStart(4, "0")}`);
    const source = `${rows.join("\n")}\n`;
    writeFileSync(join(root, "many.txt"), source);
    const rebuilt = readAllNumbered(root, "many.txt", source);
    expect(rebuilt.pages).toBeGreaterThan(1);
    expect(rebuilt.rows).toEqual(rows);
    expect(rebuilt.text).toBe(source);
  });

  it("advertises an adjacent start_line, not a skipped one", () => {
    const root = project();
    const rows: string[] = [];
    for (let i = 1; i <= 8000; i++) rows.push(`row-${String(i).padStart(4, "0")}`);
    writeFileSync(join(root, "many.txt"), `${rows.join("\n")}\n`);
    const first = readProjectFile(root, { path: "many.txt" });
    const nextLine = Number(first.content.match(/start_line (\d+)/)?.[1]);
    const shown = first.content.split("\n").filter((l) => l.includes("|")).map(stripRow);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[shown.length - 1]).toBe(rows[shown.length - 1]);
    expect(nextLine).toBe(shown.length + 1);
    const cont = readProjectFile(root, { path: "many.txt", start_line: nextLine });
    expect(cont.content.split("\n")[0]).toContain(rows[nextLine - 1]!);
  });

  it("reconstructs a long single line across partial pages", () => {
    const root = project();
    const source = `H${"ello-world-".repeat(6000)}end`;
    writeFileSync(join(root, "huge.txt"), source);
    const rebuilt = readAllNumbered(root, "huge.txt", source);
    expect(rebuilt.pages).toBeGreaterThan(1);
    expect(rebuilt.text).toBe(source);
  });

  it("reconstructs multibyte content cut at the cap", () => {
    const root = project();
    const source = "😀é漢".repeat(20_000);
    writeFileSync(join(root, "unicode.txt"), source);
    const rebuilt = readAllNumbered(root, "unicode.txt", source);
    expect(rebuilt.pages).toBeGreaterThan(1);
    expect(rebuilt.text).toBe(source);
  });

  it("reconstructs CRLF content (modulo display CR stripping)", () => {
    const root = project();
    const rows: string[] = [];
    for (let i = 1; i <= 4000; i++) rows.push(`crlf-${String(i).padStart(4, "0")}`);
    const source = `${rows.join("\r\n")}\r\n`;
    writeFileSync(join(root, "crlf.txt"), source);
    const rebuilt = readAllNumbered(root, "crlf.txt", source);
    expect(rebuilt.pages).toBeGreaterThan(1);
    expect(rebuilt.rows).toEqual(rows);
    expect(rebuilt.text).toBe(source.replace(/\r/g, ""));
  });

  it("accounts for the nested-instructions pointer before finalizing the page", () => {
    const root = project();
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "pkg", "AGENTS.md"), "# package notes\n");
    const rows: string[] = [];
    for (let i = 1; i <= 8000; i++) rows.push(`pkg-${String(i).padStart(4, "0")}`);
    const source = `${rows.join("\n")}\n`;
    writeFileSync(join(root, "pkg", "big.txt"), source);
    const first = readProjectFile(root, { path: "pkg/big.txt" });
    expect(first.content.split("\n")[0]).toContain("[package instructions:");
    const rebuilt = readAllNumbered(root, "pkg/big.txt", source);
    expect(rebuilt.pages).toBeGreaterThan(1);
    expect(rebuilt.rows).toEqual(rows);
    expect(rebuilt.text).toBe(source);
  });

  it("reconstructs explicit line ranges", () => {
    const root = project();
    const rows: string[] = [];
    for (let i = 1; i <= 3000; i++) rows.push(`range-${String(i).padStart(4, "0")}`);
    const source = `${rows.join("\n")}\n`;
    writeFileSync(join(root, "range.txt"), source);
    // Range window covers the whole file; offset continuations stay inside it.
    let acc = "";
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    let endedAtBoundary = true;
    for (;;) {
      pages++;
      if (pages > 50) throw new Error("continuation chain did not terminate");
      const got = readProjectFile(root, pages === 1
        ? { path: "range.txt", start_line: 1, end_line: 3000 }
        : { path: "range.txt", offset });
      if (got.isError) throw new Error(got.content);
      const lines = got.content.split("\n");
      const markerIdx = lines.findIndex((l) => l.startsWith("[truncated"));
      const body = (markerIdx >= 0 ? lines.slice(0, markerIdx) : lines).map(stripRow);
      seen.push(...body);
      for (let i = 0; i < body.length - 1; i++) acc += `${body[i]}\n`;
      if (body.length > 0) acc += body[body.length - 1];
      const marker = markerIdx >= 0 ? lines[markerIdx]! : null;
      if (!marker) break;
      const next = Number(marker.match(/read_file offset (\d+)/)?.[1]);
      if (!Number.isSafeInteger(next) || next <= offset) throw new Error(`continuation did not advance: ${marker}`);
      endedAtBoundary = marker.includes("start_line");
      if (endedAtBoundary) acc += "\n";
      offset = next;
    }
    expect(pages).toBeGreaterThan(1);
    expect(endedAtBoundary).toBe(true);
    expect(seen).toEqual(rows);
    expect(`${acc}\n`).toBe(source);
  });

});

describe("page emission units (#156)", () => {
  it("emits nothing for empty text", () => {
    expect(emitNumberedPage("", 1, 100)).toEqual({ body: "", emittedBytes: 0, emittedLines: 0, partial: false });
    expect(emitPlainPage("", 100)).toEqual({ body: "", emittedBytes: 0 });
  });

  it("maps whole lines to source bytes including newlines", () => {
    const page = emitNumberedPage("ab\ncde\n", 1, 10_000);
    expect(page.body).toBe("     1|ab\n     2|cde");
    expect(page.emittedLines).toBe(2);
    expect(page.emittedBytes).toBe(7);
    expect(page.partial).toBe(false);
  });

  it("counts stripped carriage returns as source bytes", () => {
    const page = emitNumberedPage("ab\r\n", 1, 10_000);
    expect(page.body).toBe("     1|ab");
    expect(page.emittedBytes).toBe(4);
  });

  it("falls back to a code-point-safe partial first line", () => {
    const page = emitNumberedPage(`😀${"x".repeat(100)}`, 1, 10);
    expect(page.partial).toBe(true);
    expect(page.emittedLines).toBe(0);
    // 7-byte prefix + room for 3 bytes; the 4-byte emoji cannot fit.
    expect(page.body).toBe("     1|");
    expect(page.emittedBytes).toBe(0);
    const roomy = emitNumberedPage(`😀${"x".repeat(100)}`, 1, 12);
    expect(roomy.partial).toBe(true);
    expect(roomy.body).toBe("     1|😀x");
    expect(roomy.emittedBytes).toBe(5);
  });

  it("clips plain text on a code-point boundary", () => {
    const cut = emitPlainPage("ab😀cd", 4);
    expect(cut.body).toBe("ab");
    expect(cut.emittedBytes).toBe(2);
    expect(emitPlainPage("ab😀cd", 6).body).toBe("ab😀");
  });
});
