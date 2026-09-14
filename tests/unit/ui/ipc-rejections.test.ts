import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SRC = new URL("../../../src", import.meta.url).pathname;

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** True when `target` sits inside `root` (ancestor walk). */
function containsNode(root: ts.Node, target: ts.Node): boolean {
  let node: ts.Node | undefined = target;
  while (node) {
    if (node === root) return true;
    node = node.parent;
  }
  return false;
}

interface Verdict {
  handled: boolean;
  via: string;
}

/**
 * Decide whether one `window.termina.*` invoke is rejection-handled:
 * subscriptions and sync-void sends are not promises; everything else needs
 * `.catch`, a two-arg `.then`, or an `await` directly inside `try`.
 */
function checkInvoke(call: ts.CallExpression): Verdict {
  const method = (call.expression as ts.PropertyAccessExpression).name.text;
  if (/^on[A-Z]/.test(method)) return { handled: true, via: "subscription" };
  if (method === "readyTerminal" || method === "acknowledgePtyData") return { handled: true, via: "sync-void" };

  let node: ts.Node = call;
  let parent: ts.Node | undefined = node.parent;
  let crossedFunction = false;
  let seenAwait = false;
  while (parent) {
    if (!crossedFunction && ts.isBlock(parent) && parent.parent && ts.isTryStatement(parent.parent) && parent.parent.tryBlock === parent) {
      if (seenAwait) return { handled: true, via: "await-in-try" };
    }
    if (ts.isFunctionLike(parent)) crossedFunction = true;
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
      const name = parent.expression.name.text;
      const receiver = parent.expression.expression;
      if (name === "catch" && containsNode(receiver, call)) return { handled: true, via: ".catch" };
      if (name === "then" && parent.arguments.length === 2 && containsNode(receiver, call)) {
        return { handled: true, via: "two-arg-then" };
      }
    }
    if (ts.isAwaitExpression(parent)) seenAwait = true;
    node = parent;
    parent = parent.parent;
  }
  return { handled: false, via: "unhandled" };
}

interface AllowedPassThrough {
  file: string;
  method: string;
  reason: string;
}

/**
 * Promise-passing sites: the invoke is neither awaited nor caught locally
 * because the promise is handed to a caller that settles it. Each needs a
 * companion assertion below proving the downstream handling still exists.
 */
const PASS_THROUGH: AllowedPassThrough[] = [
  { file: "src/main/terminal-menu.ts", method: "getShells", reason: "awaited in try" },
  { file: "src/main/timeline-pane.ts", method: "getTimelineProgress", reason: "scheduleProgress rejection handler" },
  { file: "src/main.ts", method: "pasteTerminal", reason: "pty-view try/catch" },
  { file: "src/main.ts", method: "dropTerminalFiles", reason: "pty-view try/catch" },
  { file: "src/main.ts", method: "detectTest", reason: "worldline-project-state catch" },
  { file: "src/editor.ts", method: "openFile", reason: "throws to catching callers" },
];

describe("renderer IPC rejection handling (refs #217 item 1)", () => {
  it("leaves no bare invoke without .catch, two-arg .then, or await-in-try", () => {
    const failures: string[] = [];
    const allowed = new Set<string>();
    for (const file of srcFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && ts.isPropertyAccessExpression(node.expression.expression)
          && ts.isIdentifier(node.expression.expression.expression)
          && node.expression.expression.expression.text === "window"
          && node.expression.expression.name.text === "termina"
        ) {
          const method = node.expression.name.text;
          const verdict = checkInvoke(node);
          if (!verdict.handled) {
            const rel = file.slice(file.indexOf("src/"));
            const pass = PASS_THROUGH.find((p) => p.file === rel && p.method === method);
            if (pass) {
              allowed.add(`${rel}:${method}`);
            } else {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              failures.push(`${rel}:${line + 1} ${method}() — ${verdict.via}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    // Every allowlist entry must still exist (no stale entries hiding drift).
    for (const entry of PASS_THROUGH) {
      expect(allowed.has(`${entry.file}:${entry.method}`), `stale allowlist entry: ${entry.file} ${entry.method}`).toBe(true);
    }
    expect(failures).toEqual([]);
  });

  it("keeps the downstream handling each pass-through relies on", () => {
    const terminalMenu = readFileSync(new URL("../../../src/main/terminal-menu.ts", import.meta.url), "utf8");
    expect(terminalMenu).toContain("shellsCache = await shellsPromise;");
    expect(terminalMenu).toMatch(/try \{\s*shellsCache = await shellsPromise;/);

    const timeline = readFileSync(new URL("../../../src/timeline.ts", import.meta.url), "utf8");
    expect(timeline).toContain("void this.onProgress(seq).then(");

    const ptyView = readFileSync(new URL("../../../src/pty-view.ts", import.meta.url), "utf8");
    expect(ptyView).toContain("const result = await this.pasteFromHost();");
    expect(ptyView).toContain("const result = await this.dropFromHost(files);");

    const projectState = readFileSync(new URL("../../../src/worldline-project-state.ts", import.meta.url), "utf8");
    expect(projectState).toContain("void bindings.detectTest(pane.instanceId).then((detected) => {");

    // Editor openFile throws (IPC rejection and failed reads alike): every
    // direct caller catches, and openFileSmartInner wraps it in try.
    const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");
    expect(editor).toContain("throw new Error(res.error)");
    const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
    expect(renderer).toContain("void ensureProjectEditor(view).openFile(p.path, { preview: true, owner }).catch((err) => {");
    expect(renderer).toContain("void ensureProjectEditor(view).openFile(target.path, { preview: true, owner }).catch((err) => {");
    expect(renderer).toContain("await ensureProjectEditor(view).openFile(abs, { preview, owner, line, column });");
  });

  it("pins the highest-risk fixes: protocols, keystrokes, and jump fetch", () => {
    const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
    // Main awaits these reports: a throw reports failure instead of withholding it.
    expect(renderer).toContain('void window.termina.reportFlush(requestId, { ok: false, failed: ["could not save editor changes"] })');
    expect(renderer).toContain('void window.termina.reportUnsavedConfirm(requestId, { ok: false, error: "could not confirm unsaved changes" })');
    // Per-keystroke fire-and-forget stays silent but caught.
    expect(renderer).toContain("void window.termina.writeTerminal(instanceId, data).catch(() => undefined)");
    expect(renderer).toContain("void window.termina.resizeTerminal(instanceId, cols, rows).catch(() => undefined)");

    const timelinePane = readFileSync(new URL("../../../src/main/timeline-pane.ts", import.meta.url), "utf8");
    expect(timelinePane).toContain("res = await window.termina.getTimelineContent(pane.instanceId, ev.seq);");
    expect(timelinePane).toContain('toast(`could not load this moment: ${(err as Error).message}`, "warning")');
  });
});
