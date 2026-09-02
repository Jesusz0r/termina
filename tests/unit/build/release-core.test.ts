import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageCoreBinary } from "../../../scripts/build-core.mjs";

const CORE_REQUEST_TIMEOUT_MS = 5_000;
const CORE_RESPONSE_MAX_BYTES = 64 * 1024;
const source = resolve("core/target/release/termina-core");

function architectureFromBytes(bytes: Buffer): string {
  const magicLE = bytes.length >= 4 ? bytes.readUInt32LE(0) : 0;
  const magicBE = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
  const machCpu = (value: number) => (value === 0x0100000c ? "arm64" : value === 0x01000007 ? "x64" : `mach-${value}`);
  if (magicLE === 0xfeedfacf) return machCpu(bytes.readUInt32LE(4));
  if (magicBE === 0xfeedfacf) return machCpu(bytes.readUInt32BE(4));
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf || magicLE === 0xcafebabe || magicLE === 0xcafebabf) {
    const little = magicLE === 0xcafebabe || magicLE === 0xcafebabf;
    const read32 = little ? (offset: number) => bytes.readUInt32LE(offset) : (offset: number) => bytes.readUInt32BE(offset);
    const is64 = (little ? magicLE : magicBE) === 0xcafebabf;
    const count = read32(4);
    const entryBytes = is64 ? 32 : 20;
    const architectures: string[] = [];
    for (let index = 0; index < count && 8 + (index + 1) * entryBytes <= bytes.length; index++) {
      architectures.push(machCpu(read32(8 + index * entryBytes)));
    }
    return architectures.sort().join(",");
  }
  if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const little = bytes[5] !== 2;
    const machine = little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
    return machine === 183 ? "arm64" : machine === 62 ? "x64" : `elf-${machine}`;
  }
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 6 <= bytes.length && bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0"))) {
      const machine = bytes.readUInt16LE(peOffset + 4);
      return machine === 0xaa64 ? "arm64" : machine === 0x8664 ? "x64" : `pe-${machine}`;
    }
  }
  return "unknown";
}

function expectedArchitecture(): string {
  return process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
}

function identity(path: string) {
  const bytes = readFileSync(path);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    architecture: architectureFromBytes(bytes),
  };
}

async function boundedCoreRequest(binary: string) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  const closePromise = once(child, "close");
  let stdout = "";
  let stderr = "";
  let requestTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  try {
    const response = await new Promise<any>((resolveResponse, rejectResponse) => {
      requestTimer = setTimeout(() => rejectResponse(new Error(`staged core request exceeded ${CORE_REQUEST_TIMEOUT_MS}ms`)), CORE_REQUEST_TIMEOUT_MS);
      child.once("error", rejectResponse);
      child.once("close", (code, signal) => rejectResponse(new Error(`staged core closed before its response (${signal ?? `code ${code}`})`)));
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (Buffer.byteLength(stderr, "utf8") < 8 * 1024) stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > CORE_RESPONSE_MAX_BYTES) {
          rejectResponse(new Error(`staged core response exceeded ${CORE_RESPONSE_MAX_BYTES} bytes`));
          return;
        }
        const line = stdout.split(/\r?\n/, 1)[0];
        if (!line.trim()) return;
        try {
          resolveResponse(JSON.parse(line));
        } catch (error: any) {
          rejectResponse(new Error(`staged core returned malformed JSON: ${error.message}`));
        }
      });
      child.stdin.end(`${JSON.stringify({
        op: "git-top-level",
        root: resolve("."),
        requestId: "release-core-stage-1",
      })}\n`);
    });
    clearTimeout(requestTimer);
    expect(response.op).toBe("git-top-level-result");
    expect(response.requestId).toBe("release-core-stage-1");
    expect(response.ok).toBe(true);
    const [code, signal] = await Promise.race([
      closePromise,
      new Promise<[number, string]>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error("staged core did not close after its bounded response")), 1_000);
      }),
    ]);
    expect(signal).toBeNull();
    expect(code).toBe(0);
    return response;
  } catch (error: any) {
    try { child.kill("SIGKILL"); } catch { /* already closed */ }
    await closePromise.catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\ncore stderr: ${stderr}` : ""}`);
  } finally {
    clearTimeout(requestTimer);
    clearTimeout(closeTimer);
  }
}

describe("Release Core Binary Staging & Architecture Invariants", () => {
  it("preserves identity, architecture, and bounded JSON-lines protocol", async () => {
    if (!existsSync(source)) {
      console.warn("Release core binary not found at " + source + ", skipping");
      return;
    }

    const sourceIdentity = identity(source);
    expect(sourceIdentity.bytes).toBeGreaterThan(0);
    expect(sourceIdentity.architecture).toBe(expectedArchitecture());

    const root = mkdtempSync(join(tmpdir(), "termina-release-core-stage-"));
    const destination = join(root, "dist-electron", "termina-core");
    const oldCore = resolve("resources/termina-core");

    try {
      mkdirSync(join(root, "dist-electron"), { recursive: true });
      if (existsSync(oldCore)) copyFileSync(oldCore, destination);
      else writeFileSync(destination, "old staged core");
      chmodSync(destination, 0o755);
      const oldInode = statSync(destination).ino;

      stageCoreBinary(source, destination);
      const stagedIdentity = identity(destination);
      expect(statSync(destination).ino).not.toBe(oldInode);
      expect(stagedIdentity).toEqual(sourceIdentity);
      expect(stagedIdentity.architecture).toBe(expectedArchitecture());
      expect(readdirSync(join(root, "dist-electron"))).toEqual(["termina-core"]);
      await boundedCoreRequest(destination);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
