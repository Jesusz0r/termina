/** Display-only transcript folds. Links identify entries, never screen coordinates. */
import { terminalTranscriptUri } from "../../shared/terminal-link.ts";
import { formatToolSummary } from "../tui-text.ts";
import { toolStatusLabel, type StyledSpan, type TranscriptEntry } from "./transcript.ts";

export function isTranscriptExpanded(entry: TranscriptEntry): boolean {
  return entry.expanded ?? (entry.kind === "thinking" && !entry.settled);
}

export function transcriptFoldHeader(entry: TranscriptEntry): StyledSpan {
  const title = entry.kind === "thinking"
    ? "Thinking"
    : formatToolSummary(entry.toolName || "", entry.toolDetail, toolStatusLabel(entry.toolState));
  return {
    text: `${isTranscriptExpanded(entry) ? "▾" : "▸"} ${title}`,
    style: entry.kind === "thinking" ? 6 : 4,
    link: terminalTranscriptUri(entry.id),
  };
}

export function toolTranscriptSpans(entry: TranscriptEntry): StyledSpan[] {
  const header = transcriptFoldHeader(entry);
  const labelEnd = header.text.indexOf("  ");
  // Only the disclosure/name is an internal link. Keeping details outside
  // OSC 8 lets the terminal's file-link provider still own their paths.
  const spans: StyledSpan[] = [
    { ...header, text: header.text.slice(0, labelEnd) },
    { text: header.text.slice(labelEnd), style: header.style },
  ];
  if (entry.text && isTranscriptExpanded(entry)) spans.push({ text: `\n${entry.text}`, style: 0 });
  return spans;
}
