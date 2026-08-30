/**
 * Shared, provider-independent bounds for tool output.
 *
 * The accumulator counts source bytes as they arrive, keeps only complete
 * UTF-8 code points, and never lets the retained stream grow with the input.
 * A completion state describes the operation that produced the bytes; byte
 * omission is reported separately so a complete operation can still have a
 * deliberately clipped display.
 */

import { Buffer } from "node:buffer";

export const COMPLETION_STATES = Object.freeze([
  "complete",
  "visit-cap",
  "timeout",
  "interrupted",
  "unreadable",
  "failed",
] as const);

export type CompletionState = (typeof COMPLETION_STATES)[number];
export type BoundedTextDirection = "head" | "tail";

export type BoundedTextMarkerDetails = {
  state: CompletionState;
  inputBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  limitBytes: number;
  direction: BoundedTextDirection;
};

export type BoundedTextMarker = string | ((details: BoundedTextMarkerDetails) => string);

export type BoundedTextAccumulatorOptions = {
  maxBytes: number;
  direction?: BoundedTextDirection;
  marker?: BoundedTextMarker;
};

export type BoundedTextOptions = BoundedTextAccumulatorOptions & {
  state?: CompletionState;
};

export type BoundedText = Readonly<{
  text: string;
  state: CompletionState;
  direction: BoundedTextDirection;
  limitBytes: number;
  inputBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  outputBytes: number;
  truncated: boolean;
}>;

export type BoundedToolResult = BoundedText & Readonly<{
  content: string;
  isError: boolean;
}>;

function isCompletionState(value: string): value is CompletionState {
  return (COMPLETION_STATES as readonly string[]).includes(value);
}

function assertCompletionState(value: string): asserts value is CompletionState {
  if (!isCompletionState(value)) throw new Error(`invalid completion state: ${value}`);
}

function assertLimit(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error("maxBytes must be a non-negative integer");
}

