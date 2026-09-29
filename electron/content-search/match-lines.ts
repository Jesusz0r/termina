/** Regex execution stays off main, including compilation and pathological matches. */
import { parentPort, workerData } from "node:worker_threads";

interface MatchRequest {
  content: string;
  limit: number;
  previewLength: number;
}

const port = parentPort;
if (!port) throw new Error("content search matcher must run as a worker");

const pattern = (workerData as { pattern: string }).pattern;
let regex: RegExp | null;
try { regex = new RegExp(pattern); } catch { regex = null; }

port.on("message", ({ content, limit, previewLength }: MatchRequest) => {
  const matches = [];
  if (regex) {
    const lines = content.split("\n");
    const cap = typeof limit === "number" && limit > 0 ? limit : 0;
    const pad = typeof previewLength === "number" && previewLength > 0 ? previewLength : 240;
    for (let line = 0; line < lines.length; line++) {
      // CRLF: a trailing CR is the line ending, not part of the match, so
      // `needle$` agrees with ripgrep --crlf and with the editor line.
      const raw = lines[line].endsWith("\r") ? lines[line].slice(0, -1) : lines[line];
      const found = regex.exec(raw);
      if (!found) continue;
      const index = found.index;
      const length = found[0].length;
      const from = Math.max(0, index - pad);
      let to = Math.min(raw.length, index + length + pad);
      // Keep the worker message small. The parent windows to `pad` characters.
      const maxSlice = pad * 2 + 64;
      if (to - from > maxSlice) to = from + maxSlice;
      matches.push({
        line: line + 1,
        column: index + 1,
        matchLength: length,
        text: raw.slice(from, to),
        sliceStart: from,
        lineLength: raw.length,
      });
      if (matches.length >= cap) break;
    }
  }
  port.postMessage(regex ? matches : null);
});
