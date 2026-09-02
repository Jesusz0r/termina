import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readTraceDirectory, summarizeTraces } from "./trace-report.ts";

describe("Agent Core Trace Report Invariants", () => {
  it("passes agent-core trace report tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-report-"));
    process.on("exit", () => rmSync(root, { recursive: true, force: true }));
    const traces = join(root, "term-test.traces");
    mkdirSync(traces);
    
    const records = [
      {
        role: "main",
        provider: "openai-codex",
        protocol: "openai-codex-responses",
        model: "model-a",
        status: "ok",
        toolNames: ["read_file", "edit"],
        cache: { cacheKeyHash: "key", stablePrefixHash: "prefix", toolsHash: "tools", modelSettingsHash: "settings", messagePrefixHash: "message-1", workingSetHash: "work", workingSetChanged: null, codexTurnStateUsed: false },
        usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 },
        usd: 0.1,
        ttftMs: 100,
        turnMs: 500,
        revisions: 0,
        wasteTokens: 0,
        wasteCause: null,
        systemHash: "same",
      },
      {
        role: "main",
        provider: "openai-codex",
        protocol: "openai-codex-responses",
        model: "model-a",
        status: "ok",
        toolNames: ["read_file"],
        cache: { cacheKeyHash: "key", stablePrefixHash: "prefix", toolsHash: "tools", modelSettingsHash: "settings", messagePrefixHash: "message-2", workingSetHash: "work", workingSetChanged: false, codexTurnStateUsed: true },
        usage: { input: 20, cacheRead: 80, cacheWrite: 0, output: 20 },
        usd: 0.2,
        ttftMs: 200,
        turnMs: 600,
        revisions: 1,
        wasteTokens: 20,
        wasteCause: "unexplained",
        systemHash: "same",
      },
      {
        role: "main",
        model: "model-a",
        status: "error",
        toolNames: [],
        usage: null,
        usd: null,
        ttftMs: 1000,
        turnMs: 1500,
        revisions: 0,
        wasteTokens: 30,
        wasteCause: "idle-expired",
        systemHash: "changed",
      },
      {
        role: "summary",
        model: "summary-model",
        status: "ok",
        toolNames: [],
        usage: { input: 50, cacheRead: 0, cacheWrite: 0, output: 5 },
        usd: null,
        ttftMs: null,
        turnMs: 100,
        revisions: 1,
        wasteTokens: 0,
        wasteCause: null,
        systemHash: "summary",
      },
    ];
    records.forEach((record, index) => writeFileSync(join(traces, `turn-${index + 1}.json`), JSON.stringify(record)));
    writeFileSync(join(traces, "turn-5.json"), "{");
    writeFileSync(join(traces, "ignore.json"), "{}");
    
    const source = readTraceDirectory(traces);
    assert.equal(source.matchedFiles, 5);
    assert.equal(source.records.length, 4);
    assert.equal(source.errors.length, 1);
    const report = summarizeTraces(source.records, "test");
    assert.equal(report.mainTurns, 3);
    assert.equal(report.summaryCalls, 1);
    assert.deepEqual(report.statuses, { error: 1, ok: 2 });
    assert.equal(report.latency.p50TtftMs, 200);
    assert.equal(report.latency.p95TtftMs, 1000);
    assert.equal(report.latency.p50TurnMs, 600);
    assert.equal(report.usage.input, 120);
    assert.equal(report.usage.cacheRead, 80);
    assert.equal(report.usage.totalInput, 200);
    assert.equal(report.usage.cachedInputShare, 0.4);
    assert.equal(report.usage.missingTurns, 1);
    assert.equal(report.cache.perTurn[0].cachedInputShare, 0);
    assert.equal(report.cache.perTurn[1].cachedInputShare, 0.8);
    assert.equal(report.cache.perTurn[1].codexTurnStateUsed, true);
    assert.equal(report.cache.perTurn[1].cacheKeyChanged, false);
    assert.equal(report.cache.perTurn[1].stablePrefixChanged, false);
    assert.equal(report.cache.perTurn[1].messagePrefixChanged, true);
    assert.equal(report.cache.perTurn[2].stablePrefixChanged, null);
    assert.equal(report.cache.byProvider["openai-codex"].cachedInputShare, 0.4);
    assert.equal(report.cache.byWorkingSetChange.false.cachedInputShare, 0.8);
    assert.ok(Math.abs(report.cost.usd - 0.3) < Number.EPSILON * 2);
    assert.equal(report.cost.missingTurns, 1);
    assert.deepEqual(report.waste.byCause, { "idle-expired": 30, unexplained: 20 });
    assert.equal(report.tools.calls, 3);
    assert.deepEqual(report.tools.byName, { edit: 1, read_file: 2 });
    assert.equal(report.revisions, 1);
    assert.equal(report.systemHashes, 2);
    
    const cli = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "trace-report.ts"), "--json", traces], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    const cliReport = JSON.parse(cli.stdout);
    assert.equal(cliReport.reports[0].summary.usage.cachedInputShare, 0.4);
    assert.equal(cliReport.reports[0].errors.length, 1);
    
    const fromEnv = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "trace-report.ts"), "--json"], {
      encoding: "utf8",
      env: { ...process.env, TERMINA_EVENTS_DIR: root, TERMINA_TERMINAL_ID: "term-test" },
    });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(JSON.parse(fromEnv.stdout).reports[0].summary.mainTurns, 3);
    
    console.log("agent-core trace report tests passed");
  }, 60_000);
});