function expectedUtf8Length(first: number): number {
  if (first <= 0x7f) return 1;
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  if (first >= 0xf0 && first <= 0xf4) return 4;
  return 0;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function isValidUtf8Sequence(sequence: readonly number[]): boolean {
  const first = sequence[0];
  const second = sequence[1];
  if (first === undefined || second === undefined) return sequence.length === 1 && first <= 0x7f;
  if (!isContinuation(second)) return false;
  if (first === 0xe0 && second < 0xa0) return false;
  if (first === 0xed && second >= 0xa0) return false;
  if (first === 0xf0 && second < 0x90) return false;
  if (first === 0xf4 && second >= 0x90) return false;
  return sequence.slice(2).every(isContinuation);
}

/** Return the longest valid UTF-8 prefix that fits in maxBytes. */
function utf8Prefix(value: Uint8Array, maxBytes: number): Buffer {
  if (maxBytes <= 0 || value.byteLength === 0) return Buffer.alloc(0);
  const end = Math.min(value.byteLength, maxBytes);
  let cursor = 0;
  let safeEnd = 0;
  while (cursor < end) {
    const length = expectedUtf8Length(value[cursor]!);
    if (length === 0 || cursor + length > end) break;
    const sequence = Array.from(value.subarray(cursor, cursor + length));
    if (!isValidUtf8Sequence(sequence)) break;
    cursor += length;
    safeEnd = cursor;
  }
  return Buffer.from(value.subarray(0, safeEnd));
}

function flatten(sequences: readonly Uint8Array[]): Buffer {
  return Buffer.concat(sequences.map((sequence) => Buffer.from(sequence)));
}

function defaultMarker(state: CompletionState): string {
  return state === "complete" ? "[output truncated]" : `[output incomplete: ${state}]`;
}

type FittedText = {
  body: Buffer[];
  bodyBytes: number;
  markerBytes: Uint8Array;
};

/** Fit a complete-code-point body and marker into the final byte budget. */
function fitText(
  source: readonly Buffer[],
  direction: BoundedTextDirection,
  maxBytes: number,
  marker: string,
): FittedText {
  let markerBytes: Uint8Array = Buffer.from(marker, "utf8");
  if (markerBytes.byteLength > maxBytes) markerBytes = utf8Prefix(markerBytes, maxBytes);
  const separatorBytes = source.length > 0 && markerBytes.byteLength > 0 ? 1 : 0;
  const bodyLimit = Math.max(0, maxBytes - markerBytes.byteLength - separatorBytes);
  const body = trimSequences(source, direction, bodyLimit);
  const bodyBytes = sumBytes(body);
  return { body, bodyBytes, markerBytes };
}

/**
 * A bounded UTF-8 stream accumulator.
 *
 * `maxBytes` bounds the final rendered text, including its omission marker.
 * The source byte count remains exact even after the retained head/tail is
 * full. `finish` freezes and memoizes its result; late pushes are rejected.
 */
export class BoundedTextAccumulator {
  private readonly maxBytes: number;
  private readonly direction: BoundedTextDirection;
  private readonly marker: BoundedTextMarker | undefined;
  private readonly sequences: Buffer[] = [];
  private sequenceStart = 0;
  private pending: number[] = [];
  private sourceBytes = 0;
  private retainedBytesValue = 0;
  private sourceTruncated = false;
  private finishedResult: BoundedText | null = null;

  constructor(options: BoundedTextAccumulatorOptions) {
    assertLimit(options.maxBytes);
    this.maxBytes = options.maxBytes;
    this.direction = options.direction ?? "head";
    this.marker = options.marker;
  }

  push(chunk: string | Uint8Array): void {
    if (this.finishedResult) throw new Error("bounded text accumulator is already finished");
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      throw new TypeError("bounded text chunks must be strings or Uint8Array values");
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.sourceBytes += bytes.byteLength;
    for (const byte of bytes) this.consumeByte(byte);
  }

  finish(state: CompletionState = "complete"): BoundedText {
    if (this.finishedResult) return this.finishedResult;
    assertCompletionState(state);
    if (this.pending.length > 0) {
      this.pending = [];
      this.sourceTruncated = true;
    }

    const needsMarker = this.sourceTruncated || state !== "complete";
    const sourceBody = this.activeSequences();
    const markerDetails = (retainedBytes: number): BoundedTextMarkerDetails => ({
      state,
      inputBytes: this.sourceBytes,
      retainedBytes,
      omittedBytes: Math.max(0, this.sourceBytes - retainedBytes),
      limitBytes: this.maxBytes,
      direction: this.direction,
    });
    const markerFor = (details: BoundedTextMarkerDetails): string => {
      const rawMarker = typeof this.marker === "function"
        ? this.marker(details)
        : this.marker ?? defaultMarker(state);
      return String(rawMarker);
    };

    let marker = needsMarker && this.maxBytes > 0
      ? markerFor(markerDetails(this.retainedBytesValue))
      : "";
    let fitted = fitText(sourceBody, this.direction, this.maxBytes, marker);
    if (needsMarker && typeof this.marker === "function" && this.maxBytes > 0) {
      // Marker size can depend on omittedBytes (for example, a continuation
      // hint that includes a count). Iterate to a fixed point so the callback
      // sees the same final accounting that the rendered result exposes.
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const nextMarker = markerFor(markerDetails(fitted.bodyBytes));
        const nextFitted = fitText(sourceBody, this.direction, this.maxBytes, nextMarker);
        const stable = nextMarker === marker &&
          nextFitted.bodyBytes === fitted.bodyBytes &&
          Buffer.from(nextFitted.markerBytes).equals(Buffer.from(fitted.markerBytes));
        marker = nextMarker;
        fitted = nextFitted;
        if (stable) break;
      }
    }

    const { body, bodyBytes, markerBytes } = fitted;

    const bodyText = flatten(body).toString("utf8");
    const markerText = Buffer.from(markerBytes).toString("utf8");
    const text = bodyText && markerText ? `${bodyText}\n${markerText}` : bodyText || markerText;
    const result: BoundedText = Object.freeze({
      text,
      state,
      direction: this.direction,
      limitBytes: this.maxBytes,
      inputBytes: this.sourceBytes,
      retainedBytes: bodyBytes,
      omittedBytes: Math.max(0, this.sourceBytes - bodyBytes),
      outputBytes: Buffer.byteLength(text, "utf8"),
      truncated: this.sourceTruncated || state !== "complete" || bodyBytes < this.retainedBytesValue,
    });
    this.finishedResult = result;
    return result;
  }

  private consumeByte(byte: number): void {
    if (this.pending.length === 0) {
      const length = expectedUtf8Length(byte);
      if (length === 1) {
        this.accept(Buffer.from([byte]));
      } else if (length > 1) {
        this.pending.push(byte);
      } else {
        this.sourceTruncated = true;
      }
      return;
    }

    if (isContinuation(byte)) {
      this.pending.push(byte);
      const expected = expectedUtf8Length(this.pending[0]!);
      if (this.pending.length === expected) {
        const sequence = this.pending;
        this.pending = [];
        if (isValidUtf8Sequence(sequence)) this.accept(Buffer.from(sequence));
        else this.sourceTruncated = true;
      }
      return;
    }

    // The pending sequence was malformed or ended before this byte. Drop it
    // as omitted data, then process the current byte as a new sequence.
    this.pending = [];
    this.sourceTruncated = true;
    this.consumeByte(byte);
  }

  private accept(sequence: Buffer): void {
    if (this.direction === "head") {
      if (this.retainedBytesValue + sequence.byteLength <= this.maxBytes) {
        this.sequences.push(sequence);
        this.retainedBytesValue += sequence.byteLength;
      } else {
        this.sourceTruncated = true;
      }
      return;
    }

    this.sequences.push(sequence);
    this.retainedBytesValue += sequence.byteLength;
    while (this.retainedBytesValue > this.maxBytes && this.sequenceStart < this.sequences.length) {
      this.retainedBytesValue -= this.sequences[this.sequenceStart]!.byteLength;
      this.sequenceStart += 1;
      this.sourceTruncated = true;
    }
    // Keep the backing array bounded even for a long one-byte stream.
    if (this.sequenceStart > 1024 && this.sequenceStart * 2 > this.sequences.length) {
      this.sequences.splice(0, this.sequenceStart);
      this.sequenceStart = 0;
    }
  }

  private activeSequences(): Buffer[] {
    return this.sequences.slice(this.sequenceStart);
  }
}

