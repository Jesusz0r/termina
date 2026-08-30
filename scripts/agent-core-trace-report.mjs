#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_TRACE_FILES = 10_000;
const MAX_TRACE_BYTES = 1024 * 1024;

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function counts(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function cacheShare(record) {
  if (!record.usage || typeof record.usage !== "object") return null;
  const total = finiteNonnegative(record.usage.input) + finiteNonnegative(record.usage.cacheRead) + finiteNonnegative(record.usage.cacheWrite);
  return total > 0 ? finiteNonnegative(record.usage.cacheRead) / total : null;
}

function cacheGroups(records, field) {
  const groups = new Map();
  for (const record of records) {
    const name = field(record);
    if (!name) continue;
    const input = finiteNonnegative(record.usage?.input) + finiteNonnegative(record.usage?.cacheRead) + finiteNonnegative(record.usage?.cacheWrite);
    const cacheRead = finiteNonnegative(record.usage?.cacheRead);
    const group = groups.get(name) ?? { turns: 0, totalInput: 0, cacheRead: 0, cachedInputShare: null };
    group.turns++;
    group.totalInput += input;
    group.cacheRead += cacheRead;
    group.cachedInputShare = group.totalInput > 0 ? group.cacheRead / group.totalInput : null;
    groups.set(name, group);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

const CACHE_HASH_FIELDS = ["cacheKeyHash", "modelSettingsHash", "toolsHash", "stablePrefixHash", "messagePrefixHash", "workingSetHash"];

function withCacheChanges(records) {
  let previous = null;
  return records.map((record) => {
    const current = record.cache && typeof record.cache === "object" ? record.cache : null;
    const changes = {};
    for (const field of CACHE_HASH_FIELDS) {
      changes[field] = current && previous ? current[field] !== previous[field] : null;
    }
    if (current) previous = current;
    return { ...record, cacheChanges: changes };
  });
}

function traceNumber(name) {
  const match = /^turn-(\d+)\.json$/.exec(name);
  return match ? Number(match[1]) : null;
}

export function readTraceDirectory(path) {
  const directory = resolve(path);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`trace directory does not exist: ${directory}`);
  }
  const names = readdirSync(directory)
    .map((name) => ({ name, turn: traceNumber(name) }))
    .filter((item) => item.turn !== null)
    .sort((a, b) => a.turn - b.turn)
    .slice(-MAX_TRACE_FILES);
  const records = [];
  const errors = [];
  for (const { name, turn } of names) {
    const file = join(directory, name);
    try {
      if (statSync(file).size > MAX_TRACE_BYTES) throw new Error("file exceeds 1 MiB");
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("root is not an object");
      records.push({ ...record, traceTurn: turn });
    } catch (error) {
      errors.push({ file: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { directory, records, errors, matchedFiles: names.length };
}

export function summarizeTraces(records, label = "traces") {
  const main = withCacheChanges(records.filter((record) => record.role === "main"));
  const summaries = records.filter((record) => record.role === "summary");
  const withUsage = main.filter((record) => record.usage && typeof record.usage === "object");
  const ttft = main.map((record) => record.ttftMs).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const turn = main.map((record) => record.turnMs).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const record of withUsage) {
    usage.input += finiteNonnegative(record.usage.input);
    usage.cacheRead += finiteNonnegative(record.usage.cacheRead);
    usage.cacheWrite += finiteNonnegative(record.usage.cacheWrite);
    usage.output += finiteNonnegative(record.usage.output);
  }
  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  const knownCostTurns = main.filter((record) => typeof record.usd === "number" && Number.isFinite(record.usd) && record.usd >= 0);
  const wasteByCause = {};
  for (const record of main) {
    const waste = finiteNonnegative(record.wasteTokens);
    if (waste === 0) continue;
    const cause = typeof record.wasteCause === "string" && record.wasteCause ? record.wasteCause : "unknown";
    wasteByCause[cause] = (wasteByCause[cause] ?? 0) + waste;
  }
  const tools = main.flatMap((record) => Array.isArray(record.toolNames) ? record.toolNames.filter((name) => typeof name === "string") : []);
  const perTurnCache = main.map((record, index) => ({
    turn: Number.isInteger(record.traceTurn) ? record.traceTurn : index + 1,
    status: typeof record.status === "string" ? record.status : "unknown",
    provider: typeof record.provider === "string" ? record.provider : "unknown",
    protocol: typeof record.protocol === "string" ? record.protocol : "unknown",
    totalInput: finiteNonnegative(record.usage?.input) + finiteNonnegative(record.usage?.cacheRead) + finiteNonnegative(record.usage?.cacheWrite),
    cacheRead: finiteNonnegative(record.usage?.cacheRead),
    cachedInputShare: cacheShare(record),
    workingSetChanged: typeof record.cache?.workingSetChanged === "boolean" ? record.cache.workingSetChanged : null,
    cacheKeyHash: typeof record.cache?.cacheKeyHash === "string" ? record.cache.cacheKeyHash : null,
    stablePrefixHash: typeof record.cache?.stablePrefixHash === "string" ? record.cache.stablePrefixHash : null,
    toolsHash: typeof record.cache?.toolsHash === "string" ? record.cache.toolsHash : null,
    modelSettingsHash: typeof record.cache?.modelSettingsHash === "string" ? record.cache.modelSettingsHash : null,
    messagePrefixHash: typeof record.cache?.messagePrefixHash === "string" ? record.cache.messagePrefixHash : null,
    workingSetHash: typeof record.cache?.workingSetHash === "string" ? record.cache.workingSetHash : null,
    cacheKeyChanged: record.cacheChanges.cacheKeyHash,
    modelSettingsChanged: record.cacheChanges.modelSettingsHash,
    toolsChanged: record.cacheChanges.toolsHash,
    stablePrefixChanged: record.cacheChanges.stablePrefixHash,
    messagePrefixChanged: record.cacheChanges.messagePrefixHash,
    workingSetHashChanged: record.cacheChanges.workingSetHash,
    codexTurnStateUsed: record.cache?.codexTurnStateUsed === true,
  }));
  return {
    label,
    records: records.length,
    mainTurns: main.length,
    summaryCalls: summaries.length,
    statuses: counts(main.map((record) => typeof record.status === "string" ? record.status : "unknown")),
    models: counts(main.map((record) => typeof record.model === "string" ? record.model : "unknown")),
    systemHashes: new Set(main.map((record) => record.systemHash).filter((hash) => typeof hash === "string" && hash)).size,
    latency: {
      ttftSamples: ttft.length,
      p50TtftMs: percentile(ttft, 0.5),
      p95TtftMs: percentile(ttft, 0.95),
      turnSamples: turn.length,
      p50TurnMs: percentile(turn, 0.5),
      p95TurnMs: percentile(turn, 0.95),
    },
    usage: {
      measuredTurns: withUsage.length,
      missingTurns: main.length - withUsage.length,
      ...usage,
      totalInput,
      cachedInputShare: totalInput > 0 ? usage.cacheRead / totalInput : null,
    },
    cache: {
      perTurn: perTurnCache,
      byProvider: cacheGroups(withUsage, (record) => typeof record.provider === "string" ? record.provider : "unknown"),
      byProtocol: cacheGroups(withUsage, (record) => typeof record.protocol === "string" ? record.protocol : "unknown"),
      byWorkingSetChange: cacheGroups(
        withUsage,
        (record) => typeof record.cache?.workingSetChanged === "boolean" ? String(record.cache.workingSetChanged) : "unknown",
      ),
      byCacheKeyChange: cacheGroups(withUsage, (record) => String(record.cacheChanges.cacheKeyHash ?? "unknown")),
      byModelSettingsChange: cacheGroups(withUsage, (record) => String(record.cacheChanges.modelSettingsHash ?? "unknown")),
      byToolsChange: cacheGroups(withUsage, (record) => String(record.cacheChanges.toolsHash ?? "unknown")),
      byStablePrefixChange: cacheGroups(withUsage, (record) => String(record.cacheChanges.stablePrefixHash ?? "unknown")),
    },
    cost: {
      usd: knownCostTurns.reduce((sum, record) => sum + record.usd, 0),
      measuredTurns: knownCostTurns.length,
      missingTurns: main.length - knownCostTurns.length,
    },
    waste: {
      tokens: Object.values(wasteByCause).reduce((sum, value) => sum + value, 0),
      byCause: Object.fromEntries(Object.entries(wasteByCause).sort(([a], [b]) => a.localeCompare(b))),
    },
    revisions: main.reduce((sum, record) => sum + finiteNonnegative(record.revisions), 0),
    tools: { calls: tools.length, byName: counts(tools) },
  };
}

function formatMs(value) {
  return value === null ? "--" : `${(value / 1000).toFixed(2)}s`;
}

function formatInt(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatCounts(value) {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([name, count]) => `${name}=${count}`).join(", ") : "none";
}

function formatCacheTurns(turns) {
  const shown = turns.slice(-100);
  const prefix = turns.length > shown.length ? `${turns.length - shown.length} earlier turns omitted; ` : "";
  const values = shown.map((turn) => {
    const share = turn.cachedInputShare === null ? "--" : `${(turn.cachedInputShare * 100).toFixed(1)}%`;
    return `${turn.turn}=${share}`;
  }).join(", ");
  return `${prefix}${values || "none"}`;
}

function formatCacheGroups(groups) {
  return Object.entries(groups).map(([name, group]) => {
    const share = group.cachedInputShare === null ? "--" : `${(group.cachedInputShare * 100).toFixed(1)}%`;
    return `${name}=${share}`;
  }).join(", ") || "none";
}

export function formatTraceSummary(summary, sourceErrors = []) {
  const cache = summary.usage.cachedInputShare === null ? "--" : `${(summary.usage.cachedInputShare * 100).toFixed(1)}%`;
  const lines = [
    summary.label,
    `  turns: ${summary.mainTurns} main, ${summary.summaryCalls} summary (${formatCounts(summary.statuses)})`,
    `  latency: TTFT p50 ${formatMs(summary.latency.p50TtftMs)}, p95 ${formatMs(summary.latency.p95TtftMs)}; turn p50 ${formatMs(summary.latency.p50TurnMs)}, p95 ${formatMs(summary.latency.p95TurnMs)}`,
    `  tokens: ${formatInt(summary.usage.totalInput)} in (${formatInt(summary.usage.cacheRead)} read, ${formatInt(summary.usage.cacheWrite)} write), ${formatInt(summary.usage.output)} out; cache ${cache}`,
    `  cost: $${summary.cost.usd.toFixed(6)} (${summary.cost.measuredTurns}/${summary.mainTurns} turns measured)`,
    `  waste: ${formatInt(summary.waste.tokens)} (${formatCounts(summary.waste.byCause)})`,
    `  efficiency: ${summary.tools.calls} tool calls, ${summary.revisions} revisions; systems=${summary.systemHashes}`,
    `  cache by turn: ${formatCacheTurns(summary.cache.perTurn)}`,
    `  cache correlation: provider [${formatCacheGroups(summary.cache.byProvider)}]; protocol [${formatCacheGroups(summary.cache.byProtocol)}]; working-set-changed [${formatCacheGroups(summary.cache.byWorkingSetChange)}]`,
    `  cache changes: key [${formatCacheGroups(summary.cache.byCacheKeyChange)}]; settings [${formatCacheGroups(summary.cache.byModelSettingsChange)}]; tools [${formatCacheGroups(summary.cache.byToolsChange)}]; stable-prefix [${formatCacheGroups(summary.cache.byStablePrefixChange)}]`,
  ];
  if (summary.usage.missingTurns > 0) lines.push(`  warning: usage missing for ${summary.usage.missingTurns} main turns`);
  if (sourceErrors.length > 0) lines.push(`  warning: ${sourceErrors.length} trace files could not be read`);
  return lines.join("\n");
}

function defaultDirectories(env) {
  const events = env.TERMINA_EVENTS_DIR;
  const terminal = env.TERMINA_TERMINAL_ID;
  if (!events) return [];
  if (terminal) return [join(events, `${terminal}.traces`)];
  if (!existsSync(events)) return [];
  return readdirSync(events)
    .filter((name) => name.endsWith(".traces"))
    .map((name) => join(events, name));
}

function usage() {
  return "usage: npm run report:agent-core -- [--json] [trace-directory ...]";
}

export function run(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes("--json");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--json");
  if (unknown.length) {
    console.error(`unknown option: ${unknown[0]}\n${usage()}`);
    return 2;
  }
  const paths = argv.filter((arg) => !arg.startsWith("-"));
  const directories = paths.length ? paths : defaultDirectories(env);
  if (directories.length === 0) {
    console.error(`no trace directory found\n${usage()}`);
    return 1;
  }
  const reports = [];
  for (const directory of directories) {
    try {
      const source = readTraceDirectory(directory);
      if (source.matchedFiles === 0) {
        console.error(`no turn trace files found: ${source.directory}`);
        continue;
      }
      reports.push({
        directory: source.directory,
        summary: summarizeTraces(source.records, basename(source.directory)),
        errors: source.errors,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  if (reports.length === 0) return 1;
  if (json) {
    console.log(JSON.stringify({ reports }, null, 2));
  } else {
    console.log(reports.map((report) => formatTraceSummary(report.summary, report.errors)).join("\n\n"));
  }
  return 0;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) process.exitCode = run();
