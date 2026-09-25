/** Regex execution stays off main, including compilation and pathological matches. */
import { parentPort, workerData } from "node:worker_threads";
let regex;
try { regex = new RegExp(workerData.pattern); } catch { regex = null; }
parentPort.on("message", ({ content, limit, previewLength }) => {
  const matches = [];
  if (regex) {
    const lines = content.split("\n");
    for (let line = 0; line < lines.length; line++) {
      const found = regex.exec(lines[line]);
      if (!found) continue;
      matches.push({ line: line + 1, column: found.index + 1, text: lines[line].slice(0, previewLength + 1) });
      if (matches.length >= limit) break;
    }
  }
  parentPort.postMessage(regex ? matches : null);
});