function sumBytes(sequences: readonly Uint8Array[]): number {
  return sequences.reduce((total, sequence) => total + sequence.byteLength, 0);
}

function trimSequences(
  source: readonly Buffer[],
  direction: BoundedTextDirection,
  maxBytes: number,
): Buffer[] {
  if (maxBytes <= 0) return [];
  const out = source.slice();
  let bytes = sumBytes(out);
  if (direction === "head") {
    while (out.length > 0 && bytes > maxBytes) bytes -= out.pop()!.byteLength;
  } else {
    let start = 0;
    while (start < out.length && bytes > maxBytes) {
      bytes -= out[start]!.byteLength;
      start += 1;
    }
    return out.slice(start);
  }
  return out;
}

export function boundText(input: string | Uint8Array, options: BoundedTextOptions): BoundedText {
  const accumulator = new BoundedTextAccumulator(options);
  accumulator.push(input);
  return accumulator.finish(options.state ?? "complete");
}

export type BoundedToolResultOptions = BoundedTextOptions & {
  isError: boolean;
};

export function boundedToolResult(
  input: string | Uint8Array,
  options: BoundedToolResultOptions,
): BoundedToolResult {
  const text = boundText(input, options);
  return Object.freeze({
    ...text,
    content: text.text,
    isError: options.isError,
  });
}

export type BoundedResponseBodyReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void> | void;
  releaseLock?(): void;
};

export type BoundedResponseBodyLike = {
  body?: {
    getReader(): BoundedResponseBodyReader;
  } | null;
  headers?: {
    get(name: string): string | null | undefined;
  };
  status?: number;
};

export type BoundedResponseBodyResult = BoundedText & Readonly<{
  /** The validated Content-Length, or null when the total was not declared safely. */
  contentLength: number | null;
  /** Whether inputBytes is a trusted total rather than only observed stream bytes. */
  inputBytesKnown: boolean;
}>;

function readContentLength(response: BoundedResponseBodyLike): number | null {
  let raw: string | null | undefined;
  try {
    raw = response.headers?.get("content-length");
  } catch {
    return null;
  }
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const length = Number(normalized);
  return Number.isSafeInteger(length) ? length : null;
}

function hasKnownEmptyBody(response: BoundedResponseBodyLike, contentLength: number | null): boolean {
  if (contentLength === 0) return true;
  if (contentLength !== null) return false;
  return response.status === 204 || response.status === 205 || response.status === 304;
}

function responseResult(
  result: BoundedText,
  contentLength: number | null,
  inputBytesKnown: boolean,
  forceTruncated = false,
): BoundedResponseBodyResult {
  const inputBytes = inputBytesKnown && contentLength !== null ? contentLength : result.inputBytes;
  const omittedBytes = inputBytesKnown && contentLength !== null
    ? Math.max(0, contentLength - result.retainedBytes)
    : result.omittedBytes;
  return Object.freeze({
    ...result,
    inputBytes,
    omittedBytes,
    truncated: result.truncated || forceTruncated || omittedBytes > 0,
    contentLength,
    inputBytesKnown,
  });
}

/**
 * Read an HTTP response body without invoking an unbounded body convenience
 * method. The stream is retained only through BoundedTextAccumulator. In the
 * default head direction, the reader is cancelled as soon as the raw stream
 * has crossed maxBytes; callers can therefore use this for both success and
 * error responses without first materializing an untrusted body.
 *
 * A valid Content-Length supplies the total byte count even when cancellation
 * happens after only a prefix. Missing or unsafe lengths are simply treated
 * as unknown while a stream is available. If there is no stream, the helper
 * fails closed unless the response is provably empty (zero Content-Length or
 * an HTTP status that forbids a body); it never falls back to text(), json(),
 * or arrayBuffer().
 */
export async function readBoundedResponseBody(
  response: BoundedResponseBodyLike,
  options: BoundedTextOptions,
): Promise<BoundedResponseBodyResult> {
  const contentLength = readContentLength(response);
  let markerInputBytes = contentLength;
  const markerCallback = options.marker;
  const marker = typeof markerCallback === "function"
    ? (details: BoundedTextMarkerDetails): string => {
      const inputBytes = markerInputBytes ?? details.inputBytes;
      return markerCallback({
        ...details,
        inputBytes,
        omittedBytes: Math.max(0, inputBytes - details.retainedBytes),
      });
    }
    : options.marker;
  const accumulator = new BoundedTextAccumulator({
    maxBytes: options.maxBytes,
    direction: options.direction,
    marker,
  });

  const body = response.body;
  if (!body) {
    if (hasKnownEmptyBody(response, contentLength)) {
      return responseResult(
        accumulator.finish(options.state ?? "complete"),
        contentLength,
        contentLength !== null,
      );
    }
    // A declared non-zero body without a stream cannot be safely recovered;
    // do not call any potentially unbounded Response convenience method.
    return responseResult(
      accumulator.finish("failed"),
      contentLength,
      contentLength !== null,
      true,
    );
  }

  let observedBytes = 0;
  let capReached = false;
  let failed = false;
  let reader: BoundedResponseBodyReader | null = null;
  try {
    reader = body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new TypeError("response body reader returned a non-byte chunk");
      observedBytes += next.value.byteLength;
      accumulator.push(next.value);
      // Tail retention must see the whole stream. Head retention can release
      // the reader immediately after the first over-limit chunk.
      if ((options.direction ?? "head") === "head" && observedBytes > options.maxBytes) {
        capReached = true;
        if (typeof reader.cancel === "function") await reader.cancel("bounded response body limit reached");
        break;
      }
    }
  } catch {
    failed = true;
  } finally {
    try {
      reader?.releaseLock?.();
    } catch {
      // Releasing a disturbed reader must not discard the bounded result.
    }
  }

  let inputBytesKnown = contentLength !== null;
  if (contentLength !== null && observedBytes > contentLength) {
    // The header cannot describe the observed stream; retain exact observed
    // accounting and avoid presenting the declaration as authoritative.
    markerInputBytes = observedBytes;
    inputBytesKnown = false;
    failed = true;
  }
  const expectedBytesMissing = contentLength !== null && !capReached && observedBytes < contentLength;
  if (expectedBytesMissing) failed = true;
  const state = failed ? "failed" : options.state ?? "complete";
  const result = accumulator.finish(state);
  return responseResult(result, contentLength, inputBytesKnown, capReached || expectedBytesMissing);
}
