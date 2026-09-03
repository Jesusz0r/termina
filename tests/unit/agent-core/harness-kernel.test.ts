import { describe, it, expect } from "vitest";
/**
 * Kernel tests for agent-core harness upgrades.
 * No Electron, no API key, no scripts/build.mjs.
 *
 *   npm run test:agent-core
 */
process.env.TERMINA_CORE_TEST = "1";

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCheckReporter } from "../../test-support.ts";

describe("Agent Core Kernel & TUI Harness Suite", () => {
  it("passes all kernel harness assertions natively", async () => {
    const core = await import("../../../agent-core/main.ts");
    const host = await import("../../../agent-core/host.ts");
    const auth = await import("../../../agent-core/auth.ts");
    const compat = await import("../../../agent-core/openai-compat.ts");
    const projection = await import("../../../agent-core/request-projection.ts");
    const reclaim = await import("../../../agent-core/reclaim.ts");
    const session = await import("../../../agent-core/session.ts");
    const trace = await import("../../../agent-core/trace.ts");
    const toolOutput = await import("../../../agent-core/tool-output.ts");
    const tuiCore = await import("../../../agent-core/tui.ts");
    
    const {
      confinePath,
      matchGlob,
      grepFiles,
      formatGrepHits,
      completeGrepStdout,
      globFiles,
      scanSkills,
      formatSkillIndex,
      formatProjectInstructions,
      formatUserInstructions,
      formatEnvironment,
      parsePrintPrompt,
      reproFor,
      readProjectFile,
      writeProjectFile,
      editProjectFile,
      nestedAgentsPointer,
      parseOffset,
      parseLineBound,
      formatNumberedText,
      listProjectDir,
      editMissDiagnostic,
      validateGrepPattern,
      buildCachedPrefix,
      anthropicCacheMark,
      renderHistoryTranscript,
      sidecarStartFor,
      formatToolAnnounce,
      formatToolFollowup,
      isDangerousBash,
      shouldAskPermission,
      runBash,
      isDirectRun,
      tracesDirFor,
      isValidTerminalId,
      readFileResult,
      FROZEN_IDENTITY,
      buildFrozenSystem,
      isDirectRunFrom,
      hashSystem,
      WEB_SEARCH_TOOL,
      requestTools,
      stampHistoryCache,
      placeStreamBlock,
      compactStreamBlocks,
      displayToolOutput,
      listTaggedFiles,
      collectRelativeFiles,
      parseFileTags,
      expandFileTags,
      shouldCompactForCacheCost,
      retryAfter,
      parseEffortCommand,
      supportedEffortLevels,
      clampEffortLevel,
      thinkingEnabledFor,
      thinkingRequestFor,
      adaptiveEffortFor,
      effectiveEffortFor,
      reasoningEffortFor,
      outputTokenBudget,
      includeEncryptedReasoning,
      gpt56ReasoningContext,
      gpt5TextVerbosity,
      defaultContextWindow,
      formatUsageIndicators,
      fetchUrl,
      fetchUrlError,
      trustedPath,
      parseBangCommand,
      bangCommandContext,
    } = core;
    
    const {
      buildRequestOverlay,
      projectPersistedMessages,
      appendRequestOverlay,
      userPromptContent,
    } = projection;
    const { estimateReclaimTokens, makePruneRevision, planPruneStubs } = reclaim;
    const { createAttemptRecord, createTraceRuntime } = trace;
    const { boundText } = toolOutput;
    const {
      formatStub,
      replaySessionRecords,
      resolveSessionFile,
      sessionRotateStamp,
      MAX_SESSION_SEGMENT_BYTES,
      MAX_SESSION_RECORD_BYTES,
      isCoreSessionBundleFile,
      isCoreSessionId,
      prepareFreshSession,
      sessionBlockBytes,
      sessionBlockHash,
    } = session;
    const {
      SLASH_COMMANDS,
      matchingSlashCommands,
      completeSlashLine,
      fileMentionAt,
      applyFileMention,
      completeFileMention,
      rankFileTags,
      subsequenceSpread,
      formatTuiFooter,
    } = tuiCore;
    
    const { check, results } = createCheckReporter();
    
    function projectPersistedForTest(messages, imageRoots = []) {
      const result = projectPersistedMessages({ messages, imageRoots });
      if (!result.ok) throw new Error(result.error);
      return result.messages;
    }
    
    function projectBlockForTest(block) {
      const projected = projectPersistedForTest([{ role: "user", content: [block], sseq: 1, tokens: 1 }]);
      return projected[0]?.content?.[0];
    }
    
    function workingSetForTest(opts) {
      return buildRequestOverlay(opts)?.text ?? "";
    }
    
    const root = mkdtempSync(join(tmpdir(), "agent-core-"));
    const leftovers = [root];
    const cleanup = () => {
      for (const p of leftovers) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    };
    process.on("exit", cleanup);
    
    writeFileSync(join(root, "ok.txt"), "hello");
    mkdirSync(join(root, "pkg", "src"), { recursive: true });
    writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "pkg", "AGENTS.md"), "# pkg rules\n");
    writeFileSync(join(root, "AGENTS.md"), "# root\n");
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "hid.ts"), "secret\n");
    writeFileSync(join(root, "root.ts"), "export const root = 1;\n");
    
    check("jail /etc/passwd fails", confinePath(root, "/etc/passwd").ok === false);
    check("jail ../ outside fails", confinePath(root, "..").ok === false);
    check("jail foo/../../etc/passwd fails", confinePath(root, "foo/../../etc/passwd").ok === false);
    check("jail relative in-cwd succeeds", confinePath(root, "ok.txt").ok === true);
    check("jail absolute /etc/passwd fails", confinePath(root, "/etc/passwd").ok === false);
    
    const skillDir = mkdtempSync(join(tmpdir(), "agent-core-skill-"));
    leftovers.push(skillDir);
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "---\nname: demo\ndescription: d\n---\nbody\n");
    const skillReal = realpathSync(skillFile);
    const allow = new Set([skillReal]);
    check("allow-set skill outside cwd is readable", confinePath(root, skillFile, { allow }).ok === true);
    check("sibling next to allow-set skill is not readable", confinePath(root, join(skillDir, "other.md"), { allow }).ok === false);
    check("write_file to allow path fails", writeProjectFile(root, skillFile, "nope").isError === true);
    
    mkdirSync(join(root, "inner"), { recursive: true });
    symlinkSync(join(root, "inner"), join(root, "inside-link"));
    const insideWrite = writeProjectFile(root, "inside-link/new.txt", "ok");
    check("symlink parent inside cwd succeeds", insideWrite.isError === false);
    symlinkSync("/tmp", join(root, "out-link"));
    check("symlink parent outside cwd rejects", writeProjectFile(root, "out-link/new.txt", "x").isError === true);
    symlinkSync(join(root, "missing-target"), join(root, "dangle"));
    const dangleWrite = writeProjectFile(root, "dangle/new.txt", "x");
    check("dangling parent symlink rejects", dangleWrite.isError === true && dangleWrite.content.includes("cannot resolve"));
    check("dangling parent confinePath fails closed", confinePath(root, "dangle/new.txt").ok === false);
    check("dangling symlink itself fails closed", confinePath(root, "dangle").ok === false);
    
    const big = Buffer.alloc(50 * 1024, 97);
    writeFileSync(join(root, "big.txt"), big);
    const first = readProjectFile(root, { path: "big.txt", offset: 0 });
    check("read offset 0 truncates with next offset", !first.isError && first.content.includes("read_file offset "));
    const next = Number((first.content.match(/offset (\d+)/) || [])[1]);
    const second = readProjectFile(root, { path: "big.txt", offset: next });
    check("read second offset returns more bytes", !second.isError && second.content.length > 0);
    check("offset past EOF is empty success", readProjectFile(root, { path: "big.txt", offset: 5_000_000 }).content === "");
    check("offset nope errors", readProjectFile(root, { path: "ok.txt", offset: "nope" }).isError === true);
    check("offset infinity errors", readProjectFile(root, { path: "ok.txt", offset: Infinity }).isError === true);
    check("offset unsafe integer errors", typeof parseOffset(Number.MAX_SAFE_INTEGER + 1) === "object");
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2, 3]));
    check("NUL in first 4 KB errors", readProjectFile(root, { path: "bin.dat" }).isError === true);
    check("readFileResult does not require whole file API", !readFileResult(join(root, "ok.txt"), 0).isError);
    check("formatNumberedText prefixes 1-based lines", formatNumberedText("a\nb\n", 1) === "     1|a\n     2|b");
    check("formatNumberedText strips CR", formatNumberedText("a\r\nb\r\n", 1) === "     1|a\n     2|b");
    check("read_file numbers lines", readProjectFile(root, { path: "ok.txt" }).content === "     1|hello");
    writeFileSync(join(root, "lines.txt"), "one\ntwo\nthree\nfour\n");
    check(
      "read_file start_line/end_line is inclusive",
      readProjectFile(root, { path: "lines.txt", start_line: 2, end_line: 3 }).content === "     2|two\n     3|three",
    );
    check("read_file start_line past EOF is empty", readProjectFile(root, { path: "lines.txt", start_line: 99 }).content === "");
    check("read_file rejects offset with start_line", readProjectFile(root, { path: "lines.txt", offset: 1, start_line: 1 }).isError === true);
    check("read_file directory rejects start_line", readProjectFile(root, { path: "pkg", start_line: 1 }).isError === true);
    check("parseLineBound rejects 0", typeof parseLineBound(0, "start_line") === "object");
    const manyRows = [];
    for (let i = 1; i <= 8000; i++) manyRows.push(`row-${String(i).padStart(4, "0")}`);
    writeFileSync(join(root, "many-lines.txt"), `${manyRows.join("\n")}\n`);
    const manyPage = readProjectFile(root, { path: "many-lines.txt" });
    const manyNext = Number((manyPage.content.match(/start_line (\d+)/) || [])[1]);
    const manyLast = manyPage.content.split("\n").filter((l) => l.includes("|")).at(-1) ?? "";
    const manyCont = readProjectFile(root, { path: "many-lines.txt", start_line: manyNext });
    const manyFirst = manyCont.content.split("\n")[0] ?? "";
    check("read_file line truncation names start_line", Number.isInteger(manyNext) && manyNext > 1);
    check("read_file line continuation does not repeat the last shown line", manyFirst !== manyLast && manyFirst.includes(`row-${String(manyNext).padStart(4, "0")}`));
    writeFileSync(join(root, "huge-line.txt"), "H".repeat(50 * 1024));
    const hugeLine = readProjectFile(root, { path: "huge-line.txt", start_line: 1 });
    check("read_file long line continues with offset not start_line 1", hugeLine.content.includes("read_file offset ") && !hugeLine.content.includes("start_line"));
    check(
      "read_file directory lists names",
      !readProjectFile(root, { path: "pkg" }).isError &&
        readProjectFile(root, { path: "pkg" }).content.includes("[directory pkg]") &&
        readProjectFile(root, { path: "pkg" }).content.includes("src/") &&
        readProjectFile(root, { path: "pkg" }).content.includes("AGENTS.md"),
    );
    check(
      "read_file directory skips ignored segments",
      !readProjectFile(root, { path: "." }).content.includes("node_modules"),
    );
    const relWrite = writeProjectFile(root, "rel-write.txt", "ok");
    check("write_file receipt is project-relative", relWrite.content === "ok: wrote rel-write.txt");
    check("write_file receipt uses the real path", insideWrite.content === "ok: wrote inner/new.txt");
    const bashFail = await runBash("exit 7", { cwd: root });
    check("bash failure includes exit code", bashFail.isError === true && bashFail.content.includes("[exit 7]"));
    check("editMissDiagnostic counts hits", editMissDiagnostic("aa aa aa", "aa").includes("3 occurrences"));
    const manyHits = editMissDiagnostic(Array(5000).fill("x").join(" "), "x");
    check(
      "editMissDiagnostic does not dump every hit",
      manyHits.includes("5000 occurrences") && manyHits.includes("(4997 more)") && (manyHits.match(/^  \d+:/gm) || []).length === 3,
    );
    check("fileMentionAt ignores emails", fileMentionAt("hi user@host.com", 16) === null);
    check("fileMentionAt reads a tag after space", fileMentionAt("fix @src/a.ts", 13)?.query === "src/a.ts");
    check("fileMentionAt empty query at @", fileMentionAt("@", 1)?.query === "");
    check(
      "applyFileMention inserts the path",
      applyFileMention("fix @au", 7, "agent-core/auth.ts")?.text === "fix @agent-core/auth.ts ",
    );
    check(
      "applyFileMention replaces a mid-token suffix",
      applyFileMention("fix @auX.ts", 7, "auth.ts")?.text === "fix @auth.ts ",
    );
    check(
      "completeFileMention unique adds a space",
      completeFileMention("@ok", 3, ["ok.txt"])?.text === "@ok.txt ",
    );
    check(
      "completeFileMention shares a prefix",
      completeFileMention("@p", 2, ["pkg/a.ts", "pkg/b.ts"])?.text === "@pkg/",
    );
    check("rankFileTags empty query prefers cwd files", rankFileTags(["pkg/a.ts", "ok.txt"], "")[0] === "ok.txt");
    check("rankFileTags matches basename first", rankFileTags(["pkg/auth.ts", "other.txt"], "auth")[0] === "pkg/auth.ts");
    check("subsequenceSpread finds ath in auth.ts", subsequenceSpread("auth.ts", "ath") === 3);
    check("rankFileTags fuzzy basename subsequence", rankFileTags(["pkg/auth.ts", "ok.txt"], "ath")[0] === "pkg/auth.ts");
    const tuiFooter = formatTuiFooter({});
    check("formatTuiFooter fits 80 columns", tuiFooter.length <= 80 && tuiFooter.includes("@ file") && tuiFooter.includes("/ cmd"));
    check(
      "displayToolOutput names how to get the rest",
      displayToolOutput("x".repeat(3000)).includes("re-run or read_file"),
    );
    const tagged = collectRelativeFiles(root);
    check("collectRelativeFiles includes cwd files", tagged.includes("ok.txt") && tagged.includes("pkg/src/a.ts"));
    check("collectRelativeFiles skips ignored segments", !tagged.some((p) => p.includes("node_modules")));
    check("listTaggedFiles filters as you type", listTaggedFiles(root, "a.ts")[0] === "pkg/src/a.ts");
    check("parseFileTags skips emails", parseFileTags("ping me@x.com look at @ok.txt").join(" ") === "ok.txt");
    const taggedBody = expandFileTags(root, "look at @ok.txt");
    check("expandFileTags inlines tagged file bodies", taggedBody.includes("<tagged-files>") && taggedBody.includes('path="ok.txt"') && taggedBody.includes("hello"));
    writeFileSync(join(root, "xml-tag.txt"), "<file></tagged-files>\n");
    const escapedTag = expandFileTags(root, "see @xml-tag.txt");
    check(
      "expandFileTags escapes markup in tagged bodies",
      escapedTag.includes("&lt;file&gt;") && escapedTag.includes("&lt;/tagged-files&gt;") && !escapedTag.includes("<file></tagged-files>"),
    );
    
    const env1 = formatEnvironment(root, { probes: false });
    const env2 = formatEnvironment(root, { probes: false });
    check("environment two calls equal", env1 === env2);
    check("environment listing JSON and no node_modules", env1.includes("listing:") && env1.includes("\"ok.txt\"") && !env1.includes("node_modules"));
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "python3"), "#!/bin/sh\necho HACKED\n", { mode: 0o755 });
    const envProbe = formatEnvironment(root, { probes: true });
    check("project-local python3 is not executed", !envProbe.includes("HACKED"));
    
    writeFileSync(join(root, "hit.ts"), "alpha unique-token beta\n");
    const g = await grepFiles(root, { pattern: "unique-token" });
    check("grep matches", g.content.includes("unique-token") && g.content.includes("hit.ts"));
    check("grep skips node_modules", !(await grepFiles(root, { pattern: "secret" })).content.includes("hid.ts"));
    check("grep empty pattern errors", (await grepFiles(root, { pattern: "" })).content.startsWith("error:"));
    const rgDir = mkdtempSync(join(tmpdir(), "agent-core-rg-"));
    leftovers.push(rgDir);
    writeFileSync(join(rgDir, "rg"), "#!/bin/sh\necho \"from-rg.ts:1:rg-hit\"\n");
    chmodSync(join(rgDir, "rg"), 0o755);
    const prevPathForRg = process.env.PATH;
    process.env.PATH = `${rgDir}${delimiter}${prevPathForRg ?? ""}`;
    const rgHit = await grepFiles(root, { pattern: "unique-token" });
    check("grep uses trusted rg when present", rgHit.content.includes("from-rg.ts") && rgHit.content.includes("rg-hit"));
    process.env.PATH = prevPathForRg;
    const jsHit = await grepFiles(root, { pattern: "unique-token", }, { jsOnly: true });
    check("grep jsOnly fallback still matches", jsHit.content.includes("unique-token") && jsHit.content.includes("hit.ts"));
    check("grep invalid regex errors", (await grepFiles(root, { pattern: "(" })).content.startsWith("error:"));
    check("grep (a+)+ rejected", validateGrepPattern("(a+)+") !== null);
    check("grep (a|aa)+ rejected", validateGrepPattern("(a|aa)+") !== null);
    check("grep backref rejected", validateGrepPattern("a\\1") !== null);
    check("grep two quantifiers rejected", validateGrepPattern("a+b+") !== null);
    check("sidecar grep has no path", sidecarStartFor({ name: "grep", id: "1", input: { path: "src" } }).path === undefined);
    
    const globbed = (await globFiles(root, "**/*.ts")).content;
    check("glob **/*.ts nested", globbed.includes("pkg/src/a.ts"));
    check("glob **/*.ts root-level", globbed.includes("root.ts") && globbed.includes("hit.ts"));
    check("glob ignores node_modules", !globbed.includes("hid.ts"));
    check("glob brace errors", (await globFiles(root, "{a,b}")).content.startsWith("error:"));
    check("glob overlong errors", (await globFiles(root, "a".repeat(300))).content.startsWith("error:"));
    check("matchGlob repeated ** terminates", matchGlob("**/**/*.ts", "pkg/src/a.ts") === true);
    check("sidecar glob has no path", sidecarStartFor({ name: "glob", id: "1", input: {} }).path === undefined);
    
    writeFileSync(join(root, ".gitignore"), "hidden.secret\nskipdir/\n");
    writeFileSync(join(root, "hidden.secret"), "gitignore-secret\n");
    mkdirSync(join(root, "skipdir"), { recursive: true });
    writeFileSync(join(root, "skipdir", "x.ts"), "gitignore-secret\n");
    writeFileSync(join(root, "visible.secret"), "keep-secret\n");
    const giGrep = await grepFiles(root, { pattern: "gitignore-secret" });
    check("grep skips gitignored file", !giGrep.content.includes("hidden.secret"));
    check("grep skips gitignored directory", !giGrep.content.includes("skipdir"));
    check(
      "grep of an explicit gitignored path still reads it",
      (await grepFiles(root, { pattern: "gitignore-secret", path: "hidden.secret" })).content.includes("hidden.secret"),
    );
    const giGlob = (await globFiles(root, "**/*.ts")).content;
    check("glob skips gitignored directory", !giGlob.includes("skipdir/x.ts") && giGlob.includes("hit.ts"));
    const envGi = formatEnvironment(root, { probes: false });
    check("environment listing omits gitignored names", !envGi.includes("hidden.secret") && envGi.includes("visible.secret"));
    check(
      "listProjectDir skips gitignored names",
      !listProjectDir(root, root).content.includes("hidden.secret") && listProjectDir(root, root).content.includes("visible.secret"),
    );
    
    writeFileSync(join(root, "edit-me.ts"), "const a = 1;\nconst b = 2;\n");
    const edited = editProjectFile(root, "edit-me.ts", "const a = 1;", "const a = 42;");
    check("edit unique occurrence", edited.isError === false && readFileSync(join(root, "edit-me.ts"), "utf8").includes("const a = 42;"));
    check("edit missing old_text fails", editProjectFile(root, "edit-me.ts", "no-such-text", "x").isError === true);
    check(
      "edit miss names occurrence count",
      editProjectFile(root, "edit-me.ts", "no-such-text", "x").content.includes("0 occurrences"),
    );
    check("edit non-unique old_text fails", editProjectFile(root, "edit-me.ts", "const", "x").isError === true);
    const uniqueMiss = editProjectFile(root, "edit-me.ts", "const", "x");
    check(
      "edit non-unique includes nearby lines",
      uniqueMiss.content.includes("not unique") && uniqueMiss.content.includes("occurrence") && uniqueMiss.content.includes("  1:"),
    );
    check("edit empty old_text fails", editProjectFile(root, "edit-me.ts", "", "x").isError === true);
    check("edit outside cwd fails", editProjectFile(root, "/etc/passwd", "root", "x").isError === true);
    writeFileSync(join(root, "dollar.ts"), "cost $1 and done\n");
    const dollar = editProjectFile(root, "dollar.ts", "cost $1", "cost $2");
    check("edit treats $ in new_text as literal", dollar.isError === false && readFileSync(join(root, "dollar.ts"), "utf8") === "cost $2 and done\n");
    const editStart = sidecarStartFor({
      name: "edit",
      id: "e1",
      input: { path: "a.ts", old_text: "old", new_text: "new" },
    });
    check("sidecar edit maps to edit with path", editStart.toolName === "edit" && editStart.path === "a.ts");
    check(
      "sidecar edit carries oldText/newText",
      editStart.edits?.[0]?.oldText === "old" && editStart.edits?.[0]?.newText === "new",
    );
    writeFileSync(join(root, "many.ts"), "foo foo foo\n");
    const replaced = editProjectFile(root, "many.ts", "foo", "bar", true);
    check("replace_all counts three", replaced.isError === false && replaced.content.includes("3 replacements"));
    check("replace_all writes every occurrence", readFileSync(join(root, "many.ts"), "utf8") === "bar bar bar\n");
    check("replace_all omits sidecar edits", sidecarStartFor({
      name: "edit",
      id: "e2",
      input: { path: "many.ts", old_text: "foo", new_text: "bar", replace_all: true },
    }).edits === undefined);
    const noneReplace = editProjectFile(root, "many.ts", "zzz", "q", true);
    check("replace_all zero matches errors", noneReplace.isError === true);
    const stillUnique = editProjectFile(root, "many.ts", "bar", "baz");
    check("unique default still errors on duplicates", stillUnique.isError === true && stillUnique.content.includes("not unique"));
    check(
      "tool announce structures edit path",
      formatToolAnnounce({ id: "1", name: "edit", input: { path: "a.ts" } }) === "◆ Tool · edit\n  a.ts",
    );
    check(
      "tool followup structures grep hits",
      formatToolFollowup(
        { id: "1", name: "grep", input: {} },
        { result: { content: "2 hits in 2 files, showing 2\na.ts (1 hit)\n  1:x\nb.ts (1 hit)\n  2:y" }, isError: false },
      ) === "◇ grep · done · 2 hits\n",
    );
    check("dangerous permissions ask for rm", isDangerousBash("rm -rf build") && shouldAskPermission("dangerous", "rm -rf build"));
    check("dangerous permissions catch wrapped rm", isDangerousBash("bash -c 'rm -rf build'"));
    check("dangerous permissions catch git with global args", isDangerousBash("git -C repo reset --hard HEAD"));
    check("dangerous permissions catch inline programs", isDangerousBash("node -e 'require(\"fs\").rmSync(\"x\")'"));
    check("dangerous permissions skip a read", !isDangerousBash("git status") && !shouldAskPermission("dangerous", "git status"));
    check("always ask asks for a read", shouldAskPermission("ask", "git status"));
    check("always approve never asks", !shouldAskPermission("always", "rm -rf build"));
    
    check("trustedPath keeps process PATH first", trustedPath("/a/bin:/b/bin").startsWith("/a/bin"));
    check(
      "trustedPath adds user bin dirs GUI PATH omits",
      trustedPath("/usr/bin").includes("/opt/homebrew/bin") && trustedPath("/usr/bin").includes("/usr/local/bin"),
    );
    let extraUnderCwd = false;
    try {
      const realExtra = realpathSync("/usr/local/bin");
      const realRoot = realpathSync("/usr/local");
      extraUnderCwd = realExtra === realRoot || realExtra.startsWith(`${realRoot}/`);
    } catch {
      extraUnderCwd = false;
    }
    check(
      "trustedPath skips extra dirs under cwd",
      !extraUnderCwd || !trustedPath("/bin", "/usr/local").includes("/usr/local/bin"),
    );
    check("parseBangCommand reads the shell command", parseBangCommand("!ls -la")?.command === "ls -la");
    check("parseBangCommand rejects a bare bang", parseBangCommand("!")?.error === "empty command");
    check("parseBangCommand rejects whitespace", parseBangCommand("!   ")?.error === "empty command");
    check("parseBangCommand ignores prompts", parseBangCommand("hello") === null);
    const bangContext = bangCommandContext("printf hello", "hello\n[exit 0]");
    check(
      "bang command context carries command and result to the model",
      bangContext.includes("printf hello") && bangContext.includes("hello\n[exit 0]"),
    );
    const echo = await runBash("echo hello-core", { cwd: root });
    check("bash echo succeeds", echo.isError === false && echo.content.includes("hello-core") && echo.content.includes("[exit 0]"));
    const bashPath = await runBash("printf %s \"$PATH\"", { cwd: root });
    check(
      "bash PATH includes extra user bins",
      bashPath.content.includes("/opt/homebrew/bin") && bashPath.content.includes("/usr/local/bin"),
    );
    const largeBash = await runBash(`${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(30000))'`, { cwd: root });
    check(
      "bash keeps a bounded tail with continuation metadata",
      largeBash.isError === false &&
        largeBash.state === "complete" &&
        largeBash.truncated === true &&
        largeBash.stdout?.direction === "tail" &&
        largeBash.stdout?.truncated === true &&
        largeBash.continuation?.includes("Re-run the command") === true &&
        largeBash.content.includes("[exit 0]") &&
        largeBash.outputBytes <= largeBash.limitBytes,
    );
    const t0 = Date.now();
    let stopBash = false;
    const killed = runBash("sleep 8", { cwd: root, timeoutMs: 20_000, shouldStop: () => stopBash });
    setTimeout(() => {
      stopBash = true;
    }, 120);
    const killedGot = await killed;
    check("bash interrupt returns quickly", Date.now() - t0 < 3000);
    check("bash interrupt is an error", killedGot.isError === true);
    
    const hostDir = mkdtempSync(join(tmpdir(), "agent-core-host-"));
    leftovers.push(hostDir);
    const hostId = "term-1";
    const hostBridge = "core-test-bridge";
    writeFileSync(join(hostDir, `verify-${hostId}.md`), "verify-body");
    writeFileSync(join(hostDir, `edits-${hostId}.md`), "edits-body");
    const ctx = host.readContextFiles(hostDir, hostId);
    check("context concatenates verify and edits", ctx.includes("verify-body") && ctx.includes("edits-body") && ctx.includes("---"));
    check("context skips missing mailbox", !ctx.includes("mailbox"));
    writeFileSync(join(hostDir, `verify-${hostId}.md`), "x".repeat(host.HOST_CONTEXT_BYTES + 100));
    const cappedContext = host.readContextFiles(hostDir, hostId);
    check("host context has a total byte cap", Buffer.byteLength(cappedContext) === host.HOST_CONTEXT_BYTES);
    check("host context reports truncation", cappedContext.endsWith("[host context truncated]"));
    const promptName = host.promptFileName(hostId, hostBridge, "abcd1234");
    const written = host.writePromptPayload(hostDir, hostId, promptName, { prompt: "do work", context: ctx });
    check("prompt payload writes a plain filename", written === promptName && existsSync(join(hostDir, promptName)));
    const payload = JSON.parse(readFileSync(join(hostDir, promptName), "utf8"));
    check("prompt payload keeps prompt and context", payload.prompt === "do work" && payload.context.includes("verify-body"));
    const ackId = "ack-req-1";
    const ackWait = host.waitForAck(hostDir, hostId, ackId, 1000, hostBridge);
    setTimeout(() => {
      writeFileSync(join(hostDir, `ack-${hostId}-${ackId}.json`), JSON.stringify({ ok: true, token: "tok-1" }));
    }, 80);
    const ackGot = await ackWait;
    check("waitForAck claims a successful ack", ackGot?.ok === true && ackGot?.token === "tok-1");
    check("waitForAck removes the ack file", !existsSync(join(hostDir, `ack-${hostId}-${ackId}.json`)));
    const missed = await host.waitForAck(hostDir, hostId, "missing-ack", 120, hostBridge);
    check("waitForAck times out to null", missed === null);
    writeFileSync(
      join(hostDir, `startup-control-${hostId}.json`),
      JSON.stringify({ opId: "op-1", action: "structured", content: [{ type: "text", text: "do the task" }] }),
    );
    const control = host.consumeStartupControl(hostDir, hostId, hostBridge);
    check("startup-control structured is consumed", control?.action === "structured" && host.structuredStartupText(control) === "do the task");
    check("startup-control file is claimed away", !existsSync(join(hostDir, `startup-control-${hostId}.json`)));
    writeFileSync(join(hostDir, "startup-control.json"), JSON.stringify({ opId: "op-2", action: "prefill", text: "draft" }));
    const generic = host.consumeStartupControl(hostDir, hostId, hostBridge);
    check("startup-control generic prefill", generic?.action === "prefill" && generic.text === "draft");
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const imgDir = mkdtempSync(join(tmpdir(), "agent-core-img-"));
    leftovers.push(imgDir);
    const idA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const idB = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    const batch = await host.appendPendingImages(imgDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: idA },
      { bytes: png1x1, mediaType: "image/png", id: idB },
    ]);
    check("appendPendingImages commits one batch", batch.ok && batch.count === 2 && batch.names.length === 2);
    check("appendPendingImages writes pending files", batch.ok && batch.names.every((name) => existsSync(join(imgDir, name))));
    const stateAfterBatch = await host.pendingImageState(imgDir, hostId);
    check("pendingImageState sees the batch", stateAfterBatch.ok && stateAfterBatch.count === 2 && stateAfterBatch.hasImages === true);
    const claimed = await host.claimPendingImages(imgDir, hostId);
    check(
      "claimPendingImages returns bytes and leaves the live list empty",
      claimed.ok && claimed.claim.images.length === 2 && claimed.claim.images[0]?.bytes.length === png1x1.length,
    );
    const stateAfterClaim = await host.pendingImageState(imgDir, hostId);
    check("pendingImageState sees the durable claim", stateAfterClaim.ok && stateAfterClaim.count === 2);
    const sessImg = join(imgDir, "core-imgtest.jsonl");
    writeFileSync(sessImg, "");
    const stored = host.persistLoadedImages(sessImg, claimed.claim.images);
    check("persistLoadedImages writes a sidecar file", stored.ok && stored.images[0]?.name === "core-imgtest-img-1.png" && existsSync(join(imgDir, "core-imgtest-img-1.png")));
    const persistedNames = (stored.ok ? stored.images : [])
      .map((ref, i) => (ref.name !== claimed.claim.images[i]?.name && existsSync(join(imgDir, ref.name)) ? claimed.claim.images[i].name : null))
      .filter(Boolean);
    const ackOk = await host.acknowledgePendingImages(imgDir, hostId, claimed.claim.claimId, persistedNames);
    check("acknowledgePendingImages removes persisted sources", ackOk.ok === true && !existsSync(join(imgDir, claimed.claim.images[0].name)));
    const emptyAck = await host.acknowledgePendingImages(imgDir, hostId, claimed.claim.claimId, []);
    check("zero acknowledgement is a successful no-op", emptyAck.ok === true);
    const expanded = host.expandFileImageSource({ type: "file", name: stored.ok ? stored.images[0].name : "", media_type: "image/png" }, [imgDir]);
    check("expandFileImageSource reads base64", expanded?.type === "base64" && typeof expanded.data === "string" && expanded.data.length > 0);
    const missingImg = host.expandFileImageSource({ type: "file", name: "core-imgtest-img-1.png", media_type: "image/png" }, [join(imgDir, "nope")]);
    check("expandFileImageSource jails the path", missingImg === null);
    const blockedImageParent = join(imgDir, "not-a-directory");
    writeFileSync(blockedImageParent, "blocked");
    const failedImagePersist = host.persistLoadedImages(join(blockedImageParent, "session.jsonl"), claimed.claim.images.slice(0, 1));
    check("persistLoadedImages reports a session copy failure", failedImagePersist.ok === false);
    const evilDir = mkdtempSync(join(tmpdir(), "agent-core-img-evil-"));
    leftovers.push(evilDir);
    const evilName = "image-term-1-evil.png";
    try {
      symlinkSync("/etc/passwd", join(evilDir, evilName));
      writeFileSync(join(evilDir, `images-${hostId}.json`), JSON.stringify({ images: [{ name: evilName, mediaType: "image/png" }] }));
      const evilGot = await host.claimPendingImages(evilDir, hostId);
      check(
        "claimPendingImages rejects a symlink out of the events dir",
        evilGot.ok === false && evilGot.error === "image queue is invalid",
      );
    } catch (err) {
      check("claimPendingImages rejects a symlink out of the events dir", false, err instanceof Error ? err.message : String(err));
    }
    const structuredImg = host.structuredStartup({
      opId: "op-3",
      action: "structured",
      content: [
        { type: "text", text: "look at this" },
        { name: "core-imgtest-img-1.png", mediaType: "image/png" },
      ],
    });
    check(
      "structuredStartup keeps image refs",
      structuredImg.text === "look at this" && structuredImg.images[0]?.name === "core-imgtest-img-1.png",
    );
    const imgReq = projectPersistedForTest(
      [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "file", name: stored.ok ? stored.images[0].name : "", media_type: "image/png" } }], tokens: 1, sseq: 1 }],
      [imgDir],
    );
    check(
      "request projection expands a file image to base64",
      Array.isArray(imgReq[0].content) &&
        imgReq[0].content[1]?.type === "image" &&
        imgReq[0].content[1]?.source?.type === "base64",
    );
    check(
      "appendPendingImages rejects an invalid id",
      (await host.appendPendingImages(imgDir, hostId, [{ bytes: png1x1, mediaType: "image/png", id: "bad id" }])).ok === false,
    );
    check(
      "appendPendingImages rejects an unsupported media type",
      (await host.appendPendingImages(imgDir, hostId, [{ bytes: png1x1, mediaType: "image/bmp", id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee" }])).ok === false,
    );
    check(
      "appendPendingImages rejects empty bytes",
      (await host.appendPendingImages(imgDir, hostId, [{ bytes: Buffer.alloc(0), mediaType: "image/png", id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee" }])).ok === false,
    );
    const oversize = await host.appendPendingImages(imgDir, hostId, [
      { bytes: Buffer.alloc(host.MAX_IMAGE_BYTES + 1), mediaType: "image/png", id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    check("appendPendingImages rejects an oversized image", oversize.ok === false);
    check(
      "appendPendingImages rejects duplicate ids",
      (await host.appendPendingImages(imgDir, hostId, [
        { bytes: png1x1, mediaType: "image/png", id: idA },
        { bytes: png1x1, mediaType: "image/png", id: idA },
      ])).ok === false,
    );
    check("appendPendingImages rejects an empty batch", (await host.appendPendingImages(imgDir, hostId, [])).ok === false);
    
    const capDir = mkdtempSync(join(tmpdir(), "agent-core-img-cap-"));
    leftovers.push(capDir);
    for (const id of [
      "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
      "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee",
      "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee",
      "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
    ]) {
      await host.appendPendingImages(capDir, hostId, [{ bytes: png1x1, mediaType: "image/png", id }]);
    }
    const fifth = await host.appendPendingImages(capDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "99999999-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    const capState = await host.pendingImageState(capDir, hostId);
    check("appendPendingImages rejects over capacity", fifth.ok === false && fifth.error === "too many pending images" && capState.count === 4);
    
    const failDir = mkdtempSync(join(tmpdir(), "agent-core-img-fail-"));
    leftovers.push(failDir);
    const failId2 = "22222222-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkdirSync(join(failDir, `image-${hostId}-${failId2}.png`));
    const midFail = await host.appendPendingImages(failDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "11111111-bbbb-cccc-dddd-eeeeeeeeeeee" },
      { bytes: png1x1, mediaType: "image/png", id: failId2 },
    ]);
    check(
      "appendPendingImages rolls back a mid-commit rename failure",
      midFail.ok === false &&
        !existsSync(join(failDir, `images-${hostId}.json`)) &&
        !existsSync(join(failDir, `image-${hostId}-11111111-bbbb-cccc-dddd-eeeeeeeeeeee.png`)),
    );
    
    const closedDir = mkdtempSync(join(tmpdir(), "agent-core-img-closed-"));
    leftovers.push(closedDir);
    const closed = await host.appendPendingImages(
      closedDir,
      hostId,
      [{ bytes: png1x1, mediaType: "image/png", id: "33333333-bbbb-cccc-dddd-eeeeeeeeeeee" }],
      { canCommit: () => false },
    );
    check(
      "appendPendingImages honors canCommit",
      closed.ok === false &&
        closed.error === "terminal closed" &&
        !existsSync(join(closedDir, `images-${hostId}.json`)) &&
        readdirSync(closedDir).filter((name) => name.startsWith("image-")).length === 0,
    );
    
    const txDir = mkdtempSync(join(tmpdir(), "agent-core-img-tx-"));
    leftovers.push(txDir);
    const deadFinal = `image-${hostId}-deadfinal.png`;
    writeFileSync(join(txDir, deadFinal), png1x1);
    writeFileSync(
      join(txDir, `images-tx-${hostId}-${process.pid}-${Date.now()}-deadtx1.json`),
      JSON.stringify({
        terminalId: hostId,
        pid: process.pid,
        createdAt: Date.now(),
        nonce: "deadtx1",
        staged: [],
        final: [deadFinal],
      }),
    );
    const recovered = await host.appendPendingImages(txDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "44444444-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    check(
      "lock recovery removes unreferenced finals from a crashed producer",
      recovered.ok === true && !existsSync(join(txDir, deadFinal)) && !readdirSync(txDir).some((name) => name.startsWith("images-tx-")),
    );
    
    const keepDir = mkdtempSync(join(tmpdir(), "agent-core-img-keep-"));
    leftovers.push(keepDir);
    const keepFinal = `image-${hostId}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`;
    writeFileSync(join(keepDir, keepFinal), png1x1);
    writeFileSync(join(keepDir, `images-${hostId}.json`), JSON.stringify({ images: [{ name: keepFinal, mediaType: "image/png" }] }));
    writeFileSync(
      join(keepDir, `images-tx-${hostId}-${process.pid}-${Date.now()}-keeptx.json`),
      JSON.stringify({
        terminalId: hostId,
        pid: process.pid,
        createdAt: Date.now(),
        nonce: "keeptx",
        staged: [],
        final: [keepFinal],
      }),
    );
    const kept = await host.pendingImageState(keepDir, hostId);
    check(
      "lock recovery preserves referenced finals even when the recorded pid is live",
      kept.ok && kept.count === 1 && existsSync(join(keepDir, keepFinal)) && !readdirSync(keepDir).some((name) => name.startsWith("images-tx-")),
    );
    
    const stuckDir = mkdtempSync(join(tmpdir(), "agent-core-img-stuck-"));
    leftovers.push(stuckDir);
    const stuckName = `image-${hostId}-stuckfinal.png`;
    mkdirSync(join(stuckDir, stuckName));
    writeFileSync(join(stuckDir, join(stuckName, "keep")), "x");
    const stuckTx = `images-tx-${hostId}-${process.pid}-${Date.now()}-stucktx.json`;
    writeFileSync(
      join(stuckDir, stuckTx),
      JSON.stringify({
        terminalId: hostId,
        pid: process.pid,
        createdAt: Date.now(),
        nonce: "stucktx",
        staged: [],
        final: [stuckName],
      }),
    );
    const stuck = await host.pendingImageState(stuckDir, hostId);
    check(
      "lock recovery retains a transaction when artifact removal fails",
      stuck.ok === false && existsSync(join(stuckDir, stuckTx)),
    );
    
    let holdRelease;
    const holdGate = new Promise((resolve) => {
      holdRelease = resolve;
    });
    let holdStarted;
    const holdReady = new Promise((resolve) => {
      holdStarted = resolve;
    });
    const busyDir = mkdtempSync(join(tmpdir(), "agent-core-img-busy-"));
    leftovers.push(busyDir);
    const holder = host.withPendingImageLock(busyDir, hostId, async () => {
      holdStarted();
      await holdGate;
    });
    await holdReady;
    const busy = await host.appendPendingImages(busyDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "55555555-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    holdRelease();
    await holder;
    check("appendPendingImages times out on a live lock", busy.ok === false && busy.error === "image queue busy");
    
    const malformedDir = mkdtempSync(join(tmpdir(), "agent-core-img-bad-"));
    leftovers.push(malformedDir);
    writeFileSync(join(malformedDir, `images-${hostId}.lock`), "not-json");
    const badLock = await host.appendPendingImages(malformedDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "66666666-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    check("malformed lock fails closed", badLock.ok === false && badLock.error === "image queue is invalid");
    
    const hugeLockDir = mkdtempSync(join(tmpdir(), "agent-core-img-huge-"));
    leftovers.push(hugeLockDir);
    writeFileSync(join(hugeLockDir, `images-${hostId}.lock`), "x".repeat(16 * 1024 + 8));
    const hugeLock = await host.appendPendingImages(hugeLockDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "77777777-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    check("oversized lock fails closed", hugeLock.ok === false && hugeLock.error === "image queue is invalid");
    
    const qDir = mkdtempSync(join(tmpdir(), "agent-core-img-q-"));
    leftovers.push(qDir);
    writeFileSync(join(qDir, `images-${hostId}.json`), "{not json");
    const q = await host.appendPendingImages(qDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "88888888-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    check(
      "malformed manifest is quarantined",
      q.ok === false && q.error === "image queue is invalid" && readdirSync(qDir).some((name) => name.includes(".quarantine-")),
    );
    
    const raceDir = mkdtempSync(join(tmpdir(), "agent-core-img-race-"));
    leftovers.push(raceDir);
    let releaseCommit;
    const commitGate = new Promise((resolve) => {
      releaseCommit = resolve;
    });
    let atCommit;
    const commitReady = new Promise((resolve) => {
      atCommit = resolve;
    });
    const prodP = host.appendPendingImages(
      raceDir,
      hostId,
      [
        { bytes: png1x1, mediaType: "image/png", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
        { bytes: png1x1, mediaType: "image/png", id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" },
      ],
      {
        canCommit: () => {
          atCommit();
          return commitGate.then(() => true);
        },
      },
    );
    await commitReady;
    const claimWhileHeld = host.claimPendingImages(raceDir, hostId);
    releaseCommit();
    const prodR = await prodP;
    const claimLate = await claimWhileHeld;
    const afterRace = claimLate.ok && claimLate.claim.images.length === 2
      ? claimLate
      : await host.claimPendingImages(raceDir, hostId);
    check(
      "producer-first race publishes a complete batch",
      prodR.ok === true && afterRace.ok && afterRace.claim.images.length === 2,
    );
    
    const firstClaimDir = mkdtempSync(join(tmpdir(), "agent-core-img-first-"));
    leftovers.push(firstClaimDir);
    const consumerFirst = await host.claimPendingImages(firstClaimDir, hostId);
    const afterEmpty = await host.appendPendingImages(firstClaimDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    const laterClaim = await host.claimPendingImages(firstClaimDir, hostId);
    check(
      "consumer-first leaves a later producer generation intact",
      consumerFirst.ok && consumerFirst.claim.images.length === 0 && afterEmpty.ok && laterClaim.ok && laterClaim.claim.images.length === 1,
    );
    
    const reuseDir = mkdtempSync(join(tmpdir(), "agent-core-img-reuse-"));
    leftovers.push(reuseDir);
    await host.appendPendingImages(reuseDir, hostId, [{ bytes: png1x1, mediaType: "image/png", id: idA }]);
    const firstReuse = await host.claimPendingImages(reuseDir, hostId);
    const secondReuse = await host.claimPendingImages(reuseDir, hostId);
    check(
      "current-process claim is reused",
      firstReuse.ok && secondReuse.ok && firstReuse.claim.claimId === secondReuse.claim.claimId && secondReuse.claim.images.length === 1,
    );
    const partialAck = await host.acknowledgePendingImages(reuseDir, hostId, firstReuse.claim.claimId, [firstReuse.claim.images[0].name]);
    const afterPartial = await host.claimPendingImages(reuseDir, hostId);
    check("full acknowledgement removes the claim", partialAck.ok && afterPartial.ok && afterPartial.claim.images.length === 0);
    
    const numericUuidClaimDir = mkdtempSync(join(tmpdir(), "agent-core-img-numeric-uuid-"));
    leftovers.push(numericUuidClaimDir);
    const numericUuidImage = `image-${hostId}-${idA}.png`;
    const numericUuidClaim = `images-claim-${hostId}-${process.pid}-${Date.now()}-12345678-1234-4234-8234-123456789012.json`;
    writeFileSync(join(numericUuidClaimDir, numericUuidImage), png1x1);
    writeFileSync(
      join(numericUuidClaimDir, numericUuidClaim),
      JSON.stringify({ images: [{ name: numericUuidImage, mediaType: "image/png" }] }),
    );
    const parsedNumericUuidClaim = await host.claimPendingImages(numericUuidClaimDir, hostId);
    check(
      "claim parsing preserves numeric UUID segments",
      parsedNumericUuidClaim.ok &&
        parsedNumericUuidClaim.claim.claimId === numericUuidClaim &&
        parsedNumericUuidClaim.claim.images[0]?.bytes.equals(png1x1),
    );
    
    const persistFailDir = mkdtempSync(join(tmpdir(), "agent-core-img-persist-"));
    leftovers.push(persistFailDir);
    await host.appendPendingImages(persistFailDir, hostId, [{ bytes: png1x1, mediaType: "image/png", id: idA }]);
    const persistClaim = await host.claimPendingImages(persistFailDir, hostId);
    const zeroPersisted = await host.acknowledgePendingImages(persistFailDir, hostId, persistClaim.claim.claimId, []);
    const recoveredClaim = await host.claimPendingImages(persistFailDir, hostId);
    check(
      "failed persistence leaves the durable claim",
      persistClaim.ok &&
        zeroPersisted.ok &&
        recoveredClaim.ok &&
        recoveredClaim.claim.claimId === persistClaim.claim.claimId &&
        recoveredClaim.claim.images[0]?.bytes.equals(png1x1),
    );
    const capClaimDir = mkdtempSync(join(tmpdir(), "agent-core-img-capclaim-"));
    leftovers.push(capClaimDir);
    for (const id of [
      "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
      "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee",
      "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee",
      "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
    ]) {
      await host.appendPendingImages(capClaimDir, hostId, [{ bytes: png1x1, mediaType: "image/png", id }]);
    }
    const heldClaim = await host.claimPendingImages(capClaimDir, hostId);
    const overflowWhileClaimed = await host.appendPendingImages(capClaimDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "99999999-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    const claimedCapState = await host.pendingImageState(capClaimDir, hostId);
    check(
      "appendPendingImages counts durable claims toward capacity",
      heldClaim.ok &&
        heldClaim.claim.images.length === 4 &&
        overflowWhileClaimed.ok === false &&
        overflowWhileClaimed.error === "too many pending images" &&
        claimedCapState.ok &&
        claimedCapState.count === 4,
      JSON.stringify({ heldClaim: heldClaim.ok && heldClaim.claim.images.length, overflowWhileClaimed, claimedCapState }),
    );
    
    const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await once(deadChild, "exit");
    const deadPid = deadChild.pid;
    const adoptDir = mkdtempSync(join(tmpdir(), "agent-core-img-adopt-"));
    leftovers.push(adoptDir);
    const adoptName = `image-${hostId}-${idA}.png`;
    writeFileSync(join(adoptDir, adoptName), png1x1);
    const deadClaim = `images-claim-${hostId}-${deadPid}-${Date.now()}-deadclaim.json`;
    writeFileSync(join(adoptDir, deadClaim), JSON.stringify({ images: [{ name: adoptName, mediaType: "image/png" }] }));
    const adopted = await host.claimPendingImages(adoptDir, hostId);
    check("next consumer adopts a dead-owner claim", adopted.ok && adopted.claim.claimId === deadClaim && adopted.claim.images.length === 1);
    
    const liveClaimDir = mkdtempSync(join(tmpdir(), "agent-core-img-livec-"));
    leftovers.push(liveClaimDir);
    const foreignPid = process.pid;
    const liveClaimName = `images-claim-${hostId}-${foreignPid === 1 ? 2 : 1}-${Date.now()}-liveclaim.json`;
    const liveImg = `image-${hostId}-${idA}.png`;
    writeFileSync(join(liveClaimDir, liveImg), png1x1);
    writeFileSync(join(liveClaimDir, liveClaimName), JSON.stringify({ images: [{ name: liveImg, mediaType: "image/png" }] }));
    writeFileSync(join(liveClaimDir, `images-${hostId}.json`), JSON.stringify({ images: [{ name: liveImg, mediaType: "image/png" }] }));
    let skippedForeign = true;
    try {
      process.kill(1, 0);
    } catch (err) {
      skippedForeign = err && err.code === "EPERM";
    }
    if (liveClaimName.includes(`-${process.pid}-`)) skippedForeign = false;
    const skipClaim = await host.claimPendingImages(liveClaimDir, hostId);
    check(
      "a live foreign claim is skipped while a live manifest can still be claimed",
      skipClaim.ok &&
        skipClaim.claim.claimId !== liveClaimName &&
        skipClaim.claim.images.length === 1 &&
        existsSync(join(liveClaimDir, liveClaimName)),
    );
    
    let epermChecked = false;
    try {
      process.kill(1, 0);
    } catch (err) {
      if (err && err.code === "EPERM") {
        const epermDir = mkdtempSync(join(tmpdir(), "agent-core-img-eperm-"));
        leftovers.push(epermDir);
        writeFileSync(
          join(epermDir, `images-${hostId}.lock`),
          JSON.stringify({ pid: 1, createdAt: Date.now() - 10_000, nonce: "epermnonce" }),
        );
        const epermGot = await host.appendPendingImages(epermDir, hostId, [
          { bytes: png1x1, mediaType: "image/png", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
        ]);
        check("EPERM owner checks do not steal the lock", epermGot.ok === false && epermGot.error === "image queue busy");
        epermChecked = true;
      }
    }
    if (!epermChecked) check("EPERM owner checks do not steal the lock", true, "skipped: pid 1 is signalable");
    
    const staleChild = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await once(staleChild, "exit");
    const staleDir = mkdtempSync(join(tmpdir(), "agent-core-img-stale-"));
    leftovers.push(staleDir);
    writeFileSync(
      join(staleDir, `images-${hostId}.lock`),
      JSON.stringify({ pid: staleChild.pid, createdAt: Date.now() - 10_000, nonce: "stalenonce" }),
    );
    const stole = await host.appendPendingImages(staleDir, hostId, [
      { bytes: png1x1, mediaType: "image/png", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    check("a dead stale lock is stolen", stole.ok === true);
    
    const fakeTerm = { id: hostId };
    const captured = fakeTerm;
    const termDir = mkdtempSync(join(tmpdir(), "agent-core-img-term-"));
    leftovers.push(termDir);
    const closedByIdentity = await host.appendPendingImages(
      termDir,
      hostId,
      [{ bytes: png1x1, mediaType: "image/png", id: idA }],
      { canCommit: () => captured === fakeTerm && false },
    );
    check("commit guard sees a replaced terminal identity", closedByIdentity.ok === false && closedByIdentity.error === "terminal closed");
    check(
      "firstPlanText accepts a checkbox list",
      host.firstPlanText("intro\n- [ ] edit src/foo.ts\n")?.includes("- [ ] edit src/foo.ts"),
    );
    check("firstPlanText ignores prose", host.firstPlanText("hello there") === null);
    const planA = "- [ ] one.ts\n";
    check("planTextIfChanged emits first list", host.planTextIfChanged(planA, "") === planA);
    check("planTextIfChanged silent on identical", host.planTextIfChanged(planA, planA) === null);
    check("planTextIfChanged emits a changed list", host.planTextIfChanged("- [ ] two.ts\n", planA)?.includes("two.ts"));
    check(
      "visibleAssistantText skips thinking",
      host.visibleAssistantText([
        { type: "thinking", text: "secret" },
        { type: "text", text: "- [ ] task" },
      ]) === "- [ ] task" && host.firstPlanText(host.visibleAssistantText([{ type: "thinking", text: "- [ ] nope" }])) === null,
    );
    
    check("web_search is Anthropic server tool", WEB_SEARCH_TOOL.type === "web_search_20260209" && WEB_SEARCH_TOOL.name === "web_search");
    const clientPrefix = buildCachedPrefix("sys", [
      { name: "a", description: "a", input_schema: { type: "object" } },
      { name: "b", description: "b", input_schema: { type: "object" } },
    ]);
    const reqTools = requestTools(clientPrefix.tools);
    check("requestTools keeps cache on last client tool", reqTools[1]?.cache_control?.type === "ephemeral");
    check(
      "requestTools skips web_search for completions providers",
      requestTools(clientPrefix.tools, "xai").every((t) => t.name !== "web_search") &&
        requestTools(clientPrefix.tools, "xai").length === clientPrefix.tools.length,
    );
    check(
      "requestTools skips web_search on OpenCode Zen Claude",
      requestTools(clientPrefix.tools, "opencode-zen", "claude-sonnet-5").every((t) => t.name !== "web_search"),
    );
    check(
      "requestTools appends web_search without cache_control",
      reqTools[2]?.type === "web_search_20250305" && reqTools[2]?.cache_control === undefined,
    );
    check(
      "requestTools sonnet 5 uses dynamic web search",
      requestTools(clientPrefix.tools, "anthropic", "claude-sonnet-5")[2]?.type === "web_search_20260209",
    );
    check("sidecar web_search has no path", sidecarStartFor({ name: "web_search", id: "1", input: { path: "src" } }).path === undefined);
    check("sidecar fetch has no path", sidecarStartFor({ name: "fetch", id: "1", input: { url: "https://example.com" } }).path === undefined);
    check("fetchUrlError rejects file", Boolean(fetchUrlError("file:///etc/passwd")?.includes("not allowed")));
    check("fetchUrlError rejects data", Boolean(fetchUrlError("data:text/plain,hi")?.includes("not allowed")));
    check("fetchUrlError allows https", fetchUrlError("https://example.com/x") === null);
    const fetchSrv = createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("z".repeat(30_000));
        return;
      }
      if (req.url === "/go") {
        res.writeHead(302, { location: "/ok" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fetched-body");
    });
    await new Promise((resolve) => fetchSrv.listen(0, "127.0.0.1", resolve));
    const fetchPort = fetchSrv.address().port;
    const fetched = await fetchUrl(`http://127.0.0.1:${fetchPort}/ok`);
    check("fetch loopback in tests", fetched.isError === false && fetched.content === "fetched-body");
    const bounced = await fetchUrl(`http://127.0.0.1:${fetchPort}/go`);
    check("fetch follows a redirect", bounced.isError === false && bounced.content === "fetched-body");
    const bigFetch = await fetchUrl(`http://127.0.0.1:${fetchPort}/big`);
    check(
      "fetch caps bytes with continuation metadata",
      bigFetch.isError === false &&
        bigFetch.state === "complete" &&
        bigFetch.truncated === true &&
        bigFetch.continuation?.includes("Re-run fetch") === true &&
        bigFetch.outputBytes <= bigFetch.limitBytes &&
        bigFetch.inputBytes > bigFetch.retainedBytes,
    );
    const stopped = await fetchUrl(`http://127.0.0.1:${fetchPort}/ok`, { shouldStop: () => true });
    check("fetch interrupt is an error", stopped.isError === true);
    fetchSrv.close();
    const slots = [];
    placeStreamBlock(slots, 1, { type: "text", text: "kept" });
    check("stream compact skips holes", compactStreamBlocks(slots).length === 1 && compactStreamBlocks(slots)[0].text === "kept");
    check(
      "request projection strips view keys only",
      JSON.stringify(projectBlockForTest({ type: "text", text: "hi", stubbed: true, chars: 2 })).includes("hi") &&
        !JSON.stringify(projectBlockForTest({ type: "text", text: "hi", stubbed: true })).includes("stubbed"),
    );
    check(
      "request projection keeps signed thinking",
      projectBlockForTest({ type: "thinking", thinking: "abc", signature: "sig" }).thinking === "abc",
    );
    check(
      "hidden context becomes provider text",
      JSON.stringify(projectBlockForTest({ type: "context", text: "<working-set>x</working-set>" })) ===
        JSON.stringify({ type: "text", text: "<working-set>x</working-set>" }),
    );
    const hiddenWorkingSet = projectBlockForTest({ type: "context", text: "<working-set>hidden</working-set>" });
    check(
      "legacy working set projects as provider text",
      hiddenWorkingSet?.type === "text" && hiddenWorkingSet?.text === "<working-set>hidden</working-set>",
    );
    check("plain user prompt stays a string", userPromptContent("visible", []) === "visible");
    const unsignedThinking = projectPersistedForTest([{ role: "assistant", content: [{ type: "thinking", thinking: "abc" }], tokens: 1, sseq: 1 }]);
    check("request projection drops unsigned thinking", unsignedThinking[0]?.content?.length === 0);
    const searchReq = projectPersistedForTest([
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "s1",
            content: [{ type: "web_search_result", url: "https://ex.test", title: "t", encrypted_content: "secret" }],
          },
          { type: "text", text: "hi", citations: [{ type: "web_search_result_location", url: "https://ex.test" }] },
        ],
        tokens: 1,
        sseq: 1,
      },
    ]);
    const searchJson = JSON.stringify(searchReq);
    check("request projection keeps server_tool_use", searchJson.includes("server_tool_use") && searchJson.includes("\"query\":\"x\""));
    check("request projection keeps encrypted search content", searchJson.includes("encrypted_content"));
    check("request projection keeps text citations", searchJson.includes("citations") && searchJson.includes("web_search_result_location"));
    check(
      "reproFor web_search quotes query",
      (reproFor({ id: "1", name: "web_search", input: { query: "foo 'bar'" } }) ?? "").includes("'\\''"),
    );
    
    mkdirSync(join(root, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: from project\n---\n");
    const userSkills = mkdtempSync(join(tmpdir(), "agent-core-user-skills-"));
    leftovers.push(userSkills);
    mkdirSync(join(userSkills, "demo"), { recursive: true });
    writeFileSync(join(userSkills, "demo", "SKILL.md"), "---\nname: demo\ndescription: from user\n---\n");
    mkdirSync(join(root, ".agents", "skills", "amp"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "amp", "SKILL.md"), "---\nname: a&b\ndescription: x<y\n---\n");
    const scanned = scanSkills([userSkills, join(root, ".agents", "skills")]);
    const demo = scanned.skills.find((s) => s.name === "demo");
    check("later project skill overrides user-global", demo?.description === "from project");
    const xml = formatSkillIndex(scanned.skills);
    check("XML-special name escaped", xml.includes("a&amp;b") && xml.includes("x&lt;y"));
    check("missing skill dirs silent", scanSkills([join(root, "no-such-skills")]).skills.length === 0);
    
    const outside = mkdtempSync(join(tmpdir(), "agent-core-out-"));
    leftovers.push(outside);
    writeFileSync(join(outside, "AGENTS.md"), "escape\n");
    try {
      rmSync(join(root, "escape-agents"));
    } catch {
      /* none */
    }
    symlinkSync(join(outside, "AGENTS.md"), join(root, "escape-agents.md"));
    // project-scoped nested pointer uses realpath; a cwd file that is a symlink to outside AGENTS.md
    symlinkSync(join(outside, "AGENTS.md"), join(root, "pkg", "escaped.md"));
    check("nested pointer skip at cwd file", nestedAgentsPointer(root, join(root, "ok.txt")) === null);
    
    check("project AGENTS.md under cap has no overflow", !formatProjectInstructions("# hi\n").includes("truncated"));
    const longMd = `${"para\n\n".repeat(5)}${"x".repeat(30_000)}`;
    const longAgents = formatProjectInstructions(longMd);
    check("project AGENTS.md over cap overflow note", longAgents.includes("truncated") && longAgents.includes("read AGENTS.md with read_file"));
    check("project over cap does not claim omitted tail", !longAgents.includes("x".repeat(1000)));
    check("user-global over cap names absolute path", formatUserInstructions("y".repeat(10_000), "/abs/AGENTS.md").includes("/abs/AGENTS.md"));
    check("user-global under cap no overflow", !formatUserInstructions("short", "/abs/AGENTS.md").includes("truncated"));
    
    check("nested pointer on pkg file", (nestedAgentsPointer(root, join(root, "pkg", "src", "a.ts")) ?? "").includes("pkg/AGENTS.md"));
    check("nested pointer skip on AGENTS.md itself", nestedAgentsPointer(root, join(root, "pkg", "AGENTS.md")) === null);
    check("read_file prepends nested pointer", readProjectFile(root, { path: "pkg/src/a.ts" }).content.startsWith("[package instructions:"));
    check(
      "read nested AGENTS.md has no pointer",
      !readProjectFile(root, { path: "pkg/AGENTS.md" }).content.startsWith("[package instructions:"),
    );
    
    const stub = formatStub({ chars: 12, tool: "grep", sseq: 7, repro: "grep 'x'" });
    check("formatStub includes storageSeq and repro", stub.includes("storageSeq 7") && stub.includes("reproduce: grep 'x'"));
    const req = projectPersistedForTest([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "1", name: "grep", input: { pattern: "x" } }],
        tokens: 1,
        sseq: 1,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "1", content: "hi", stubbed: true, repro: "x", chars: 3 }],
        tokens: 1,
        sseq: 2,
      },
    ]);
    const reqJson = JSON.stringify(req);
    check("request projection strips stubbed/repro/chars", reqJson.includes('"content":"hi"') && !reqJson.includes("stubbed"));
    check("reproFor grep includes pattern", (reproFor({ id: "1", name: "grep", input: { pattern: "abc" } }) ?? "").includes("abc"));
    check(
      "reproFor quotes apostrophe",
      (reproFor({ id: "1", name: "bash", input: { command: "echo 'hi'" } }) ?? "").includes("'\\''"),
    );
    check(
      "reproFor newline becomes space",
      !(reproFor({ id: "1", name: "bash", input: { command: "echo\nhi" } }) ?? "").includes("\n"),
    );
    
    check(
      "planPruneStubs no-ops under high-water",
      planPruneStubs([{ role: "user", content: "hi", tokens: 10, sseq: 1 }], { systemTokens: 10, usable: 100_000, protectTokens: 4_000 })
        .length === 0,
    );
    const prunePlan = planPruneStubs(
      [
        {
          role: "user",
          content: [
            { type: "tool_result", content: "a".repeat(8_000) },
            { type: "tool_result", content: "b".repeat(8_000) },
          ],
          tokens: 9_000,
          sseq: 1,
        },
        { role: "user", content: "recent one", tokens: 10, sseq: 2 },
        { role: "user", content: "recent two", tokens: 10, sseq: 3 },
      ],
      { systemTokens: 0, usable: 10_000, protectTokens: 10 },
    );
    check("planPruneStubs addresses exact blocks", prunePlan.map((p) => p.blockIndex).join(",") === "0,1");
    check("planPruneStubs stubs tool_results", prunePlan.every((p) => p.action === "stub"));
    const thinkPlan = planPruneStubs(
      [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t".repeat(4_000) },
            { type: "text", text: "hi" },
          ],
          tokens: 9_000,
          sseq: 1,
        },
        { role: "user", content: "recent one", tokens: 10, sseq: 2 },
        { role: "user", content: "recent two", tokens: 10, sseq: 3 },
      ],
      { systemTokens: 0, usable: 10_000, protectTokens: 10 },
    );
    check("planPruneStubs drops old thinking", thinkPlan.length === 1 && thinkPlan[0]?.action === "drop" && thinkPlan[0]?.blockIndex === 0);
    check(
      "planPruneStubs billed high with small history is a no-op",
      planPruneStubs(
        [
          { role: "user", content: [{ type: "tool_result", content: "a".repeat(8_000) }], tokens: 100, sseq: 1 },
          { role: "user", content: "a", tokens: 10, sseq: 2 },
          { role: "user", content: "b", tokens: 10, sseq: 3 },
        ],
        { systemTokens: 0, usable: 10_000, protectTokens: 10, fillTokens: 9_000 },
      ).length === 0,
    );
    const thinkRevision = makePruneRevision("think-rev", [{
      sseq: 1,
      blockIndex: 0,
      action: "drop",
      original: {
        type: "thinking",
        chars: "secret".length,
        bytes: sessionBlockBytes({ type: "thinking", thinking: "secret" }),
        sha256: sessionBlockHash({ type: "thinking", thinking: "secret" }),
      },
      reclaimedTokens: estimateReclaimTokens("secret"),
      fallback: { source: "session-record", tool: "thinking", repro: null },
    }]);
    const thinkReplay = [
      JSON.stringify({
        storageSeq: 1,
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret" },
            { type: "text", text: "ok" },
          ],
        },
      }),
      JSON.stringify({ storageSeq: 2, ...thinkRevision }),
    ].join("\n");
    const droppedThink = replaySessionRecords(thinkReplay);
    check(
      "prune replay drops thinking and matches live",
      droppedThink.ok &&
        droppedThink.messages[0]?.content?.length === 1 &&
        droppedThink.messages[0]?.content[0]?.type === "text" &&
        droppedThink.messages[0]?.content[0]?.text === "ok",
    );
    
    const tools = [
      { name: "a", description: "a", input_schema: { type: "object", properties: {} } },
      { name: "b", description: "b", input_schema: { type: "object", properties: {} } },
    ];
    const prefix1 = buildCachedPrefix("sys", tools);
    const prefix2 = buildCachedPrefix("sys", tools);
    check("buildCachedPrefix deep-equal", JSON.stringify(prefix1) === JSON.stringify(prefix2));
    check("buildCachedPrefix omits automatic top-level cache", prefix1.cache_control === undefined);
    check("buildCachedPrefix system marker", prefix1.system[0]?.cache_control?.type === "ephemeral");
    check("buildCachedPrefix last tool copy", prefix1.tools[1]?.cache_control?.type === "ephemeral");
    check("buildCachedPrefix anthropic uses 1h ttl", buildCachedPrefix("sys", tools, "anthropic").system[0]?.cache_control?.ttl === "1h");
    check("buildCachedPrefix zen omits ttl", buildCachedPrefix("sys", tools, "opencode-zen").system[0]?.cache_control?.ttl === undefined);
    check("buildCachedPrefix does not mutate tools", tools[1].cache_control === undefined);
    
    check("sidecar write maps to write", sidecarStartFor({ name: "write_file", id: "9", input: { path: "a.ts" } }).toolName === "write");
    check("sidecar read_file has no path", sidecarStartFor({ name: "read_file", id: "9", input: { path: "a.ts" } }).path === undefined);
    
    const utf = "é".repeat(40);
    const capped = boundText(utf, {
      maxBytes: 64,
      direction: "tail",
      marker: "[output omitted — reproduce: bash 'x']",
    });
    check(
      "bounded text keeps a UTF-8 tail with repro marker",
      capped.truncated &&
        capped.text.includes("reproduce:") &&
        capped.text.includes("é") &&
        capped.outputBytes <= capped.limitBytes &&
        !capped.text.includes("\uFFFD"),
    );
    
    const handoff = "<context-handoff>\nkeep\n</context-handoff>";
    const sessionLines = [
      JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "old1" } }),
      JSON.stringify({
        storageSeq: 2,
        type: "message",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "BIG".repeat(100), tool: "bash", repro: "bash x" }] },
      }),
      JSON.stringify({ storageSeq: 3, type: "message", message: { role: "user", content: "tail" } }),
      JSON.stringify({ storageSeq: 4, type: "revision", kind: "summarize", evicted: 2, summarySseq: 4, message: { role: "user", content: handoff } }),
    ].join("\n");
    const replayed = replaySessionRecords(sessionLines);
    check("summarize replay handoff first", replayed.ok && replayed.messages[0]?.content === handoff);
    check("summarize replay keeps tail", replayed.ok && replayed.messages[1]?.content === "tail");
    
    const bodyBlock = { type: "tool_result", tool_use_id: "t", content: "BODY", tool: "bash", repro: "bash x" };
    const bodyRevision = makePruneRevision("body-rev", [{
      sseq: 2,
      blockIndex: 0,
      action: "stub",
      original: {
        type: "tool_result",
        chars: "BODY".length,
        bytes: sessionBlockBytes(bodyBlock),
        sha256: sessionBlockHash(bodyBlock),
      },
      reclaimedTokens: estimateReclaimTokens("BODY"),
      tool: "bash",
      repro: "bash x",
      fallback: { source: "session-record", tool: "bash", repro: "bash x" },
    }]);
    const pruneLines = [
      JSON.stringify({
        storageSeq: 1,
        type: "message",
        message: { role: "user", content: [{ type: "tool_use", id: "t", name: "bash", input: { command: "x" } }] },
      }),
      JSON.stringify({
        storageSeq: 2,
        type: "message",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "BODY", tool: "bash", repro: "bash x" }] },
      }),
      JSON.stringify({ storageSeq: 3, ...bodyRevision }),
    ].join("\n");
    const pruned = replaySessionRecords(pruneLines);
    check(
      "prune replay uses formatStub",
      pruned.ok && String(pruned.messages.find((message) => message.sseq === 2)?.content?.[0]?.content ?? "").includes("storageSeq 2"),
    );
    
    const truncLines = [
      JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "drop" } }),
      JSON.stringify({ storageSeq: 2, type: "message", message: { role: "user", content: "keep" } }),
      JSON.stringify({ storageSeq: 3, type: "revision", kind: "truncate", dropped: 1 }),
    ].join("\n");
    const truncated = replaySessionRecords(truncLines);
    check("truncate replay preserves boundary", truncated.ok && truncated.messages.length === 1 && truncated.messages[0]?.content === "keep");
    
    const sessBundle = join(root, "term-1", "current", "session.jsonl");
    mkdirSync(join(root, "term-1", "current"), { recursive: true, mode: 0o700 });
    writeFileSync(sessBundle, sessionLines, { mode: 0o600 });
    const freshPrep = prepareFreshSession(sessBundle);
    check("fresh session archives non-empty current", freshPrep.ok && typeof freshPrep.archived === "string" && existsSync(freshPrep.archived));
    check("fresh session starts an empty active segment", readFileSync(sessBundle, "utf8") === "");
    
    check("duplicate storageSeq fails resume", replaySessionRecords(`${sessionLines}\n${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "x" } })}`).ok === false);
    check("non-positive storageSeq fails", replaySessionRecords(JSON.stringify({ storageSeq: 0, type: "message", message: { role: "user", content: "x" } })).ok === false);
    check("invalid message content fails resume", replaySessionRecords(JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: {} } })).ok === false);
    check("invalid truncate revision fails resume", replaySessionRecords(`${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "x" } })}\n${JSON.stringify({ storageSeq: 2, type: "revision", kind: "truncate", dropped: 2 })}`).ok === false);
    check("truncated final line ignored", replaySessionRecords(`${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "ok" } })}\n{not-json`).ok === true);
    
    check("invalid terminal id rejected", isValidTerminalId("../evil") === false);
    check("tracesDirFor invalid id is null", tracesDirFor(root, "../evil") === null);
    const traceRetentionRuntime = createTraceRuntime({
      directory: join(root, "trace-retention"),
      namespace: "agent-core-harness-retention",
      retentionCap: 1,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const traceStartup = await traceRetentionRuntime.ready;
    const makeTraceAttempt = (attemptId, sequence) => createAttemptRecord({
      runId: "run-harness-retention",
      taskId: "task-harness-retention",
      attemptId,
      role: "main",
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-5.6",
      status: "ok",
      storageSeqRange: [sequence, sequence],
      toolNames: [],
      usage: null,
      cost: null,
      cache: null,
      revisions: { count: 0, kinds: [] },
    });
    const firstTraceWrite = await traceRetentionRuntime.writeAttempt(makeTraceAttempt("attempt-1", 1));
    const secondTraceWrite = await traceRetentionRuntime.writeAttempt(makeTraceAttempt("attempt-2", 2));
    const traceKept = readdirSync(join(root, "trace-retention"));
    check(
      "trace retention uses canonical runtime",
      traceStartup.ok && firstTraceWrite.ok && secondTraceWrite.ok && traceKept.includes("turn-2.json") && !traceKept.includes("turn-1.json"),
    );
    await traceRetentionRuntime.close();
    
    mkdirSync(join(root, "cycle", "a"), { recursive: true });
    try {
      symlinkSync(join(root, "cycle"), join(root, "cycle", "a", "loop"));
    } catch {
      /* windows */
    }
    const cyc = await globFiles(join(root, "cycle"), "**/*");
    check("in-root symlink cycle terminates", typeof cyc.content === "string");
    
    const outSkill = join(outside, "SKILL.md");
    writeFileSync(outSkill, "---\nname: out\ndescription: no\n---\n");
    mkdirSync(join(root, ".agents", "skills", "link"), { recursive: true });
    try {
      symlinkSync(outSkill, join(root, ".agents", "skills", "link", "SKILL.md"));
    } catch {
      /* ignore */
    }
    const scannedLink = scanSkills([join(root, ".agents", "skills")]);
    check("skill file symlink outside scan root omitted", !scannedLink.skills.some((s) => s.name === "out"));
    
    check("import does not count as direct run", isDirectRun() === false);
    
    const unicodeDir = mkdtempSync(join(tmpdir(), "agent-core-uni-"));
    leftovers.push(unicodeDir);
    writeFileSync(join(unicodeDir, "ä.txt"), "a");
    writeFileSync(join(unicodeDir, "b.txt"), "b");
    const listing = formatEnvironment(unicodeDir, { probes: false });
    check("unicode listing present", listing.includes("ä.txt") && listing.includes("b.txt"));
    
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, "..", "..", "..", "agent-core", "main.ts");
    const banner = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", src], {
        env: { ...process.env, TERMINA_CORE_TEST: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(out);
      }, 3000);
      child.stdout.on("data", (d) => {
        out += d.toString();
        if (out.includes("termina agent-core")) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(out);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    check("direct source starts even with TERMINA_CORE_TEST=1", String(banner).includes("termina agent-core"));
    
    check("grep lookaround (?=) rejected", validateGrepPattern("a(?=b)") !== null);
    check("grep lookaround (?!) rejected", validateGrepPattern("a(?!b)") !== null);
    check("grep lookbehind (?<=) rejected", validateGrepPattern("a(?<=b)") !== null);
    check("grep lookbehind (?<!) rejected", validateGrepPattern("a(?<!b)") !== null);
    check(
      "grep timeout note",
      (await grepFiles(root, { pattern: "unique-token" }, { budgetMs: 0 })).content.includes("timed out"),
    );
    
    writeFileSync(join(root, "many.txt"), Array.from({ length: 60 }, (_, i) => `hit-line-${i}`).join("\n"));
    check("grep caps hits", (await grepFiles(root, { pattern: "hit-line" })).content.split("\n").length <= 50);
    check("grep marks a per-file collect cap", (await grepFiles(root, { pattern: "hit-line" }, { jsOnly: true })).content.includes("50+ hits"));
    
    const groupedRaw = [
      ...Array.from({ length: 30 }, (_, i) => `noise.ts:${i + 1}:TODO fix`),
      "app.ts:12:TODO handle",
      "app.ts:40:TODO retry",
      "utils.ts:4:TODO",
    ].join("\n");
    const grouped = formatGrepHits(groupedRaw);
    check("grep groups sparse files first", grouped.indexOf("utils.ts") < grouped.indexOf("app.ts") && grouped.indexOf("app.ts") < grouped.indexOf("noise.ts"));
    check("grep page names the dense file", grouped.includes("noise.ts (30 hits, showing 8)"));
    check("grep page keeps sparse files", grouped.includes("app.ts (2 hits)") && grouped.includes("utils.ts (1 hit)"));
    check(
      "grep page does not dump the dense file",
      grouped.split("\n").filter((l) => l.includes("TODO fix")).length === 8,
    );
    check(
      "grep continue hint uses path",
      grouped.includes("22 more in noise.ts") && grouped.includes('path="noise.ts"'),
    );
    check("grep error passthrough", formatGrepHits("error: invalid regular expression") === "error: invalid regular expression");
    check("grep empty passthrough", formatGrepHits("(no matches)") === "(no matches)");
    check(
      "grep formats a path that starts with error:",
      formatGrepHits("error:codes.ts:1:boom").includes("error:codes.ts") &&
        formatGrepHits("error:codes.ts:1:boom").includes("1 hit"),
    );
    check("grep drops unparseable lines", !formatGrepHits("hit.ts:1:x\nnot-a-row").includes("not-a-row"));
    check("grep strips CR from ripgrep rows", formatGrepHits("hit.ts:1:x\r").includes("  1:x"));
    check(
      "grep clips long match lines",
      formatGrepHits(`a.ts:1:${"y".repeat(400)}`).includes("...") &&
        !formatGrepHits(`a.ts:1:${"y".repeat(400)}`).includes("y".repeat(400)),
    );
    check("grep stdout drops an incomplete last line", completeGrepStdout("a.ts:1:x\na.ts:2:part", true) === "a.ts:1:x");
    check("grep stdout keeps complete lines", completeGrepStdout("a.ts:1:x\n", true) === "a.ts:1:x");
    const omittedPage = formatGrepHits(
      `${Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(2, "0")}.ts:1:x`).join("\n")}\nzz.ts:1:y\nzz.ts:2:y`,
    );
    check(
      "grep names the largest omitted file",
      omittedPage.includes("more files (largest: zz.ts 2 hits)") && omittedPage.includes('path="zz.ts"'),
    );
    const denseOmitted = formatGrepHits(
      `${Array.from({ length: 8 }, (_, i) => `a${i}.ts:1:x`).join("\n")}\n${Array.from({ length: 30 }, (_, i) => `noise.ts:${i + 1}:TODO`).join("\n")}`,
    );
    check(
      "grep continue path is the omitted dense file",
      denseOmitted.includes("largest: noise.ts 30 hits") && denseOmitted.includes('path="noise.ts"'),
    );
    const multiPartial = formatGrepHits(
      ["a.ts", "b.ts", "c.ts"].flatMap((f) => Array.from({ length: 10 }, (_, i) => `${f}:${i + 1}:x`)).join("\n"),
    );
    check("grep continue hint keeps the largest remainder", multiPartial.includes("6 more in c.ts") && multiPartial.includes('path="c.ts"'));
    
    writeFileSync(join(root, "noise.ts"), `${Array.from({ length: 30 }, () => "TODO-CORE-NOISE fix").join("\n")}\n`);
    writeFileSync(join(root, "app-todo.ts"), "TODO-CORE-NOISE a\nTODO-CORE-NOISE b\n");
    writeFileSync(join(root, "utils-todo.ts"), "TODO-CORE-NOISE c\n");
    const jsGrouped = await grepFiles(root, { pattern: "TODO-CORE-NOISE" }, { jsOnly: true });
    check("grep js groups sparse files onto the first page", jsGrouped.content.includes("app-todo.ts") && jsGrouped.content.includes("utils-todo.ts"));
    check("grep js caps the dense file", jsGrouped.content.includes("noise.ts (30 hits, showing 8)"));
    check("grep js continue hint", jsGrouped.content.includes('path="noise.ts"'));
    const jsShown = jsGrouped.content.split("\n").filter((l) => l.includes("TODO-CORE-NOISE")).length;
    check("grep js shows 11 match lines", jsShown === 11);
    
    const parentDir = mkdtempSync(join(tmpdir(), "agent-core-parent-"));
    leftovers.push(parentDir);
    writeFileSync(join(parentDir, "AGENTS.md"), "PARENT-ONLY-TEXT\n");
    const childDir = join(parentDir, "proj");
    mkdirSync(childDir);
    const childFrozen = buildFrozenSystem({
      cwd: childDir,
      userAgentsPath: null,
      userSkillDir: null,
      probes: false,
    });
    check("ancestor AGENTS.md is not loaded", !childFrozen.system.includes("PARENT-ONLY-TEXT"));
    check("missing project AGENTS.md omits block", !childFrozen.system.includes("<project-instructions>"));
    check("frozen identity is the zone-1 prefix", childFrozen.system.startsWith(`${FROZEN_IDENTITY}\n\n`));
    check(
      "frozen identity forbids conversational edit permission",
      FROZEN_IDENTITY.includes("instead of asking permission conversationally") &&
        FROZEN_IDENTITY.includes("Follow an explicit host instruction not to touch a file") &&
        !FROZEN_IDENTITY.includes("not a stop"),
    );
    check("missing user-global omitted", !childFrozen.system.includes("<user-instructions>"));
    
    const escapedCwd = mkdtempSync(join(tmpdir(), "agent-core-esc-"));
    leftovers.push(escapedCwd);
    symlinkSync(join(outside, "AGENTS.md"), join(escapedCwd, "AGENTS.md"));
    const escapedFrozen = buildFrozenSystem({
      cwd: escapedCwd,
      userAgentsPath: null,
      userSkillDir: null,
      probes: false,
    });
    check(
      "project AGENTS.md symlink outside omitted",
      !escapedFrozen.system.includes("escape") && !escapedFrozen.system.includes("<project-instructions>"),
    );
    
    const skillCwd = mkdtempSync(join(tmpdir(), "agent-core-skillroot-"));
    leftovers.push(skillCwd);
    mkdirSync(join(skillCwd, ".agents"), { recursive: true });
    const foreignSkills = mkdtempSync(join(tmpdir(), "agent-core-foreign-skills-"));
    leftovers.push(foreignSkills);
    mkdirSync(join(foreignSkills, "sneaky"));
    writeFileSync(join(foreignSkills, "sneaky", "SKILL.md"), "---\nname: sneaky\ndescription: no\n---\n");
    symlinkSync(foreignSkills, join(skillCwd, ".agents", "skills"));
    const skillRootFrozen = buildFrozenSystem({
      cwd: skillCwd,
      userAgentsPath: null,
      userSkillDir: null,
      probes: false,
    });
    check("project skill-root symlink outside not scanned", !skillRootFrozen.system.includes("sneaky"));
    
    const userHome = mkdtempSync(join(tmpdir(), "agent-core-user-home-"));
    leftovers.push(userHome);
    writeFileSync(join(userHome, "AGENTS.md"), "USER-PREF-LINE\n");
    mkdirSync(join(userHome, "skills", "u"), { recursive: true });
    writeFileSync(join(userHome, "skills", "u", "SKILL.md"), "---\nname: uskill\ndescription: udesc\n---\n");
    const withUser = buildFrozenSystem({
      cwd: root,
      userAgentsPath: join(userHome, "AGENTS.md"),
      userSkillDir: join(userHome, "skills"),
      probes: false,
    });
    const userPos = withUser.system.indexOf("USER-PREF-LINE");
    const skillPos = withUser.system.indexOf("<skill-index>");
    const projPos = withUser.system.indexOf("<project-instructions>");
    check("user-global before skill index", userPos >= 0 && userPos < skillPos);
    check("skill index before project", skillPos >= 0 && skillPos < projPos);
    
    const longUser = join(userHome, "long.md");
    writeFileSync(longUser, "z".repeat(10_000));
    const longFrozen = buildFrozenSystem({
      cwd: root,
      userAgentsPath: longUser,
      userSkillDir: null,
      probes: false,
    });
    const longReal = realpathSync(longUser);
    check("user overflow names absolute path", longFrozen.system.includes(longReal));
    check("user overflow allow-set readable", readProjectFile(root, { path: longUser }, longFrozen.allow).isError === false);
    check(
      "user overflow path stays outside HTML comment",
      !longFrozen.system.includes(`read_file ${longReal} -->`),
    );
    
    const dashPath = "/tmp/foo--bar/AGENTS.md";
    const dashNote = formatUserInstructions("y".repeat(10_000), dashPath);
    check("user overflow with -- in path stays comment-safe", dashNote.includes(JSON.stringify(dashPath)) && !dashNote.includes("foo--bar/AGENTS.md -->"));
    
    const listRoot = mkdtempSync(join(tmpdir(), "agent-core-list-"));
    leftovers.push(listRoot);
    for (let i = 0; i < 25; i++) writeFileSync(join(listRoot, `f${String(i).padStart(2, "0")}.txt`), "x");
    const listingCap = formatEnvironment(listRoot, { probes: false });
    check("listing capped at 20", [...listingCap.matchAll(/"f\d+\.txt"/g)].length === 20);
    const jsonRoot = mkdtempSync(join(tmpdir(), "agent-core-json-"));
    leftovers.push(jsonRoot);
    writeFileSync(join(jsonRoot, 'quot"ed'), "x");
    const listingJson = formatEnvironment(jsonRoot, { probes: false });
    check("listing JSON-encodes special names", listingJson.includes(JSON.stringify('quot"ed')));
    
    const prevPath = process.env.PATH;
    let envMissing = "";
    try {
      process.env.PATH = "/nonexistent-agent-core-path";
      envMissing = formatEnvironment(root, { probes: true });
    } finally {
      process.env.PATH = prevPath;
    }
    check("empty PATH still reports node", envMissing.includes("node "));
    
    const noArgs = createAttemptRecord({
      runId: "run-harness-trace",
      taskId: "task-harness-trace",
      attemptId: "attempt-no-tool-input",
      role: "main",
      provider: "openai-codex",
      protocol: "openai-codex-responses",
      model: "m",
      status: "ok",
      storageSeqRange: [1, 2],
      toolNames: ["grep"],
      usage: null,
      ttftMs: 1,
      turnMs: 2,
      revisions: 0,
      wasteTokens: 0,
      wasteCause: null,
      cache: null,
    });
    check(
      "trace record has no tool arguments or paths",
      ["args", "input", "path", "pattern"].every((field) => !Object.hasOwn(noArgs, field)),
    );
    check("trace record keeps tool names only", noArgs.toolNames[0] === "grep" && noArgs.recordType === "attempt");
    const overflowTrace = createAttemptRecord({
      runId: "run-harness-trace",
      taskId: "task-harness-trace",
      attemptId: "attempt-overflow",
      role: "main",
      provider: "openai-codex",
      protocol: "openai-codex-responses",
      model: "m",
      status: "overflow",
      storageSeqRange: [2, 2],
      toolNames: [],
      usage: null,
      ttftMs: null,
      turnMs: 3,
      revisions: { count: 1, kinds: ["prune"] },
      wasteTokens: 17,
      wasteCause: "post-revision",
      cost: { usd: 0.0123 },
      cache: null,
    });
    check(
      "trace record preserves overflow and revision kinds",
      overflowTrace.status === "overflow" &&
        overflowTrace.cost.usd === 0.0123 &&
        overflowTrace.revisions.kinds[0] === "prune" &&
        overflowTrace.wasteTokens === 17 &&
        overflowTrace.wasteCause === "post-revision",
    );
    
    const fakeEntry = join(root, "entry.mjs");
    writeFileSync(fakeEntry, "");
    check("isDirectRunFrom same entry is direct", isDirectRunFrom(pathToFileURL(fakeEntry).href, fakeEntry) === true);
    check("isDirectRunFrom different entry is not", isDirectRunFrom(pathToFileURL(fakeEntry).href, join(root, "other.mjs")) === false);
    
    const bundled = join(here, "..", "..", "..", "dist-electron", "agent-core.mjs");
    if (existsSync(bundled)) {
      const bundledBanner = await new Promise((resolve) => {
        const child = spawn(process.execPath, [bundled], {
          env: { ...process.env, TERMINA_CORE_TEST: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(out);
        }, 3000);
        child.stdout.on("data", (d) => {
          out += d.toString();
          if (out.includes("termina agent-core")) {
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve(out);
          }
        });
        child.on("exit", () => {
          clearTimeout(timer);
          resolve(out);
        });
      });
      check("bundled entry starts even with TERMINA_CORE_TEST=1", String(bundledBanner).includes("termina agent-core"));
    } else {
      check("bundled entry comparison uses canonical paths", isDirectRunFrom(pathToFileURL(fakeEntry).href, realpathSync(fakeEntry)) === true);
    }
    
    const summarizeMissing = replaySessionRecords(
      [
        JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "old" } }),
        JSON.stringify({ storageSeq: 2, type: "revision", kind: "summarize", evicted: 1 }),
      ].join("\n"),
    );
    check("summarize without its atomic handoff fails closed", summarizeMissing.ok === false);
    
    check("sidecar bash has no path", sidecarStartFor({ name: "bash", id: "1", input: { path: "src" } }).path === undefined);
    check("sidecar write keeps path", sidecarStartFor({ name: "write_file", id: "1", input: { path: "a.ts" } }).path === "a.ts");
    
    const uniGlob = await globFiles(unicodeDir, "*");
    const uniLines = uniGlob.content.split("\n");
    check(
      "bytewise unicode glob order",
      uniLines.indexOf("b.txt") !== -1 && uniLines.indexOf("ä.txt") !== -1 && uniLines.indexOf("b.txt") < uniLines.indexOf("ä.txt"),
    );
    
    check("sidecar start is not usage", sidecarStartFor({ name: "read_file", id: "1", input: {} }).t === "tool");
    
    mkdirSync(join(root, "pkg-esc"), { recursive: true });
    writeFileSync(join(root, "pkg-esc", "a.ts"), "export {}\n");
    symlinkSync(join(outside, "AGENTS.md"), join(root, "pkg-esc", "AGENTS.md"));
    check("nested AGENTS.md symlink outside is not advertised", nestedAgentsPointer(root, join(root, "pkg-esc", "a.ts")) === null);
    
    check(
      "explicit read of ignored walk name works",
      !readProjectFile(root, { path: ".agents/skills/demo/SKILL.md" }).isError,
    );
    
    writeFileSync(join(root, "skip.bin"), Buffer.from("secret-bin\0more"));
    check("grep skips binary NUL files", !(await grepFiles(root, { pattern: "secret-bin" })).content.includes("skip.bin"));
    check("replay reports max storageSeq", replayed.ok && replayed.maxSeq === 4);
    
    const {
      pickHeaders,
      needsRefresh,
      parseTokenResponse,
      parseOauthToken,
      parseModelRef,
      DEFAULT_MODELS,
      modifyProvider,
      resolveAuth,
      runLogin,
      runLogout,
      parseAuthCommand,
      maskSecret,
      authBanner,
      resetAuthCache,
      isOAuthToken,
      requestHeaders,
      extractAccountId,
      defaultLoginMode,
      providerProtocol,
      validateCopilotApiUrl,
      hasStoredCredential,
      hasEnvCredential,
      firstAuthenticatedProvider,
      canOpenBrowser,
      browserOpenArgs,
      zenWireProtocol,
      usesAnthropicCacheMarkers,
      usesPromptCacheKey,
      usesOpenAIExplicitCache,
      usesPromptCacheOptions,
      cacheSessionHeaders,
      cacheSessionSeed,
      cacheIdentityFor,
      deriveCacheIdentityKey,
      CACHE_KEY_MAX_LENGTH,
      googleNativeHeaders,
    } = auth;
    const authFile = join(root, "auth.json");
    process.env.TERMINA_AUTH_PATH = authFile;
    resetAuthCache();
    
    check("canOpenBrowser is true on Windows", canOpenBrowser("win32", {}) === true);
    check("canOpenBrowser is false on Windows over SSH", canOpenBrowser("win32", { SSH_CONNECTION: "1" }) === false);
    check("canOpenBrowser is false on Linux without a display", canOpenBrowser("linux", {}) === false);
    check("canOpenBrowser is true on Linux with DISPLAY", canOpenBrowser("linux", { DISPLAY: ":0" }) === true);
    const winOpen = browserOpenArgs("https://example.com/auth", "win32");
    check(
      "Windows browser open uses start without a shell",
      winOpen?.cmd === "cmd" &&
        winOpen.args[0] === "/c" &&
        winOpen.args[1] === "start" &&
        winOpen.args[2] === '""' &&
        winOpen.args[3] === '"https://example.com/auth"' &&
        winOpen.windowsHide === true &&
        winOpen.windowsVerbatimArguments === true,
    );
    const winAmp = browserOpenArgs("https://example.com/auth?foo=1&bar=2", "win32");
    check(
      "Windows browser open quotes a URL that contains &",
      winAmp?.args[3] === '"https://example.com/auth?foo=1&bar=2"' && winAmp.windowsVerbatimArguments === true,
    );
    check("Windows browser open rejects a URL with a quote", browserOpenArgs('https://example.com/x"y', "win32") === null);
    check("macOS browser open uses open", browserOpenArgs("https://example.com/auth", "darwin")?.cmd === "open");
    check("Linux browser open uses xdg-open", browserOpenArgs("https://example.com/auth", "linux")?.cmd === "xdg-open");
    check("browser open rejects a non-https URL", browserOpenArgs("http://example.com/auth", "win32") === null);
    check("browser open rejects a file URL", browserOpenArgs("file:///tmp/x", "darwin") === null);
    
    check("pickHeaders oat uses bearer", pickHeaders("sk-ant-oat-secret").authorization === "Bearer sk-ant-oat-secret");
    check("pickHeaders oat sets betas", Boolean(pickHeaders("sk-ant-oat-secret")["anthropic-beta"]));
    check("pickHeaders api key uses x-api-key", pickHeaders("sk-ant-api-x")["x-api-key"] === "sk-ant-api-x");
    check("pickHeaders api key has no bearer", pickHeaders("sk-ant-api-x").authorization === undefined);
    check("isOAuthToken sniffs oat", isOAuthToken("prefix-sk-ant-oat-zz") === true);
    
    check("needsRefresh past is true", needsRefresh(Date.now() - 1000) === true);
    check("needsRefresh future is false", needsRefresh(Date.now() + 60_000) === false);
    
    check("parseTokenResponse missing access fails", parseTokenResponse({ refresh_token: "r", expires_in: 10 }).ok === false);
    check("parseTokenResponse missing refresh fails", parseTokenResponse({ access_token: "a", expires_in: 10 }).ok === false);
    const parsedTok = parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 }, 1_000_000);
    check(
      "parseTokenResponse back-dates expires",
      parsedTok.ok === true && parsedTok.expires === 1_000_000 + 3600 * 1000 - 300_000,
    );
    check("maskSecret hides the raw token", !maskSecret("sk-ant-oat-abcdefgh").includes("sk-ant-oat-abcd") && maskSecret("sk-ant-oat-abcdefgh").endsWith("efgh"));
    
    modifyProvider("anthropic", () => ({ type: "api_key", key: "stored-key", extra: "keep-me" }));
    modifyProvider("other", () => ({ type: "api_key", key: "other-key" }));
    modifyProvider("anthropic", (current) => ({ ...current, key: "stored-key-2" }));
    const storedFile = JSON.parse(readFileSync(authFile, "utf8"));
    check("modifyProvider preserves unrelated root keys", storedFile.other?.key === "other-key");
    check("modifyProvider preserves extra entry fields", storedFile.anthropic?.extra === "keep-me");
    
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevTok = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "env-api-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "env-auth-token";
    resetAuthCache();
    const storedWins = await resolveAuth("anthropic");
    check("stored credential beats env", storedWins.ok && storedWins.token === "stored-key-2" && storedWins.source === "api_key");
    runLogout("anthropic");
    resetAuthCache();
    const envWins = await resolveAuth("anthropic");
    check("env ANTHROPIC_API_KEY used when no store", envWins.ok && envWins.envName === "ANTHROPIC_API_KEY" && envWins.token === "env-api-key");
    delete process.env.ANTHROPIC_API_KEY;
    resetAuthCache();
    const altEnv = await resolveAuth("anthropic");
    check("env ANTHROPIC_AUTH_TOKEN is second", altEnv.ok && altEnv.envName === "ANTHROPIC_AUTH_TOKEN");
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    resetAuthCache();
    const none = await resolveAuth("anthropic");
    check("missing credential fails closed", none.ok === false);
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = prevTok;
    
    check("parseAuthCommand bare /login asks to pick", "error" in parseAuthCommand("/login") && String(parseAuthCommand("/login").error).includes("pick a provider"));
    check("parseAuthCommand bare /logout asks to pick", "error" in parseAuthCommand("/logout") && String(parseAuthCommand("/logout").error).includes("pick a provider"));
    check("parseAuthCommand code mode", parseAuthCommand("/login code").mode === "code");
    check("parseAuthCommand rejects unknown provider", "error" in parseAuthCommand("/login nope"));
    check("banner does not contain raw token", !authBanner({ ok: true, providerId: "anthropic", token: "sk-ant-oat-SUPERSECRET99", kind: "oauth", source: "oauth", baseUrl: "https://api.anthropic.com", headers: {} }).includes("SUPERSECRET"));
    const cancelledLogin = new AbortController();
    cancelledLogin.abort();
    const cancelledResult = await runLogin("anthropic", "browser", {
      write: () => {},
      openUrl: () => {},
      signal: cancelledLogin.signal,
    });
    check("browser login respects an already-aborted signal", cancelledResult.ok === false && cancelledResult.error === "login cancelled");
    
    const prevTimeout = process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS;
    const prevDenyPort = process.env.TERMINA_TEST_REDIRECT_PORT;
    process.env.TERMINA_TEST_REDIRECT_PORT = "27323";
    let denyOut = "";
    const denyP = runLogin("anthropic", "browser", {
      write: (t) => {
        denyOut += t;
      },
      openUrl: () => {},
    });
    let denyResult;
    try {
      const started = Date.now();
      while (!denyOut.includes("authorize:") && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 20));
      await fetch("http://127.0.0.1:27323/callback?error=access_denied&state=x");
      denyResult = await denyP;
    } catch (err) {
      denyResult = { ok: false, error: String(err) };
    }
    check("oauth access_denied is login cancelled", denyResult.ok === false && denyResult.error === "login cancelled");
    process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS = "150";
    process.env.TERMINA_TEST_REDIRECT_PORT = "27324";
    const timedOut = await runLogin("anthropic", "browser", { write: () => {}, openUrl: () => {} });
    check(
      "oauth wait times out as cancelled",
      timedOut.ok === false && String(timedOut.error).includes("login cancelled"),
    );
    if (prevTimeout === undefined) delete process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS;
    else process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS = prevTimeout;
    if (prevDenyPort === undefined) delete process.env.TERMINA_TEST_REDIRECT_PORT;
    else process.env.TERMINA_TEST_REDIRECT_PORT = prevDenyPort;
    
    const tokenSrv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        let grant = "";
        try {
          grant = JSON.parse(body).grant_type;
        } catch {
          grant = "";
        }
        res.setHeader("content-type", "application/json");
        if (grant === "refresh_token") {
          res.end(JSON.stringify({ access_token: "sk-ant-oat-refreshed99", refresh_token: "refresh-2", expires_in: 3600 }));
          return;
        }
        res.end(JSON.stringify({ access_token: "sk-ant-oat-login99xy", refresh_token: "refresh-1", expires_in: 3600 }));
      });
    });
    const tokenPort = await new Promise((resolve) => {
      tokenSrv.listen(0, "127.0.0.1", () => resolve(tokenSrv.address().port));
    });
    const prevTokenUrl = process.env.TERMINA_TEST_TOKEN_URL;
    const prevRedir = process.env.TERMINA_TEST_REDIRECT_PORT;
    process.env.TERMINA_TEST_TOKEN_URL = `http://127.0.0.1:${tokenPort}/`;
    process.env.TERMINA_TEST_REDIRECT_PORT = "27321";
    resetAuthCache();
    runLogout("anthropic");
    let loginOut = "";
    const loginP = runLogin("anthropic", "browser", {
      write: (t) => {
        loginOut += t;
      },
      openUrl: () => {},
    });
    let loginResult;
    try {
      const started = Date.now();
      while (!loginOut.includes("authorize:") && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 20));
      const authUrl = (loginOut.match(/authorize: (\S+)/) || [])[1];
      const state = new URL(authUrl).searchParams.get("state");
      await fetch(`http://127.0.0.1:27321/callback?code=test-code&state=${state}`);
      loginResult = await loginP;
    } catch (err) {
      loginResult = { ok: false, error: String(err) };
    }
    check("login stores oauth credential", loginResult.ok === true);
    resetAuthCache();
    const afterLogin = await resolveAuth("anthropic");
    check(
      "login resolve uses bearer oat",
      afterLogin.ok && afterLogin.kind === "oauth" && afterLogin.headers.authorization?.startsWith("Bearer ") && afterLogin.headers["x-api-key"] === undefined,
    );
    modifyProvider("anthropic", (current) => ({ ...current, expires: Date.now() - 1 }));
    resetAuthCache();
    const afterRefresh = await resolveAuth("anthropic");
    check(
      "expired oauth refreshes and persists",
      afterRefresh.ok && afterRefresh.token === "sk-ant-oat-refreshed99" && JSON.parse(readFileSync(authFile, "utf8")).anthropic.refresh === "refresh-2",
    );
    if (prevTokenUrl === undefined) delete process.env.TERMINA_TEST_TOKEN_URL;
    else process.env.TERMINA_TEST_TOKEN_URL = prevTokenUrl;
    if (prevRedir === undefined) delete process.env.TERMINA_TEST_REDIRECT_PORT;
    else process.env.TERMINA_TEST_REDIRECT_PORT = prevRedir;
    tokenSrv.close();
    
    check(
      "DEFAULT_MODELS anthropic main is sonnet 5",
      DEFAULT_MODELS.anthropic.main === "claude-sonnet-5" && DEFAULT_MODELS.anthropic.summary === "claude-haiku-4-5",
    );
    check(
      "DEFAULT_MODELS openai is gpt-5.6 sol/luna",
      DEFAULT_MODELS.openai.main === "gpt-5.6-sol" && DEFAULT_MODELS.openai.summary === "gpt-5.6-luna",
    );
    check(
      "DEFAULT_MODELS openai-codex is gpt-5.6 sol/luna",
      DEFAULT_MODELS["openai-codex"].main === "gpt-5.6-sol" && DEFAULT_MODELS["openai-codex"].summary === "gpt-5.6-luna",
    );
    check(
      "DEFAULT_MODELS github-copilot is gpt-5.6 terra/luna",
      DEFAULT_MODELS["github-copilot"].main === "gpt-5.6-terra" && DEFAULT_MODELS["github-copilot"].summary === "gpt-5.6-luna",
    );
    check(
      "DEFAULT_MODELS xai is grok-4.6",
      DEFAULT_MODELS.xai.main === "grok-4.6" && DEFAULT_MODELS.xai.summary === "grok-4.6",
    );
    check(
      "DEFAULT_MODELS google is gemini 3.7 flash / 3.5 flash-lite",
      DEFAULT_MODELS.google.main === "gemini-3.7-flash" && DEFAULT_MODELS.google.summary === "gemini-3.5-flash-lite",
    );
    check(
      "DEFAULT_MODELS openrouter is gpt-5.6 terra/luna",
      DEFAULT_MODELS.openrouter.main === "openai/gpt-5.6-terra" && DEFAULT_MODELS.openrouter.summary === "openai/gpt-5.6-luna",
    );
    check(
      "DEFAULT_MODELS opencode-go is glm-5.1",
      DEFAULT_MODELS["opencode-go"].main === "glm-5.1" && DEFAULT_MODELS["opencode-go"].summary === "glm-5.1",
    );
    check(
      "DEFAULT_MODELS opencode-zen is gpt-5.6 sol/luna",
      DEFAULT_MODELS["opencode-zen"].main === "gpt-5.6-sol" && DEFAULT_MODELS["opencode-zen"].summary === "gpt-5.6-luna",
    );
    check("parseModelRef grok is xai", parseModelRef("grok-4.6").provider === "xai" && parseModelRef("grok-4.6").model === "grok-4.6");
    check(
      "parseModelRef openai-codex prefix",
      parseModelRef("openai-codex/gpt-5.6-sol").provider === "openai-codex" && parseModelRef("openai-codex/gpt-5.6-sol").model === "gpt-5.6-sol",
    );
    check("parseModelRef provider override", parseModelRef("gpt-5", "openai-codex").provider === "openai-codex");
    check("parseModelRef gpt defaults to openai", parseModelRef("gpt-5").provider === "openai");
    check("defaultLoginMode xai is device", defaultLoginMode("xai") === "device");
    check("defaultLoginMode openai is key", defaultLoginMode("openai") === "key");
    check("providerProtocol xai is responses", providerProtocol("xai") === "openai-responses");
    check("providerProtocol openai is responses", providerProtocol("openai") === "openai-responses");
    check("providerProtocol google is completions", providerProtocol("google") === "openai-completions");
    check("providerProtocol copilot is responses", providerProtocol("github-copilot") === "openai-responses");
    check("providerProtocol openai-codex is responses", providerProtocol("openai-codex") === "openai-codex-responses");
    check("providerProtocol opencode-go is completions", providerProtocol("opencode-go") === "openai-completions");
    check("zenWireProtocol claude is messages", zenWireProtocol("claude-sonnet-4-5") === "anthropic-messages");
    check("zenWireProtocol gpt is responses", zenWireProtocol("gpt-5.6-sol") === "openai-responses");
    check("zenWireProtocol glm is completions", zenWireProtocol("glm-5.1") === "openai-completions");
    check("zenWireProtocol grok is responses", zenWireProtocol("grok-4.6") === "openai-responses");
    check("zenWireProtocol qwen is messages", zenWireProtocol("qwen3.7-max") === "anthropic-messages");
    check("zenWireProtocol muse-spark is responses", zenWireProtocol("muse-spark-1.2") === "openai-responses");
    check("zenWireProtocol gemini is google-generate", zenWireProtocol("gemini-3.7-flash") === "google-generate");
    check("zenWireProtocol prefixed gpt is responses", zenWireProtocol("openai/gpt-5.6-sol") === "openai-responses");
    check("zenWireProtocol prefixed claude is messages", zenWireProtocol("anthropic/claude-sonnet-4-5") === "anthropic-messages");
    check(
      "providerProtocol opencode-zen follows the model",
      providerProtocol("opencode-zen", "claude-opus-4-6") === "anthropic-messages" &&
        providerProtocol("opencode-zen", "gpt-5.1-codex") === "openai-responses" &&
        providerProtocol("opencode-zen", "kimi-k2.7-code") === "openai-completions" &&
        providerProtocol("opencode-zen", "grok-4.6") === "openai-responses" &&
        providerProtocol("opencode-zen", "qwen3.7-plus") === "anthropic-messages",
    );
    check("usesPromptCacheKey xai is true", usesPromptCacheKey("xai", "grok-4.6", "https://api.x.ai/v1") === true);
    check("usesPromptCacheKey google is false", usesPromptCacheKey("google", "gemini-3.7-flash", "https://generativelanguage.googleapis.com") === false);
    check("usesPromptCacheKey zen gemini is false", usesPromptCacheKey("opencode-zen", "gemini-3.7-flash", "https://opencode.ai") === false);
    check("usesPromptCacheKey anthropic is false", usesPromptCacheKey("anthropic", "claude-sonnet-5", "https://api.anthropic.com") === false);
    check("usesPromptCacheKey zen claude is false", usesPromptCacheKey("opencode-zen", "claude-sonnet-5", "https://opencode.ai") === false);
    check("usesPromptCacheKey zen glm is false", usesPromptCacheKey("opencode-zen", "glm-5.1", "https://opencode.ai") === false);
    check("usesPromptCacheKey copilot is false", usesPromptCacheKey("github-copilot", "gpt-5.6-terra", "https://api.githubcopilot.com") === false);
    check("usesAnthropicCacheMarkers direct only", usesAnthropicCacheMarkers("anthropic", "claude-sonnet-5", "https://api.anthropic.com") === true);
    check("usesAnthropicCacheMarkers openrouter is false", usesAnthropicCacheMarkers("openrouter", "anthropic/claude-sonnet-5", "https://openrouter.ai") === false);
    check("usesAnthropicCacheMarkers openrouter gpt", usesAnthropicCacheMarkers("openrouter", "openai/gpt-5.6-sol", "https://openrouter.ai") === false);
    check("usesAnthropicCacheMarkers openrouter qwen", usesAnthropicCacheMarkers("openrouter", "qwen/qwen3.7-max", "https://openrouter.ai") === false);
    check("usesOpenAIExplicitCache direct gpt-5.6", usesOpenAIExplicitCache("gpt-5.6-sol", "openai", "https://api.openai.com/v1") === true);
    check("usesOpenAIExplicitCache skips Codex", usesOpenAIExplicitCache("gpt-5.6-sol", "openai-codex", "https://chatgpt.com") === false);
    check("usesOpenAIExplicitCache skips Copilot", usesOpenAIExplicitCache("gpt-5.6-sol", "github-copilot", "https://api.githubcopilot.com") === false);
    check("usesOpenAIExplicitCache zen gpt-5.6", usesOpenAIExplicitCache("gpt-5.6-sol", "opencode-zen", "https://opencode.ai") === false);
    check("usesPromptCacheOptions openai gpt-5.6", usesPromptCacheOptions("openai", "gpt-5.6-sol", "https://api.openai.com/v1") === true);
    check("usesPromptCacheOptions openrouter gpt-5.6", usesPromptCacheOptions("openrouter", "openai/gpt-5.6-sol", "https://openrouter.ai") === false);
    check("usesPromptCacheOptions skips Codex", usesPromptCacheOptions("openai-codex", "gpt-5.6-sol", "https://chatgpt.com") === false);
    check("usesPromptCacheOptions skips Zen", usesPromptCacheOptions("opencode-zen", "gpt-5.6-sol", "https://opencode.ai") === false);
    const cacheSeed = cacheSessionSeed("core-1");
    const cacheIdentity = cacheIdentityFor({
      sessionSeed: cacheSeed,
      role: "main",
      provider: "openrouter",
      protocol: "openai-responses",
      route: "https://openrouter.ai/api/v1",
    });
    check("derived cache identity is bounded", (cacheIdentity?.key.length ?? 0) <= CACHE_KEY_MAX_LENGTH);
    check("derived cache identity is printable", cacheIdentity !== null && /^[\x21-\x7e]+$/.test(cacheIdentity.key));
    check("cache seed rejects a control character", cacheSessionSeed("core-1\nHost: x") === "");
    check("derived cache identity rejects an invalid seed", cacheIdentityFor({
      sessionSeed: cacheSessionSeed("core-1\nHost: x"),
      role: "main",
      provider: "openrouter",
      protocol: "openai-responses",
      route: "https://openrouter.ai/api/v1",
    }) === null);
    const zenCacheIdentity = cacheIdentityFor({
      sessionSeed: cacheSeed,
      role: "main",
      provider: "opencode-zen",
      protocol: "openai-responses",
      route: "https://opencode.ai/zen/v1",
    });
    check(
      "cacheSessionHeaders opencode pins derived key",
      cacheSessionHeaders(zenCacheIdentity)["x-opencode-session"] === zenCacheIdentity?.key,
    );
    check(
      "cacheSessionHeaders openrouter",
      cacheSessionHeaders(cacheIdentity)["x-session-id"] === cacheIdentity?.key,
    );
    check(
      "cacheSessionHeaders xai responses is absent",
      Object.keys(cacheSessionHeaders(cacheIdentity && { ...cacheIdentity, provider: "xai" })).length === 0,
    );
    const xaiChatIdentity = cacheIdentityFor({
      sessionSeed: cacheSeed,
      role: "main",
      provider: "xai",
      protocol: "openai-completions",
      route: "https://api.x.ai/v1",
    });
    check("cacheSessionHeaders xai chat pins derived key", cacheSessionHeaders(xaiChatIdentity)["x-grok-conv-id"] === xaiChatIdentity?.key);
    check(
      "googleNativeHeaders drops Bearer for Zen Gemini",
      googleNativeHeaders({ authorization: "Bearer zen-key", "content-type": "application/json" })["x-goog-api-key"] ===
        "zen-key" &&
        googleNativeHeaders({ authorization: "Bearer zen-key" }).authorization === undefined,
    );
    check(
      "googleNativeHeaders drops x-api-key and anthropic-version",
      googleNativeHeaders({
        authorization: "Bearer zen-key",
        "x-api-key": "zen-key",
        "anthropic-version": "2023-06-01",
      })["x-api-key"] === undefined &&
        googleNativeHeaders({
          authorization: "Bearer zen-key",
          "x-api-key": "zen-key",
          "anthropic-version": "2023-06-01",
        })["anthropic-version"] === undefined,
    );
    check("anthropicCacheMark anthropic is 1h", anthropicCacheMark("anthropic").ttl === "1h");
    check("anthropicCacheMark zen omits ttl", anthropicCacheMark("opencode-zen").ttl === undefined);
    check("defaultLoginMode opencode-go is key", defaultLoginMode("opencode-go") === "key");
    check("defaultLoginMode opencode-zen is key", defaultLoginMode("opencode-zen") === "key");
    check("parseAuthCommand /login xai is device", parseAuthCommand("/login xai").mode === "device" && parseAuthCommand("/login xai").provider === "xai");
    check("parseAuthCommand /login key openai", parseAuthCommand("/login key openai").mode === "key" && parseAuthCommand("/login key openai").provider === "openai");
    check("parseAuthCommand /login openai-codex", parseAuthCommand("/login openai-codex").provider === "openai-codex" && parseAuthCommand("/login openai-codex").mode === "browser");
    check(
      "parseAuthCommand /login openai oauth is Codex",
      parseAuthCommand("/login openai oauth").provider === "openai-codex" && parseAuthCommand("/login openai oauth").mode === "browser",
    );
    check(
      "parseAuthCommand /login openai key is API key",
      parseAuthCommand("/login openai key").provider === "openai" && parseAuthCommand("/login openai key").mode === "key",
    );
    check(
      "parseAuthCommand /login anthropic key",
      parseAuthCommand("/login anthropic key").provider === "anthropic" && parseAuthCommand("/login anthropic key").mode === "key",
    );
    check(
      "parseAuthCommand /login xai oauth is device",
      parseAuthCommand("/login xai oauth").mode === "device" && parseAuthCommand("/login xai oauth").provider === "xai",
    );
    check(
      "parseAuthCommand is case-insensitive",
      parseAuthCommand("/login OpenAI OAuth").provider === "openai-codex" && parseAuthCommand("/login KEY Anthropic").mode === "key",
    );
    check("parseAuthCommand google oauth is rejected", "error" in parseAuthCommand("/login google oauth"));
    check(
      "parseAuthCommand /logout openai oauth is Codex",
      parseAuthCommand("/logout openai oauth").cmd === "logout" && parseAuthCommand("/logout openai oauth").provider === "openai-codex",
    );
    check(
      "parseAuthCommand /logout openai key is API key store",
      parseAuthCommand("/logout openai key").provider === "openai",
    );
    check(
      "parseAuthCommand /login github-copilot is device",
      parseAuthCommand("/login github-copilot").mode === "device" && parseAuthCommand("/login github-copilot").provider === "github-copilot",
    );
    check(
      "parseAuthCommand /login opencode-go is key",
      parseAuthCommand("/login opencode-go").mode === "key" && parseAuthCommand("/login opencode-go").provider === "opencode-go",
    );
    check(
      "parseAuthCommand /login opencode-zen is key",
      parseAuthCommand("/login opencode-zen").mode === "key" && parseAuthCommand("/login opencode-zen").provider === "opencode-zen",
    );
    check("parseAuthCommand opencode-go oauth is rejected", "error" in parseAuthCommand("/login opencode-go oauth"));
    check(
      "validateCopilotApiUrl allows githubcopilot hosts",
      validateCopilotApiUrl("https://api.individual.githubcopilot.com/") === "https://api.individual.githubcopilot.com",
    );
    check("validateCopilotApiUrl rejects http", validateCopilotApiUrl("http://api.githubcopilot.com") === null);
    check("validateCopilotApiUrl rejects other hosts", validateCopilotApiUrl("https://evil.example/copilot") === null);
    
    const prevOpenAI = process.env.OPENAI_API_KEY;
    const prevXai = process.env.XAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-env";
    process.env.XAI_API_KEY = "xai-env-key";
    resetAuthCache();
    const openaiEnv = await resolveAuth("openai");
    const xaiEnv = await resolveAuth("xai");
    check("OPENAI_API_KEY resolves", openaiEnv.ok && openaiEnv.token === "sk-openai-env" && openaiEnv.headers.authorization === "Bearer sk-openai-env");
    check("XAI_API_KEY resolves", xaiEnv.ok && xaiEnv.token === "xai-env-key");
    modifyProvider("openai", () => ({ type: "api_key", key: "stored-openai" }));
    resetAuthCache();
    const openaiStored = await resolveAuth("openai");
    check("stored openai key beats env", openaiStored.ok && openaiStored.token === "stored-openai");
    runLogout("openai");
    if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAI;
    if (prevXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevXai;
    
    const xaiKeep = parseOauthToken(
      { access_token: "new-access", expires_in: 3600 },
      1_000_000,
      { requireRefresh: false, previousRefresh: "old-refresh", defaultExpiresIn: 3600 },
    );
    check(
      "xai refresh keeps previous refresh token",
      xaiKeep.ok === true && xaiKeep.refresh === "old-refresh" && xaiKeep.access === "new-access",
    );
    
    const jwtPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-99" } }),
    ).toString("base64url");
    const jwt = `eyJhbGciOiJub25lIn0.${jwtPayload}.sig`;
    check("extractAccountId reads chatgpt_account_id", extractAccountId(jwt) === "acct-99");
    check(
      "codex headers include account id",
      requestHeaders("openai-codex", jwt, { accountId: "acct-99" })["chatgpt-account-id"] === "acct-99" &&
        requestHeaders("openai-codex", jwt).originator === "codex_cli_rs",
    );
    
    let keyOut = "";
    const keyLogin = await runLogin("google", "key", {
      write: (t) => {
        keyOut += t;
      },
      waitForCode: async () => "gemini-stored-key",
    });
    resetAuthCache();
    const googleStored = await resolveAuth("google");
    check("google key login stores api_key", keyLogin.ok === true && googleStored.ok && googleStored.token === "gemini-stored-key");
    runLogout("google");
    
    const goLogin = await runLogin("opencode-go", "key", {
      write: () => {},
      waitForCode: async () => "go-stored-key",
    });
    resetAuthCache();
    const goStored = await resolveAuth("opencode-go");
    check(
      "opencode-go key login stores api_key",
      goLogin.ok === true && goStored.ok && goStored.token === "go-stored-key" && goStored.baseUrl === "https://opencode.ai/zen/go/v1",
    );
    check(
      "opencode-go headers send bearer and x-api-key",
      goStored.ok &&
        goStored.headers.authorization === "Bearer go-stored-key" &&
        goStored.headers["x-api-key"] === "go-stored-key",
    );
    runLogout("opencode-go");
    
    const zenLogin = await runLogin("opencode-zen", "key", {
      write: () => {},
      waitForCode: async () => "zen-stored-key",
    });
    resetAuthCache();
    const zenStored = await resolveAuth("opencode-zen");
    check(
      "opencode-zen key login stores api_key",
      zenLogin.ok === true && zenStored.ok && zenStored.token === "zen-stored-key" && zenStored.baseUrl === "https://opencode.ai/zen/v1",
    );
    runLogout("opencode-zen");
    
    const prevGo = process.env.OPENCODE_GO_API_KEY;
    process.env.OPENCODE_GO_API_KEY = "env-go-key";
    resetAuthCache();
    const goEnv = await resolveAuth("opencode-go");
    check("OPENCODE_GO_API_KEY resolves", goEnv.ok && goEnv.token === "env-go-key" && goEnv.source === "env");
    if (prevGo === undefined) delete process.env.OPENCODE_GO_API_KEY;
    else process.env.OPENCODE_GO_API_KEY = prevGo;
    resetAuthCache();
    
    const mapped = compat.toCompletionsMessages("sys", [
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
    ]);
    check(
      "completions maps tool_use to tool_calls",
      mapped[0].role === "system" &&
        mapped[1].role === "assistant" &&
        mapped[1].tool_calls?.[0]?.id === "call-1" &&
        mapped[2].role === "tool" &&
        mapped[2].tool_call_id === "call-1",
    );
    const mappedImg = compat.toCompletionsMessages("sys", [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } },
        ],
      },
    ]);
    check(
      "completions maps image blocks to image_url",
      Array.isArray(mappedImg[1].content) &&
        mappedImg[1].content[0]?.type === "text" &&
        mappedImg[1].content[1]?.type === "image_url" &&
        String(mappedImg[1].content[1]?.image_url?.url).startsWith("data:image/png;base64,"),
    );
    const responsesImg = compat.toResponsesInput([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } },
        ],
      },
    ]);
    check(
      "responses maps image blocks to input_image",
      responsesImg[0].role === "user" &&
        responsesImg[0].content[1]?.type === "input_image" &&
        String(responsesImg[0].content[1]?.image_url).startsWith("data:image/png;base64,"),
    );
    const responsesIn = compat.toResponsesInput([
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
    ]);
    check(
      "responses maps tool_use to function_call",
      responsesIn[0].type === "function_call" && responsesIn[0].call_id === "call-1" && responsesIn[1].type === "function_call_output",
    );
    const streamResult = compat.completionResultFromEvents(
      [
        { choices: [{ delta: { content: "Hi" } }] },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        { usage: { prompt_tokens: 10, completion_tokens: 4 } },
      ],
      () => {},
      Date.now(),
    );
    check(
      "completion stream collects text and tool_use",
      streamResult.blocks[0]?.type === "text" &&
        streamResult.blocks[0]?.text === "Hi" &&
        streamResult.blocks[1]?.type === "tool_use" &&
        streamResult.blocks[1]?.name === "bash" &&
        streamResult.stopReason === "tool_calls",
    );
    
    const deviceSrv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        res.setHeader("content-type", "application/json");
        if (params.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
          res.end(JSON.stringify({ access_token: "xai-access-99", refresh_token: "xai-refresh-1", expires_in: 3600 }));
          return;
        }
        res.end(
          JSON.stringify({
            device_code: "dev-1",
            user_code: "ABCD-1234",
            verification_uri: "http://127.0.0.1/device",
            interval: 0,
            expires_in: 60,
          }),
        );
      });
    });
    const devicePort = await new Promise((resolve) => {
      deviceSrv.listen(0, "127.0.0.1", () => resolve(deviceSrv.address().port));
    });
    const prevDevice = process.env.TERMINA_TEST_DEVICE_URL;
    const prevTok2 = process.env.TERMINA_TEST_TOKEN_URL;
    process.env.TERMINA_TEST_DEVICE_URL = `http://127.0.0.1:${devicePort}/`;
    process.env.TERMINA_TEST_TOKEN_URL = `http://127.0.0.1:${devicePort}/`;
    resetAuthCache();
    runLogout("xai");
    const xaiLogin = await runLogin("xai", "device", {
      write: () => {},
      openUrl: () => {},
    });
    resetAuthCache();
    const xaiAfter = await resolveAuth("xai");
    check(
      "xai device login stores oauth",
      xaiLogin.ok === true && xaiAfter.ok && xaiAfter.kind === "oauth" && xaiAfter.token === "xai-access-99",
    );
    runLogout("xai");
    if (prevDevice === undefined) delete process.env.TERMINA_TEST_DEVICE_URL;
    else process.env.TERMINA_TEST_DEVICE_URL = prevDevice;
    if (prevTok2 === undefined) delete process.env.TERMINA_TEST_TOKEN_URL;
    else process.env.TERMINA_TEST_TOKEN_URL = prevTok2;
    deviceSrv.close();
    
    const modelsMod = await import("../../../agent-core/models.ts");
    const {
      parseModelsPayload,
      isChatModel,
      pickDefaultModel,
      parseModelSwitch,
      modelsUrl,
      formatModelBanner,
      formatCatalogLines,
      catalogHeaders,
      loadProviderModels,
      catalogFetchAllowed,
    } = modelsMod;
    
    check("isChatModel drops embeddings", isChatModel("text-embedding-3-small", "openai") === false);
    check("isChatModel keeps gpt", isChatModel("gpt-5", "openai") === true);
    check("isChatModel keeps gpt-4o", isChatModel("gpt-4o", "openai") === true);
    check("isChatModel keeps gemini flash", isChatModel("gemini-2.5-flash", "google") === true);
    check("isChatModel grok on xai", isChatModel("grok-4.3", "xai") === true);
    check("isChatModel grok-image dropped", isChatModel("grok-2-image", "xai") === false);
    check("isChatModel opencode keeps big-pickle", isChatModel("big-pickle", "opencode-zen") === true);
    check("isChatModel opencode drops embeddings", isChatModel("text-embedding-3-small", "opencode-go") === false);
    
    const openaiList = parseModelsPayload(
      { data: [{ id: "gpt-5" }, { id: "text-embedding-3-small" }, { id: "gpt-4.1-mini" }] },
      "openai",
    );
    check("parseModelsPayload filters non-chat", openaiList.map((m) => m.id).join(",") === "gpt-5,gpt-4.1-mini");
    const anthList = parseModelsPayload(
      { data: [{ id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5" }] },
      "anthropic",
    );
    check("parseModelsPayload anthropic display name", anthList[0]?.id === "claude-sonnet-4-5-20250929" && anthList[0]?.name === "Claude Sonnet 4.5");
    const gemList = parseModelsPayload(
      { models: [{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }] },
      "google",
    );
    check("parseModelsPayload strips google models/ prefix", gemList[0]?.id === "gemini-2.5-flash");
    const slugList = parseModelsPayload({ models: [{ slug: "gpt-5.4", display_name: "GPT-5.4" }] }, "openai-codex");
    check("parseModelsPayload reads Codex slug", slugList[0]?.id === "gpt-5.4");
    check(
      "pickDefaultModel prefix match",
      pickDefaultModel(anthList, "claude-sonnet-4-5") === "claude-sonnet-4-5-20250929",
    );
    check("pickDefaultModel empty is null", pickDefaultModel([], "gpt-5") === null);
    check("parseModelSwitch prefix changes provider", parseModelSwitch("xai/grok-4.6", "anthropic").provider === "xai");
    check(
      "parseModelSwitch empty tail uses default",
      parseModelSwitch("xai/", "anthropic").provider === "xai" && parseModelSwitch("xai/", "anthropic").model === DEFAULT_MODELS.xai.main,
    );
    check(
      "parseModelSwitch openrouter keeps vendor/model",
      parseModelSwitch("anthropic/claude-sonnet-4", "openrouter").provider === "openrouter" &&
        parseModelSwitch("anthropic/claude-sonnet-4", "openrouter").model === "anthropic/claude-sonnet-4",
    );
    check("modelsUrl anthropic uses /v1/models", modelsUrl("anthropic", "https://api.anthropic.com").includes("/v1/models"));
    check("modelsUrl openai uses /models", modelsUrl("openai", "https://api.openai.com/v1").endsWith("/models"));
    check(
      "modelsUrl openai-codex adds client_version",
      modelsUrl("openai-codex", "https://chatgpt.com/backend-api").includes("/codex/models") &&
        modelsUrl("openai-codex", "https://chatgpt.com/backend-api").includes("client_version="),
    );
    check(
      "catalogHeaders drop Responses-only fields",
      catalogHeaders({
        authorization: "Bearer x",
        "content-type": "application/json",
        "openai-beta": "responses=experimental",
        originator: "codex_cli_rs",
      }).authorization === "Bearer x" &&
        catalogHeaders({
          authorization: "Bearer x",
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
          originator: "codex_cli_rs",
        })["openai-beta"] === undefined &&
        catalogHeaders({
          authorization: "Bearer x",
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
          originator: "codex_cli_rs",
        })["content-type"] === undefined,
    );
    check("formatModelBanner marks current", formatModelBanner([{ id: "a" }, { id: "b" }], "b").includes("*b"));
    check(
      "formatCatalogLines names the provider",
      formatCatalogLines(
        [
          { provider: "openai-codex", id: "gpt-5.4" },
          { provider: "anthropic", id: "claude-sonnet-4-5" },
        ],
        "openai-codex",
        "gpt-5.4",
      ).includes("openai-codex") &&
        formatCatalogLines(
          [
            { provider: "openai-codex", id: "gpt-5.4" },
            { provider: "anthropic", id: "claude-sonnet-4-5" },
          ],
          "openai-codex",
          "gpt-5.4",
        ).includes("*") &&
        formatCatalogLines(
          [
            { provider: "openai-codex", id: "gpt-5.4" },
            { provider: "anthropic", id: "claude-sonnet-4-5" },
          ],
          "openai-codex",
          "gpt-5.4",
        ).includes("anthropic"),
    );
    check("catalogFetchAllowed is false under harness", catalogFetchAllowed() === false);
    
    const modelSrv = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        data: [{ id: "claude-sonnet-4-5-20250929" }, { id: "claude-haiku-4-5-20251001" }, { id: "not-a-model" }],
        has_more: false,
      }));
    });
    const modelPort = await new Promise((resolve) => {
      modelSrv.listen(0, "127.0.0.1", () => resolve(modelSrv.address().port));
    });
    const prevModelsUrl = process.env.TERMINA_TEST_MODELS_URL;
    const prevAnth = process.env.ANTHROPIC_API_KEY;
    process.env.TERMINA_TEST_MODELS_URL = `http://127.0.0.1:${modelPort}/`;
    process.env.ANTHROPIC_API_KEY = "test-catalog-key";
    resetAuthCache();
    runLogout("anthropic");
    const live = await loadProviderModels("anthropic");
    check(
      "loadProviderModels uses live list when authenticated",
      live.ok === true && live.models.map((m) => m.id).join(",") === "claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001",
    );
    if (prevModelsUrl === undefined) delete process.env.TERMINA_TEST_MODELS_URL;
    else process.env.TERMINA_TEST_MODELS_URL = prevModelsUrl;
    if (prevAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnth;
    resetAuthCache();
    modelSrv.close();
    
    runLogout("anthropic");
    runLogout("xai");
    modifyProvider("xai", () => ({ type: "oauth", access: "xai-access", refresh: "xai-refresh", expires: Date.now() + 60_000 }));
    const prevAnth2 = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "env-anthropic-leftover";
    resetAuthCache();
    check("hasStoredCredential xai", hasStoredCredential("xai") === true);
    check("hasEnvCredential anthropic", hasEnvCredential("anthropic") === true);
    check("firstAuthenticatedProvider prefers stored over env", firstAuthenticatedProvider() === "xai");
    runLogout("xai");
    resetAuthCache();
    check("firstAuthenticatedProvider falls back to env", firstAuthenticatedProvider() === "anthropic");
    if (prevAnth2 === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnth2;
    resetAuthCache();
    
    const refused = await loadProviderModels("anthropic");
    check("loadProviderModels without catalog url is skipped in tests", refused.ok === false);
    
    process.env.TERMINA_TEST_MODELS_URL = "http://127.0.0.1:1/";
    process.env.ANTHROPIC_API_KEY = "k";
    resetAuthCache();
    runLogout("anthropic");
    const netFail = await loadProviderModels("anthropic");
    check("loadProviderModels network failure is not a throw", netFail.ok === false && typeof netFail.error === "string");
    delete process.env.TERMINA_TEST_MODELS_URL;
    if (prevAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnth;
    resetAuthCache();
    
    const sse = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n'));
        c.close();
      },
    });
    let filteredText = "";
    const sseEvents = await compat.readSseJson(sse, undefined, (event) => {
      filteredText = event.choices?.[0]?.delta?.content ?? "";
      return false;
    });
    check("readSseJson streams and can discard events", filteredText === "Hi" && sseEvents.length === 0);
    check(
      "completion live delta exposes provider thinking",
      compat.completionLiveDelta({ choices: [{ delta: { reasoning_content: "Checking files" } }] })?.thinking === "Checking files" &&
        compat.completionLiveDelta({ choices: [{ delta: { reasoning: "Planning", content: "Done" } }] })?.text === "Done",
    );
    const completionThinking = compat.completionResultFromEvents(
      [{ choices: [{ delta: { reasoning_text: "Plan", content: "" } }] }],
      () => {},
      Date.now(),
    );
    check(
      "completion result keeps provider thinking and first-token time",
      completionThinking.blocks[0]?.type === "thinking" && completionThinking.ttftMs !== null,
    );
    const completionMixed = compat.completionResultFromEvents(
      [{ choices: [{ delta: { reasoning: "Plan", content: "Done" } }] }],
      () => {},
      Date.now(),
    );
    check(
      "completion result keeps thinking and text from one delta",
      completionMixed.blocks[0]?.type === "thinking" && completionMixed.blocks[1]?.type === "text",
    );
    check(
      "responses live delta exposes reasoning summaries",
      compat.responsesLiveDelta({ type: "response.reasoning_summary_text.delta", delta: "Checking files" })?.text === "Checking files" &&
        compat.responsesLiveDelta({ type: "response.reasoning_text.delta", delta: "Planning" })?.kind === "thinking" &&
        compat.responsesLiveDelta({ type: "response.reasoning_summary_part.done" })?.text === "\n\n",
    );
    
    const itemDelta = compat.responsesResultFromEvents(
      [
        { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":"ls"}' },
      ],
      () => {},
      Date.now(),
    );
    check(
      "responses delta item_id attaches to call_id",
      itemDelta.blocks[0]?.type === "tool_use" && itemDelta.blocks[0]?.id === "call_1" && itemDelta.blocks[0]?.name === "bash",
    );
    const failedStream = compat.responsesResultFromEvents(
      [{ type: "response.failed", response: { error: { message: "quota" } } }],
      () => {},
      Date.now(),
    );
    check("responses failed event is an error", failedStream.error === "quota");
    const bodyOpenAI = compat.completionsBody("gpt-5", "sys", [], [], "max_completion_tokens", {
      cacheKey: "abc",
      maxTokens: 16_384,
    });
    check(
      "openai completions uses max_completion_tokens",
      bodyOpenAI.max_completion_tokens === 16_384 && bodyOpenAI.max_tokens === undefined && bodyOpenAI.prompt_cache_key === "abc",
    );
    const bodyXai = compat.completionsBody("grok-4.3", "sys", [], []);
    check("other completions keep max_tokens and skip cache key", bodyXai.max_tokens === 16_384 && bodyXai.prompt_cache_key === undefined);
    const bodyGoogle = compat.completionsBody("gemini-3.7-flash", "sys", [], [], "max_tokens", {
      reasoningEffort: "minimal",
      googleThinking: true,
    });
    check(
      "Google completions request visible thought summaries",
      bodyGoogle.extra_body?.google?.thinking_config?.thinking_level === "minimal" &&
        bodyGoogle.extra_body?.google?.thinking_config?.include_thoughts === true,
    );
    const bodyGlm = compat.completionsBody("glm-5.2", "sys", [], [], "max_tokens", {
      reasoningEffort: "high",
    });
    check(
      "GLM 5.2 completions send reasoning_effort",
      bodyGlm.reasoning_effort === "high" && bodyGlm.extra_body === undefined,
    );
    const bodyCodex = compat.responsesBody("gpt-5.6-sol", "sys", [], [], {
      cacheKey: "def",
      reasoningEffort: "none",
    });
    check(
      "codex responses set cache key and omit unsupported max_output_tokens",
      bodyCodex.prompt_cache_key === "def" && bodyCodex.max_output_tokens === undefined,
    );
    const bodySummary = compat.responsesBody("gpt-5.6-sol", "You compress coding-agent session history. Only output the structured handoff.", [{ role: "user", content: "fold me" }], [], {
      maxTokens: 2048,
      cacheKey: "sess-sum",
      includeEncryptedReasoning: false,
    });
    check(
      "summarize responses stream a list input",
      bodySummary.stream === true &&
        Array.isArray(bodySummary.input) &&
        bodySummary.input[0]?.content?.[0]?.text === "fold me" &&
        typeof bodySummary.input !== "string",
    );
    check("summarize responses omit prompt_cache_options", bodySummary.prompt_cache_options === undefined);
    check("summarize responses omit reasoning.effort none", bodySummary.reasoning === undefined);
    check("summarize responses omit encrypted include", bodySummary.include === undefined);
    const bodySummaryCodex = compat.responsesBody("gpt-5.6-sol", "sys", [{ role: "user", content: "fold" }], [], {
      includeEncryptedReasoning: false,
    });
    check(
      "summarize Codex responses omit max_output_tokens",
      bodySummaryCodex.max_output_tokens === undefined && bodySummaryCodex.stream === true,
    );
    const bodyOrClaude = compat.responsesBody(
      "anthropic/claude-sonnet-5",
      "sys",
      [
        { role: "user", content: "stable" },
        { role: "user", content: "overlay" },
      ],
      [],
      { cacheKey: "sess-1", sessionId: "sess-1", cacheControl: true, includeEncryptedReasoning: false },
    );
    check(
      "openrouter claude responses pin session and cache_control",
      bodyOrClaude.prompt_cache_key === "sess-1" &&
        bodyOrClaude.session_id === "sess-1" &&
        bodyOrClaude.cache_control === undefined &&
        bodyOrClaude.input[0]?.content?.[0]?.cache_control?.type === "ephemeral" &&
        bodyOrClaude.input.at(-1)?.content?.[0]?.cache_control === undefined,
    );
    const bodyGpt56 = compat.responsesBody(
      "gpt-5.6-sol",
      "sys",
      [
        { role: "user", content: "stable history" },
        { role: "user", content: "<working-set>" },
      ],
      [],
      { cacheKey: "sess-2", explicitCacheBreakpoint: true, includeEncryptedReasoning: false },
    );
    const gpt56First = bodyGpt56.input[0]?.content?.[0];
    const gpt56Last = bodyGpt56.input.at(-1)?.content?.[0];
    check(
      "gpt-5.6 breakpoint sits before the overlay",
      gpt56First?.prompt_cache_breakpoint?.mode === "explicit" && gpt56Last?.prompt_cache_breakpoint === undefined,
    );
    check("gpt-5.6 breakpoint-only omits prompt_cache_options", bodyGpt56.prompt_cache_options === undefined);
    const bodyGpt56Explicit = compat.responsesBody(
      "gpt-5.6-sol",
      "sys",
      [
        { role: "user", content: "stable history" },
        { role: "user", content: "<working-set>" },
      ],
      [],
      {
        explicitCacheBreakpoint: true,
        explicitCacheSkipTail: true,
        promptCacheMode: "explicit",
        includeEncryptedReasoning: false,
      },
    );
    check(
      "gpt-5.6 explicit mode disables implicit overlay writes",
      bodyGpt56Explicit.prompt_cache_options?.mode === "explicit" &&
        bodyGpt56Explicit.prompt_cache_options?.ttl === "30m" &&
        bodyGpt56Explicit.input.at(-1)?.content?.[0]?.prompt_cache_breakpoint === undefined,
    );
    const bodyGpt56NoOverlay = compat.responsesBody("gpt-5.6-sol", "sys", [{ role: "user", content: "stable history" }], [], {
      explicitCacheBreakpoint: true,
      explicitCacheSkipTail: false,
      promptCacheMode: "explicit",
      includeEncryptedReasoning: false,
    });
    check(
      "gpt-5.6 without overlay still pins the last user text",
      bodyGpt56NoOverlay.input[0]?.content?.[0]?.prompt_cache_breakpoint?.mode === "explicit",
    );
    const bodyGpt56Assistant = compat.responsesBody(
      "gpt-5.6-sol",
      "sys",
      [
        { role: "assistant", content: "done" },
        { role: "user", content: "<working-set>" },
      ],
      [],
      { explicitCacheBreakpoint: true, includeEncryptedReasoning: false },
    );
    check(
      "gpt-5.6 breakpoint does not mark assistant output_text",
      bodyGpt56Assistant.input[0]?.content?.[0]?.prompt_cache_breakpoint === undefined &&
        bodyGpt56Assistant.input.at(-1)?.content?.[0]?.prompt_cache_breakpoint === undefined,
    );
    const bodyGpt56Solo = compat.responsesBody("gpt-5.6-sol", "sys", [{ role: "user", content: "only overlay" }], [], {
      explicitCacheBreakpoint: true,
      includeEncryptedReasoning: false,
    });
    check(
      "gpt-5.6 breakpoint does not mark a lone overlay",
      bodyGpt56Solo.input[0]?.content?.[0]?.prompt_cache_breakpoint === undefined,
    );
    const stripped = compat.stripResponsesBreakpoints(bodyGpt56Explicit);
    check(
      "stripResponsesBreakpoints removes options and input markers",
      stripped.prompt_cache_options === undefined &&
        stripped.input[0]?.content?.[0]?.prompt_cache_breakpoint === undefined,
    );
    const bodyResponses = compat.responsesBody("gpt-5.6-sol", "sys", [], [], { maxTokens: 32_768, reasoningEffort: "max" });
    check("other responses set max_output_tokens", bodyResponses.max_output_tokens === 32_768);
    check(
      "responses body requests a live reasoning summary",
      bodyResponses.reasoning?.effort === "max" && bodyResponses.reasoning?.summary === "auto",
    );
    check(
      "responses body asks for encrypted reasoning",
      Array.isArray(bodyCodex.include) && bodyCodex.include.includes("reasoning.encrypted_content"),
    );
    check("responses body sets reasoning effort", bodyCodex.reasoning?.effort === "none");
    const bodyGpt56Agent = compat.responsesBody("gpt-5.6-sol", "sys", [], [], {
      reasoningEffort: "medium",
      reasoningContext: "all_turns",
      textVerbosity: "low",
      includeEncryptedReasoning: false,
    });
    check(
      "GPT-5.6 responses keep reasoning across turns and low verbosity",
      bodyGpt56Agent.reasoning?.context === "all_turns" && bodyGpt56Agent.text?.verbosity === "low",
    );
    check("gpt56ReasoningContext sol", gpt56ReasoningContext("gpt-5.6-sol") === "all_turns");
    check("gpt56ReasoningContext grok is omitted", gpt56ReasoningContext("grok-4.6") === undefined);
    check("gpt5TextVerbosity sol is low", gpt5TextVerbosity("gpt-5.6-sol") === "low");
    check("gpt5TextVerbosity pro is omitted", gpt5TextVerbosity("gpt-5.5-pro") === undefined);
    check("gpt5TextVerbosity codex is omitted", gpt5TextVerbosity("gpt-5.3-codex") === undefined);
    const reasoned = compat.toResponsesInput([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan", signature: "enc", id: "rs_1" },
          { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
        ],
      },
    ]);
    check(
      "toResponsesInput round-trips reasoning before the tool call",
      reasoned[0]?.type === "reasoning" &&
        reasoned[0]?.id === "rs_1" &&
        reasoned[0]?.encrypted_content === "enc" &&
        reasoned[0]?.summary?.[0]?.text === "plan" &&
        reasoned[1]?.type === "function_call",
    );
    check("responses tools are non-strict", compat.toResponsesTools([{ name: "bash", description: "b", input_schema: { type: "object" } }])[0]?.strict === false);
    check(
      "toResponsesInput drops thinking without encrypted content",
      compat.toResponsesInput([{ role: "assistant", content: [{ type: "thinking", thinking: "plan", id: "rs_x" }] }]).length === 0,
    );
    const interleaved = compat.toResponsesInput([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a", signature: "s1", id: "rs_a" },
          { type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } },
          { type: "thinking", thinking: "b", signature: "s2", id: "rs_b" },
          { type: "tool_use", id: "c2", name: "bash", input: { command: "pwd" } },
        ],
      },
    ]);
    check(
      "toResponsesInput keeps interleaved reasoning and tool calls",
      interleaved.map((x) => x.type || x.role).join(",") === "reasoning,function_call,reasoning,function_call" &&
        interleaved[1]?.call_id === "c1" &&
        interleaved[3]?.call_id === "c2",
    );
    const orphanTest = compat.toResponsesInput([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_9uC6HZkBPZk6cPwVyuGR4IwC", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: "next prompt",
      },
    ]);
    check(
      "toResponsesInput flushes missing tool output before next user turn",
      orphanTest[1]?.type === "function_call_output" &&
        orphanTest[1]?.call_id === "call_9uC6HZkBPZk6cPwVyuGR4IwC" &&
        orphanTest[2]?.role === "user",
    );
    const partialAnswer = compat.toResponsesInput([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_A", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "call_B", name: "bash", input: { command: "pwd" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_A", content: "file.txt" }],
      },
    ]);
    check(
      "toResponsesInput flushes unanswered parallel tool calls even without user text",
      partialAnswer.length === 4 &&
        partialAnswer[0]?.call_id === "call_A" &&
        partialAnswer[1]?.call_id === "call_B" &&
        partialAnswer[2]?.call_id === "call_A" &&
        partialAnswer[2]?.output === "file.txt" &&
        partialAnswer[3]?.call_id === "call_B" &&
        partialAnswer[3]?.output === "(interrupted)",
    );
    const deltaThenDone = compat.responsesResultFromEvents(
      [
        {
          type: "response.function_call_arguments.delta",
          item_id: "item_9",
          delta: '{"command":',
        },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "item_9", call_id: "call_9uC6HZkBPZk6cPwVyuGR4IwC", name: "bash", arguments: '{"command":"ls"}' },
        },
      ],
      () => {},
      Date.now(),
    );
    check(
      "responses result updates call_id over item_id from delta",
      deltaThenDone.blocks[0]?.type === "tool_use" &&
        deltaThenDone.blocks[0]?.id === "call_9uC6HZkBPZk6cPwVyuGR4IwC",
    );
    const doneOnly = compat.responsesResultFromEvents(
      [
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_9", call_id: "call_9", name: "bash", arguments: '{"command":"pwd"}' },
        },
      ],
      () => {},
      Date.now(),
    );
    check(
      "responses result reads a function call from output_item.done",
      doneOnly.blocks[0]?.type === "tool_use" && doneOnly.blocks[0]?.id === "call_9" && doneOnly.blocks[0]?.input?.command === "pwd",
    );
    const xaiBody = compat.responsesBody("grok-4.6", "sys", [], [], { includeEncryptedReasoning: false, reasoningEffort: "low" });
    check("xai responses omit encrypted include", xaiBody.include === undefined && xaiBody.reasoning?.effort === "low");
    const reasonedOut = compat.responsesResultFromEvents(
      [
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_9",
            encrypted_content: "blob",
            summary: [{ type: "summary_text", text: "why" }],
          },
        },
        { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":"ls"}' },
      ],
      () => {},
      Date.now(),
    );
    check(
      "responses result keeps reasoning then the tool call",
      reasonedOut.blocks[0]?.type === "thinking" &&
        reasonedOut.blocks[0]?.signature === "blob" &&
        reasonedOut.blocks[0]?.id === "rs_9" &&
        reasonedOut.blocks[1]?.type === "tool_use",
    );
    
    check(
      "resolveSessionFile ignores a flat override",
      resolveSessionFile("/events", "term-1", "/tmp/sess.jsonl") === join("/events", "term-1", "current", "session.jsonl"),
    );
    check(
      "resolveSessionFile derives the bundle path",
      resolveSessionFile("/events", "term-1") === join("/events", "term-1", "current", "session.jsonl"),
    );
    check(
      "resolveSessionFile accepts a matching bundle override",
      resolveSessionFile("/events", "term-1", "/proj/term-1/current/session.jsonl") === "/proj/term-1/current/session.jsonl",
    );
    check("resolveSessionFile rejects an invalid session id", resolveSessionFile("/events", "../evil") === null);
    check("isCoreSessionBundleFile rejects a flat file", isCoreSessionBundleFile("/tmp/core-abc.jsonl") === false);
    check("isCoreSessionBundleFile accepts a bundle path", isCoreSessionBundleFile("/proj/core-abc/current/session.jsonl") === true);
    check("isCoreSessionId rejects a parent segment", isCoreSessionId("..") === false);
    check("MAX_SESSION_SEGMENT_BYTES is 8 MiB", MAX_SESSION_SEGMENT_BYTES === 8 * 1024 * 1024);
    check("MAX_SESSION_RECORD_BYTES is 1 MiB", MAX_SESSION_RECORD_BYTES === 1 * 1024 * 1024);
    
    const mcp = await import("../../../agent-core/mcp.ts");
    check("KERNEL_TOOL_NAMES includes fetch", mcp.KERNEL_TOOL_NAMES.has("fetch"));
    check("mcpToolName prefixes server and tool", mcp.mcpToolName("github", "list_issues") === "mcp_github_list_issues");
    check("mcpToolName stays within 64 chars", mcp.mcpToolName("very-long-server-name-here", "very_long_tool_name_that_exceeds").length <= 64);
    check(
      "selectMcpTools prefixes kernel-like names and drops duplicates",
      mcp.selectMcpTools([{ name: "bash", description: "nope", input_schema: {}, server: "x", original: "bash" }])[0]?.name === "mcp_x_bash" &&
        mcp.selectMcpTools([
          { name: "echo", description: "echo", input_schema: {}, server: "x", original: "echo" },
          { name: "echo", description: "echo", input_schema: {}, server: "x", original: "echo" },
        ]).length === 1,
    );
    const manyMcpTools = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: "x".repeat(1000),
      input_schema: { type: "object", description: "y".repeat(7000) },
      server: "large",
      original: `tool_${i}`,
    }));
    check("MCP tool schemas have one total budget", mcp.selectMcpTools(manyMcpTools).length < manyMcpTools.length);
    check(
      "parseMcpConfig skips disabled servers",
      mcp.parseMcpConfig({
        mcpServers: {
          gh: { command: "npx", args: ["-y", "x"] },
          off: { command: "npx", disabled: true },
        },
      }).map((s) => s.name).join(",") === "gh",
    );
    check(
      "parseMcpConfig keeps https MCP servers",
      mcp.parseMcpConfig({
        mcpServers: { web: { type: "http", url: "https://example.com/mcp" } },
      }).map((s) => s.name).join(",") === "web",
    );
    check(
      "parseMcpConfig prefers a URL over a command",
      mcp.parseMcpConfig({
        mcpServers: { gh: { command: "npx", args: ["-y", "x"], url: "https://github.com/mcp" } },
      })[0]?.url === "https://github.com/mcp" &&
        mcp.parseMcpConfig({
          mcpServers: { gh: { command: "npx", args: ["-y", "x"], url: "https://github.com/mcp" } },
        })[0]?.command === undefined,
    );
    check("mcpHttpUrlError rejects http", mcp.mcpHttpUrlError("http://example.com/mcp")?.includes("https"));
    check("mcpHttpUrlError rejects file", mcp.mcpHttpUrlError("file:///tmp/x")?.includes("scheme"));
    check("mcpHttpUrlError allows https", mcp.mcpHttpUrlError("https://example.com/mcp") === null);
    check("parseMcpConfig drops a non-https MCP URL", mcp.parseMcpConfig({ mcpServers: { web: { type: "http", url: "http://example.com" } } }).length === 0);
    const httpHdrs = mcp.parseMcpConfig({
      mcpServers: {
        web: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer x", "mcp-session-id": "evil", "mcp-protocol-version": "0", Accept: "text/plain" },
        },
      },
    })[0]?.headers ?? {};
    check(
      "parseMcpConfig skips hop-by-hop and session MCP headers",
      httpHdrs.Authorization === "Bearer x" &&
        httpHdrs["mcp-session-id"] === undefined &&
        httpHdrs["mcp-protocol-version"] === undefined &&
        httpHdrs.Accept === undefined,
    );
    check("jailMcpCwd rejects a parent path", mcp.jailMcpCwd("/proj", "..") === null);
    check("jailMcpCwd allows a subdir", mcp.jailMcpCwd("/proj", "tools") === join("/proj", "tools"));
    const mcpMerged = mcp.mergeClientTools(
      [{ name: "bash", description: "bash", input_schema: { type: "object" } }],
      [{ name: "mcp_x_echo", description: "echo", input_schema: { type: "object" } }],
    );
    const mcpPrefix = buildCachedPrefix("sys", mcpMerged);
    check(
      "MCP tools sit in the cached client list",
      mcpPrefix.tools.some((t) => t.name === "mcp_x_echo") && mcpPrefix.tools.at(-1)?.name === "mcp_x_echo" && mcpPrefix.tools.at(-1)?.cache_control?.type === "ephemeral",
    );
    const mcpRequested = requestTools(mcpPrefix.tools, "anthropic");
    check(
      "web_search stays last and uncached after MCP tools",
      mcpRequested.at(-1)?.name === "web_search" && mcpRequested.at(-1)?.cache_control === undefined && mcpRequested.at(-2)?.name === "mcp_x_echo",
    );
    const mcpDir = mkdtempSync(join(tmpdir(), "agent-core-mcp-"));
    leftovers.push(mcpDir);
    const mcpUser = join(mcpDir, "user.json");
    const mcpProj = join(mcpDir, "proj.json");
    writeFileSync(mcpUser, JSON.stringify({ mcpServers: { gh: { command: "npx" }, keep: { command: "npx" } } }));
    writeFileSync(mcpProj, JSON.stringify({ mcpServers: { gh: { command: "npx", disabled: true } } }));
    check(
      "MCP loads only the user-owned config",
      mcp.loadMcpConfigs(mcpUser).map((s) => s.name).join(",") === "gh,keep",
    );
    check("project MCP config is not an executable source", mcp.projectMcpPath === undefined);
    const mcpJail = mkdtempSync(join(tmpdir(), "agent-core-mcp-jail-"));
    leftovers.push(mcpJail);
    try {
      symlinkSync("/tmp", join(mcpJail, "out"));
      check("jailMcpCwd rejects a symlink out of the project", mcp.jailMcpCwd(mcpJail, "out") === null);
    } catch (err) {
      check("jailMcpCwd rejects a symlink out of the project", false, err instanceof Error ? err.message : String(err));
    }
    const echoServer = join(mcpDir, "echo-mcp.mjs");
    writeFileSync(
      echoServer,
      `process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let n;
      while ((n = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, n);
        buf = buf.slice(n + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo" } } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } }) + "\\n");
        } else if (msg.method === "tools/call") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] } }) + "\\n");
        }
      }
    });
    `,
    );
    const liveMcp = await mcp.startMcp(
      [{ name: "echo", command: process.execPath, args: [echoServer], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    check("mcp handshake lists the echo tool", liveMcp.tools[0]?.name === "mcp_echo_echo" && liveMcp.notes.length === 0);
    const echoed = await liveMcp.call("mcp_echo_echo", { text: "hello-mcp" });
    check("mcp tools/call round-trips", echoed.isError === false && echoed.content === "hello-mcp");
    liveMcp.shutdown();
    const hangServer = join(mcpDir, "hang-mcp.mjs");
    writeFileSync(
      hangServer,
      `process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let n;
      while ((n = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, n);
        buf = buf.slice(n + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hang" } } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "hang", description: "hang", inputSchema: { type: "object" } }] } }) + "\\n");
        }
      }
    });
    `,
    );
    const hangMcp = await mcp.startMcp(
      [{ name: "hang", command: process.execPath, args: [hangServer], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    const tHang = Date.now();
    const interruptedCall = await hangMcp.call("mcp_hang_hang", {}, { shouldStop: () => true });
    check("mcp interrupt returns quickly", Date.now() - tHang < 2000 && interruptedCall.isError === true && interruptedCall.content.includes("interrupted"));
    const afterInterrupt = await hangMcp.call("mcp_hang_hang", {});
    check("mcp interrupt kills the server", afterInterrupt.isError === true);
    hangMcp.shutdown();
    const timeoutMcp = await mcp.startMcp(
      [{ name: "hang", command: process.execPath, args: [hangServer], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    const timed = await timeoutMcp.call("mcp_hang_hang", {}, { timeoutMs: 200, shouldStop: () => false });
    check("mcp call timeout kills the server", timed.isError === true && timed.content.includes("timed out"));
    const afterKill = await timeoutMcp.call("mcp_hang_hang", {});
    check("mcp call after timeout sees a dead server", afterKill.isError === true);
    timeoutMcp.shutdown();
    const deadMcp = await mcp.startMcp(
      [{ name: "gone", command: join(mcpDir, "missing-bin"), args: [], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    check("mcp spawn failure does not throw", deadMcp.tools.length === 0 && deadMcp.notes.some((n) => n.includes("gone")));
    deadMcp.shutdown();
    
    const crashServer = join(mcpDir, "crash-server.mjs");
    writeFileSync(crashServer, "process.exit(1);\n", "utf8");
    const crashMcp = await mcp.startMcp(
      [{ name: "crash", command: process.execPath, args: [crashServer], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    const crashedCall = await crashMcp.call("mcp_crash_test", {});
    check("crashed mcp call fails cleanly without unhandled exception", crashedCall.isError === true);
    crashMcp.shutdown();
    
    const httpStub = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let msg = {};
        try {
          msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.statusCode = 400;
          res.end("{}");
          return;
        }
        res.setHeader("mcp-session-id", "sess-1");
        const path = String(req.url ?? "");
        if (path.includes("hang") && msg.method === "tools/call") return;
        const sse = path.includes("sse");
        const body =
          msg.method === "initialize"
            ? { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http-echo" } } }
            : msg.method === "tools/list"
              ? { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } }
              : msg.method === "tools/call"
                ? { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] } }
                : { jsonrpc: "2.0", id: msg.id, result: {} };
        if (sse) {
          res.setHeader("content-type", "text/event-stream");
          res.end(`event: message\r\ndata: ${JSON.stringify(body)}\r\n\r\n`);
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((resolve) => httpStub.listen(0, "127.0.0.1", resolve));
    const httpPort = httpStub.address().port;
    const httpMcp = await mcp.startMcp(
      [{ name: "httpecho", url: `http://127.0.0.1:${httpPort}/mcp`, args: [], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    check("http mcp handshake lists the echo tool", httpMcp.tools[0]?.name === "mcp_httpecho_echo" && httpMcp.notes.length === 0);
    const httpEchoed = await httpMcp.call("mcp_httpecho_echo", { text: "hello-http" });
    check("http mcp tools/call round-trips", httpEchoed.isError === false && httpEchoed.content === "hello-http");
    httpMcp.shutdown();
    const sseMcp = await mcp.startMcp(
      [{ name: "sssecho", url: `http://127.0.0.1:${httpPort}/sse`, args: [], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    const sseEchoed = await sseMcp.call("mcp_sssecho_echo", { text: "hello-sse" });
    check("sse mcp tools/call round-trips", sseEchoed.isError === false && sseEchoed.content === "hello-sse");
    sseMcp.shutdown();
    const hangHttpMcp = await mcp.startMcp(
      [{ name: "httphang", url: `http://127.0.0.1:${httpPort}/hang`, args: [], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    const tHttpHang = Date.now();
    const httpInterrupted = await hangHttpMcp.call("mcp_httphang_echo", { text: "x" }, { shouldStop: () => true });
    check(
      "http mcp interrupt returns quickly",
      Date.now() - tHttpHang < 2000 && httpInterrupted.isError === true && httpInterrupted.content.includes("interrupted"),
    );
    hangHttpMcp.shutdown();
    const blockedHttp = await mcp.startMcp(
      [{ name: "evilhttp", url: "http://example.com/mcp", args: [], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    check(
      "http mcp rejects non-loopback http at start",
      blockedHttp.tools.length === 0 && blockedHttp.notes.some((n) => n.includes("https")),
    );
    blockedHttp.shutdown();
    const redirStub = createServer((req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://127.0.0.1/steal");
      res.end("moved");
    });
    await new Promise((resolve) => redirStub.listen(0, "127.0.0.1", resolve));
    const redirPort = redirStub.address().port;
    const redirMcp = await mcp.startMcp(
      [{ name: "redir", url: `http://127.0.0.1:${redirPort}/mcp`, args: [], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    check(
      "http mcp does not follow redirects",
      redirMcp.tools.length === 0 && redirMcp.notes.some((n) => n.includes("HTTP 302")),
    );
    redirMcp.shutdown();
    redirStub.close();
    const hugeStub = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(`${"x".repeat(300 * 1024)}`);
    });
    await new Promise((resolve) => hugeStub.listen(0, "127.0.0.1", resolve));
    const hugePort = hugeStub.address().port;
    const hugeMcp = await mcp.startMcp(
      [{ name: "huge", url: `http://127.0.0.1:${hugePort}/mcp`, args: [], env: {} }],
      { projectRoot: mcpDir, confineCwd: (cwd) => mcp.jailMcpCwd(mcpDir, cwd) },
    );
    check(
      "http mcp caps the response body",
      hugeMcp.tools.length === 0 && hugeMcp.notes.some((n) => n.includes("too large")),
    );
    hugeMcp.shutdown();
    hugeStub.close();
    httpStub.close();
    writeFileSync(join(mcpDir, "bad.json"), "{not json");
    check("invalid mcp json loads as no servers", mcp.parseMcpConfig(null).length === 0 && mcp.loadMcpConfigs(join(mcpDir, "bad.json")).length === 0);
    
    const rosterMod = await import("../../../electron/terminal-roster.ts");
    check("parseTerminalRoster empty", rosterMod.parseTerminalRoster(null).length === 0);
    check(
      "parseTerminalRoster keeps engine and session",
      rosterMod.parseTerminalRoster({
        terminals: [{ id: "term-2", type: "agent", engine: "core", sessionId: "core-abc", sessionFile: "/tmp/core-abc.jsonl" }],
      })[0]?.engine === "core" &&
        rosterMod.parseTerminalRoster({
          terminals: [{ id: "term-2", type: "agent", engine: "core", sessionId: "core-abc", sessionFile: "/tmp/core-abc.jsonl" }],
        })[0]?.sessionId === "core-abc",
    );
    check("parseTerminalRoster drops dispatch-like ids", rosterMod.parseTerminalRoster([{ id: "job-1", type: "agent", engine: "pi" }]).length === 0);
    check("parseTerminalRoster defaults agent engine to core", rosterMod.parseTerminalRoster([{ id: "term-1", type: "agent" }])[0]?.engine === "core");
    check(
      "parseTerminalRoster drops obsolete core sessionFile values",
      rosterMod.parseTerminalRoster([{ id: "term-1", type: "agent", engine: "core", sessionFile: "/tmp/core-flat.jsonl" }])[0]?.sessionFile == null,
    );
    check(
      "parseTerminalRoster drops duplicate ids",
      rosterMod.parseTerminalRoster([
        { id: "term-1", type: "agent", engine: "core" },
        { id: "term-1", type: "agent", engine: "pi" },
      ]).length === 1,
    );
    check(
      "parseTerminalRoster drops sessionId with slash",
      rosterMod.parseTerminalRoster([{ id: "term-1", type: "agent", sessionId: "a/b" }])[0]?.sessionId == null,
    );
    check("isCoreSessionId rejects parent segment", isCoreSessionId("..") === false);
    check("isCoreSessionId accepts uuid form", isCoreSessionId("core-11111111-1111-1111-1111-111111111111") === true);
    const liveRoster = [{ id: "term-3", type: "agent", engine: "core" }];
    const unrestoredRoster = [
      { id: "term-1", type: "agent", engine: "pi" },
      { id: "term-3", type: "agent", engine: "pi" },
    ];
    const composed = rosterMod.composeTerminalRoster(liveRoster, unrestoredRoster);
    check("composeTerminalRoster prefers live id", composed[0]?.id === "term-3" && composed[0]?.engine === "core");
    check("composeTerminalRoster keeps unrestored sibling", composed[1]?.id === "term-1" && composed.length === 2);
    const manyLive = Array.from({ length: 20 }, (_, i) => ({ id: `term-${i + 1}`, type: "agent", engine: "pi" }));
    check("composeTerminalRoster caps at 16", rosterMod.composeTerminalRoster(manyLive, []).length === rosterMod.MAX_TERMINAL_ROSTER);
    
    const rotFixed = new Date(2026, 7, 26, 15, 4, 5).getTime();
    check("sessionRotateStamp is filesystem-safe", sessionRotateStamp(rotFixed) === "2026-08-26T15-04-05");
    
    const searchMod = await import("../../../electron/session-search.ts");
    const piLine = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "created compute in `utils.ts`" },
          { type: "toolCall", name: "write", arguments: { path: "utils.ts" } },
        ],
      },
    });
    const coreLine = JSON.stringify({
      storageSeq: 2,
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "edited greeting" },
          { type: "thinking", text: "secret" },
          { type: "tool_use", id: "1", name: "edit", input: { path: "greeting.ts", old_text: "a", new_text: "b" } },
        ],
      },
    });
    const usageLine = JSON.stringify({ storageSeq: 3, type: "usage", input: 1 });
    const piParsed = searchMod.parseSessionMessageLine(piLine);
    const coreParsed = searchMod.parseSessionMessageLine(coreLine);
    check("parse Pi toolCall extracts the path", piParsed?.role === "assistant" && piParsed.text.includes("compute") && piParsed.paths.includes("utils.ts"));
    check(
      "parse core tool_use extracts the path and skips thinking",
      coreParsed?.role === "assistant" &&
        coreParsed.text.includes("edited greeting") &&
        coreParsed.text.includes("[edit]") &&
        !coreParsed.text.includes("secret") &&
        coreParsed.paths.includes("greeting.ts"),
    );
    check("parse skips usage records", searchMod.parseSessionMessageLine(usageLine) === null);
    const toolResultLine = JSON.stringify({
      storageSeq: 4,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "compute output" }] }],
      },
    });
    check(
      "parse core tool_result arrays",
      searchMod.parseSessionMessageLine(toolResultLine)?.text.includes("compute output") === true,
    );
    check("sessionTimestampFromName reads a rotate suffix", searchMod.sessionTimestampFromName("core-aaaa-2026-08-26T15-04-05.jsonl") === rotFixed);
    const merged = searchMod.mergeSessionFiles([
      [
        { path: "/s/a.jsonl", name: "a.jsonl", mtimeMs: 10 },
        { path: "/s/b.jsonl", name: "b.jsonl", mtimeMs: 20 },
      ],
      [{ path: "/s/a.jsonl", name: "a.jsonl", mtimeMs: 10 }],
    ]);
    check("mergeSessionFiles drops duplicate paths and sorts newest first", merged.length === 2 && merged[0]?.path === "/s/b.jsonl");
    
    const searchDir = mkdtempSync(join(tmpdir(), "agent-core-search-"));
    leftovers.push(searchDir);
    writeFileSync(join(searchDir, "utils.ts"), "export function compute() {}\n");
    writeFileSync(join(searchDir, "greeting.ts"), "export const greeting = 'hi';\n");
    const coreJsonl = join(searchDir, "core-bbbb.jsonl");
    writeFileSync(
      coreJsonl,
      [
        JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "add compute" } }),
        coreLine,
      ].join("\n") + "\n",
    );
    const searchHits = await searchMod.searchSessionFiles({
      query: "compute",
      files: [{ path: coreJsonl, name: "core-bbbb.jsonl", mtimeMs: 1 }],
      projectCwd: searchDir,
      canonicalize: (p) => p,
      isProjectFile: (rel) => rel === "utils.ts" || rel === "greeting.ts",
    });
    check("search finds a core user line", searchHits.some((h) => h.text.includes("add compute") && h.sessionFile === "core-bbbb.jsonl"));
    const greetingHits = await searchMod.searchSessionFiles({
      query: "greeting",
      files: [{ path: coreJsonl, name: "core-bbbb.jsonl", mtimeMs: 1 }],
      projectCwd: searchDir,
      canonicalize: (p) => p,
      isProjectFile: (rel) => rel === "utils.ts" || rel === "greeting.ts",
    });
    check("search resolves a core edit path", greetingHits.some((h) => h.filePath === "greeting.ts"));
    
    const logicalDir = join(searchDir, "core-logical", "current");
    mkdirSync(logicalDir, { recursive: true, mode: 0o700 });
    const logicalPart = join(logicalDir, "part-000001.jsonl");
    const logicalActive = join(logicalDir, "session.jsonl");
    writeFileSync(
      logicalPart,
      `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "assistant", content: "context from the first segment" } })}\n`,
    );
    writeFileSync(
      logicalActive,
      `${JSON.stringify({ storageSeq: 2, type: "message", message: { role: "user", content: "compute in the active segment" } })}\n`,
    );
    const logicalHits = await searchMod.searchSessionFiles({
      query: "compute",
      files: [{ path: logicalActive, name: "core-logical/current/session.jsonl", mtimeMs: 2, segments: [logicalPart, logicalActive] }],
      projectCwd: searchDir,
      canonicalize: (p) => p,
      isProjectFile: () => false,
    });
    check(
      "search treats bundle segments as one logical session",
      logicalHits.length === 1 &&
        logicalHits[0]?.sessionFile === "core-logical/current/session.jsonl" &&
        logicalHits[0]?.line === 2 &&
        logicalHits[0]?.before.includes("first segment"),
    );
    const cancelledLogicalHits = await searchMod.searchSessionFiles({
      query: "compute",
      files: [{ path: logicalActive, name: "core-logical/current/session.jsonl", mtimeMs: 2, segments: [logicalPart, logicalActive] }],
      projectCwd: searchDir,
      canonicalize: (p) => p,
      isProjectFile: () => false,
      shouldStop: () => true,
    });
    check("logical session search honors cancellation", cancelledLogicalHits.length === 0);
    
    const rolloverDir = join(searchDir, "core-rollover", "current");
    mkdirSync(rolloverDir, { recursive: true, mode: 0o700 });
    const rolloverActive = join(rolloverDir, "session.jsonl");
    writeFileSync(
      rolloverActive,
      Array.from({ length: 300 }, (_, i) =>
        JSON.stringify({ storageSeq: i + 1, type: "message", message: { role: "user", content: i === 10 ? "unique rollover needle" : `row ${i}` } }),
      ).join("\n") + "\n",
    );
    let rolloverChecks = 0;
    let rolledDuringSearch = false;
    const rolloverHits = await searchMod.searchSessionFiles({
      query: "rollover needle",
      files: [{ path: rolloverActive, name: "core-rollover/current/session.jsonl", mtimeMs: 3, segments: [rolloverActive] }],
      projectCwd: searchDir,
      canonicalize: (p) => p,
      isProjectFile: () => false,
      shouldStop: () => {
        rolloverChecks++;
        if (!rolledDuringSearch && rolloverChecks === 100) {
          renameSync(rolloverActive, join(rolloverDir, "part-000001.jsonl"));
          writeFileSync(rolloverActive, "");
          rolledDuringSearch = true;
        }
        return false;
      },
    });
    check(
      "logical session search retries a live rollover without duplicate hits",
      rolledDuringSearch && rolloverHits.length === 1,
      JSON.stringify({ rolledDuringSearch, rolloverChecks, hits: rolloverHits.map((hit) => ({ line: hit.line, text: hit.text })) }),
    );
    
    const appendDir = join(searchDir, "core-append", "current");
    mkdirSync(appendDir, { recursive: true, mode: 0o700 });
    const appendActive = join(appendDir, "session.jsonl");
    writeFileSync(appendActive, `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "stable append needle" } })}\n`);
    let appendChecks = 0;
    const appendHits = await searchMod.searchSessionFiles({
      query: "append needle",
      files: [{ path: appendActive, name: "core-append/current/session.jsonl", mtimeMs: 4, segments: [appendActive] }],
      projectCwd: searchDir,
      canonicalize: (p) => p,
      isProjectFile: () => false,
      shouldStop: () => {
        appendChecks++;
        writeFileSync(
          appendActive,
          `${JSON.stringify({ storageSeq: appendChecks + 1, type: "checkpoint" })}\n`,
          { flag: "a" },
        );
        return false;
      },
    });
    check("ordinary active appends do not discard logical-session hits", appendChecks > 0 && appendHits.length === 1);
    check("slash menu puts help first", SLASH_COMMANDS[0]?.name === "/help");
    check("slash menu puts exit last", SLASH_COMMANDS.at(-1)?.name === "/exit");
    check("slash /clear is listed", SLASH_COMMANDS.some((c) => c.name === "/clear"));
    check("slash /compact is listed", SLASH_COMMANDS.some((c) => c.name === "/compact"));
    check("slash /effort is listed", SLASH_COMMANDS.some((c) => c.name === "/effort"));
    check(
      "slash /effort lists the full default range",
      matchingSlashCommands("/effort").map((c) => c.name).join(" ") === "off minimal low medium high xhigh max",
    );
    check("slash /effort x matches xhigh", matchingSlashCommands("/effort x")[0]?.submit === "/effort xhigh");
    check("parseEffortCommand missing is null", parseEffortCommand("/model") === null);
    check("parseEffortCommand bare shows", parseEffortCommand("/effort")?.show === true);
    check("parseEffortCommand max", parseEffortCommand("/effort max")?.effort === "max");
    check("parseEffortCommand xhigh", parseEffortCommand("/effort xhigh")?.effort === "xhigh");
    check("parseEffortCommand rejects junk", typeof parseEffortCommand("/effort ultra")?.error === "string");
    check(
      "gpt 5.6 exposes its direct API levels",
      supportedEffortLevels("openai", "gpt-5.6-sol").join(" ") === "off low medium high xhigh max",
    );
    check(
      "gpt 5.4 exposes xhigh but not minimal or max",
      supportedEffortLevels("openai", "gpt-5.4").join(" ") === "off low medium high xhigh",
    );
    check(
      "Codex GPT 5.6 keeps its mapped minimal level",
      supportedEffortLevels("openai-codex", "gpt-5.6-sol").join(" ") === "off minimal low medium high xhigh max",
    );
    check(
      "claude opus 4.6 exposes max but not xhigh",
      supportedEffortLevels("anthropic", "claude-opus-4-6").join(" ") === "off minimal low medium high max",
    );
    check(
      "claude sonnet 5 exposes xhigh and max",
      supportedEffortLevels("anthropic", "claude-sonnet-5").join(" ") === "off minimal low medium high xhigh max",
    );
    check(
      "legacy claude omits extended effort",
      supportedEffortLevels("anthropic", "claude-sonnet-4-5").join(" ") === "off minimal low medium high",
    );
    check(
      "OpenRouter Claude exposes model effort",
      supportedEffortLevels("openrouter", "anthropic/claude-sonnet-4.6").join(" ") === "off minimal low medium high max",
    );
    check(
      "OpenRouter Claude dot versions expose extended effort",
      supportedEffortLevels("openrouter", "anthropic/claude-opus-4.7").join(" ") === "off minimal low medium high xhigh max",
    );
    check(
      "OpenRouter Gemini exposes model effort",
      supportedEffortLevels("openrouter", "google/gemini-3.7-flash").join(" ") === "off minimal low medium high",
    );
    check("unsupported max clamps down to xhigh", clampEffortLevel("openai", "gpt-5.4", "max") === "xhigh");
    check("grok off clamps up to low", clampEffortLevel("xai", "grok-4.6", "off") === "low");
    check("thinkingEnabledFor default off", thinkingEnabledFor("anthropic", "claude-sonnet-5", "off") === false);
    check("thinkingEnabledFor sonnet high", thinkingEnabledFor("anthropic", "claude-sonnet-5", "high") === true);
    check("thinkingEnabledFor haiku supports effort", thinkingEnabledFor("anthropic", "claude-haiku-4-5", "high") === true);
    check("thinkingEnabledFor gpt high", thinkingEnabledFor("openai", "gpt-5.6-sol", "high") === true);
    check("GitHub GPT reasoning cannot turn off", clampEffortLevel("github-copilot", "gpt-5.6-terra", "off") === "minimal");
    check("thinkingEnabledFor Gemini 3", thinkingEnabledFor("google", "gemini-3.7-flash", "high") === true);
    check(
      "Gemini 3.7 Flash omits unsupported minimal",
      supportedEffortLevels("google", "gemini-3.7-flash").join(" ") === "low medium high",
    );
    check(
      "Gemini 3.1 Pro keeps medium",
      supportedEffortLevels("google", "gemini-3.1-pro").join(" ") === "low medium high",
    );
    check("unsupported Gemini 2.5 stays off", thinkingEnabledFor("google", "gemini-2.5-flash", "high") === false);
    check("thinkingEnabledFor gpt 4 stays off", thinkingEnabledFor("openai", "gpt-4.1", "high") === false);
    check("thinkingEnabledFor fable stays on", thinkingEnabledFor("anthropic", "claude-fable-5", "off") === true);
    check("reasoningEffortFor gpt off is none", reasoningEffortFor("openai", "gpt-5.6-sol", "off") === "none");
    check("reasoningEffortFor gpt minimal maps low", reasoningEffortFor("openai", "gpt-5.6-sol", "minimal") === "low");
    check("reasoningEffortFor gpt max stays max", reasoningEffortFor("openai", "gpt-5.6-sol", "max") === "max");
    check("reasoningEffortFor grok off is low", reasoningEffortFor("xai", "grok-4.6", "off") === "low");
    check("reasoningEffortFor o-series off is low", reasoningEffortFor("openai", "o3", "off") === "low");
    check("reasoningEffortFor direct Claude is omitted", reasoningEffortFor("anthropic", "claude-sonnet-5", "high") === undefined);
    check(
      "reasoningEffortFor OpenRouter Claude is sent",
      reasoningEffortFor("openrouter", "anthropic/claude-sonnet-4.6", "high") === "high",
    );
    check("defaultContextWindow anthropic is 1M", defaultContextWindow("anthropic", "claude-sonnet-5") === 1_000_000);
    check("defaultContextWindow haiku is 200k", defaultContextWindow("anthropic", "claude-haiku-4-5") === 200_000);
    check("defaultContextWindow openai is 1.05M", defaultContextWindow("openai", "gpt-5.6-sol") === 1_050_000);
    check("defaultContextWindow xai is 500k", defaultContextWindow("xai", "grok-4.6") === 500_000);
    check("defaultContextWindow zen grok is 500k", defaultContextWindow("opencode-zen", "grok-4.6") === 500_000);
    check("includeEncryptedReasoning skips xai", includeEncryptedReasoning("xai", "grok-4.6") === false);
    check("includeEncryptedReasoning skips zen grok", includeEncryptedReasoning("opencode-zen", "grok-4.6") === false);
    check("includeEncryptedReasoning keeps openai", includeEncryptedReasoning("openai", "gpt-5.6-sol") === true);
    check("reclaim estimate is conservative", estimateReclaimTokens("abcd") === 1);
    const usageIndicators = formatUsageIndicators(
      { input: 500, cacheRead: 1_000, cacheWrite: 0, output: 250 },
      20_000,
      200_000,
      0.0123,
    );
    check(
      "usage indicators show tokens, cache, context, and cost",
      usageIndicators === "tokens 1.5K in/250 out · cache 67% · context ~20K/200K 10% · last $0.0123",
    );
    check(
      "usage indicators handle unknown and invalid values",
      formatUsageIndicators({ input: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: -1, output: -2 }, Number.NaN, Number.POSITIVE_INFINITY, Number.NaN) ===
        "tokens ? in/? out · cache -- · context ~0/1 0%",
    );
    check("outputTokenBudget off is output cap", outputTokenBudget({ thinking: false }) === 16_384);
    check("outputTokenBudget on is a single cap", outputTokenBudget({ thinking: true }) === 64_000);
    check(
      "thinkingRequestFor sonnet 5 off is disabled",
      JSON.stringify(thinkingRequestFor("anthropic", "claude-sonnet-5", "off")) === JSON.stringify({ type: "disabled" }),
    );
    check(
      "thinkingRequestFor sonnet 5 high is adaptive",
      JSON.stringify(thinkingRequestFor("anthropic", "claude-sonnet-5", "high")) ===
        JSON.stringify({ type: "adaptive", display: "summarized" }),
    );
    check("adaptive sonnet 5 keeps xhigh", adaptiveEffortFor("anthropic", "claude-sonnet-5", "xhigh") === "xhigh");
    check("adaptive sonnet 5 keeps max", adaptiveEffortFor("anthropic", "claude-sonnet-5", "max") === "max");
    check("adaptive effort maps minimal to low", adaptiveEffortFor("anthropic", "claude-sonnet-5", "minimal") === "low");
    check(
      "thinkingRequestFor legacy sonnet uses low budget",
      JSON.stringify(thinkingRequestFor("anthropic", "claude-sonnet-4-5", "low")) ===
        JSON.stringify({ type: "enabled", budget_tokens: 2_048 }),
    );
    check(
      "thinkingRequestFor legacy sonnet uses high budget",
      JSON.stringify(thinkingRequestFor("anthropic", "claude-sonnet-4-5", "high")) ===
        JSON.stringify({ type: "enabled", budget_tokens: 16_384 }),
    );
    check("thinkingRequestFor legacy sonnet off is omitted", thinkingRequestFor("anthropic", "claude-sonnet-4-5", "off") === undefined);
    check(
      "thinkingRequestFor haiku uses a budget",
      JSON.stringify(thinkingRequestFor("anthropic", "claude-haiku-4-5", "low")) ===
        JSON.stringify({ type: "enabled", budget_tokens: 2_048 }),
    );
    check("thinkingRequestFor gpt is omitted", thinkingRequestFor("openai", "gpt-5.6-sol", "high") === undefined);
    check(
      "thinkingRequestFor zen sonnet 5 is adaptive",
      JSON.stringify(thinkingRequestFor("opencode-zen", "claude-sonnet-5", "high")) ===
        JSON.stringify({ type: "adaptive", display: "summarized" }),
    );
    check("thinkingRequestFor zen qwen is omitted", thinkingRequestFor("opencode-zen", "qwen3.7-max", "high") === undefined);
    check(
      "thinkingRequestFor openrouter claude is omitted",
      thinkingRequestFor("openrouter", "anthropic/claude-sonnet-5", "high") === undefined,
    );
    check(
      "adaptiveEffortFor zen sonnet 5",
      adaptiveEffortFor("opencode-zen", "claude-sonnet-5", "high") === "high",
    );
    check("adaptiveEffortFor zen qwen is omitted", adaptiveEffortFor("opencode-zen", "qwen3.7-max", "high") === undefined);
    check(
      "Zen Claude exposes the same effort levels as Anthropic",
      supportedEffortLevels("opencode-zen", "claude-sonnet-5").join(" ") ===
        supportedEffortLevels("anthropic", "claude-sonnet-5").join(" "),
    );
    check(
      "Zen GPT 5.6 hides unsupported minimal",
      supportedEffortLevels("opencode-zen", "gpt-5.6-sol").join(" ") === "off low medium high xhigh max",
    );
    check(
      "reasoningEffortFor zen Claude is omitted",
      reasoningEffortFor("opencode-zen", "claude-sonnet-5", "high") === undefined,
    );
    check(
      "reasoningEffortFor zen GPT is sent",
      reasoningEffortFor("opencode-zen", "gpt-5.6-sol", "high") === "high",
    );
    check(
      "Zen Gemini exposes Google thinking levels",
      supportedEffortLevels("opencode-zen", "gemini-3.7-flash").join(" ") === "low medium high",
    );
    check("reasoningEffortFor zen Gemini is high", reasoningEffortFor("opencode-zen", "gemini-3.7-flash", "high") === "high");
    const bodyZenGemini = compat.googleGenerateBody("sys", [{ role: "user", content: "hi" }], [], {
      maxTokens: 64_000,
      reasoningEffort: "high",
      googleThinking: true,
    });
    check(
      "Zen Gemini generateContent sets thinkingLevel",
      bodyZenGemini.generationConfig?.thinkingConfig?.thinkingLevel === "high" &&
        bodyZenGemini.generationConfig?.thinkingConfig?.includeThoughts === true &&
        bodyZenGemini.model === undefined,
    );
    const bodyZenGeminiMerged = compat.googleGenerateBody(
      "sys",
      [
        { role: "user", content: "hi" },
        { role: "user", content: "<working-set>" },
      ],
      [],
    );
    check(
      "Zen Gemini merges consecutive user turns",
      bodyZenGeminiMerged.contents?.length === 1 &&
        bodyZenGeminiMerged.contents[0]?.role === "user" &&
        bodyZenGeminiMerged.contents[0]?.parts?.length === 2,
    );
    const bodyZenGeminiUnsigned = compat.googleGenerateBody(
      "sys",
      [{ role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "ok" }] }],
      [],
    );
    check(
      "Zen Gemini drops unsigned thought on replay",
      JSON.stringify(bodyZenGeminiUnsigned.contents).includes("ok") &&
        !JSON.stringify(bodyZenGeminiUnsigned.contents).includes("secret"),
    );
    check(
      "googleLiveDelta splits thought parts",
      compat.googleLiveDelta({
        candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: "ok" }] } }],
      })?.thinking === "plan" &&
        compat.googleLiveDelta({
          candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: "ok" }] } }],
        })?.text === "ok",
    );
    const googleDup = compat.googleResultFromEvents(
      [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "plan", thought: true, thoughtSignature: "sig1" },
                  { functionCall: { name: "read_file", args: { path: "a.ts" } } },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "plan", thought: true, thoughtSignature: "sig1" },
                  { functionCall: { name: "read_file", args: { path: "a.ts" } } },
                ],
              },
            },
          ],
        },
      ],
      () => {},
      Date.now(),
    );
    check(
      "googleResultFromEvents dedupes snapshot repeats",
      googleDup.blocks.filter((b) => b.type === "thinking").length === 1 &&
        googleDup.blocks.filter((b) => b.type === "tool_use").length === 1 &&
        googleDup.blocks[0]?.signature === "sig1",
    );
    check(
      "Zen GLM 5.2 exposes Completions effort",
      supportedEffortLevels("opencode-zen", "glm-5.2").join(" ") === "high max",
    );
    check("reasoningEffortFor zen GLM is high", reasoningEffortFor("opencode-zen", "glm-5.2", "high") === "high");
    check(
      "OpenRouter GLM 5.2 maps max onto xhigh",
      supportedEffortLevels("openrouter", "z-ai/glm-5.2").join(" ") === "high xhigh",
    );
    check("fable off clamps to minimal", effectiveEffortFor("anthropic", "claude-fable-5", "off") === "minimal");
    check(
      "thinkingRequestFor fable off stays adaptive",
      JSON.stringify(thinkingRequestFor("anthropic", "claude-fable-5", "off")) ===
        JSON.stringify({ type: "adaptive", display: "summarized" }),
    );
    
    const cacheMsgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "one" },
          { type: "tool_result", tool_use_id: "2", content: "two" },
        ],
      },
    ];
    const stamped = stampHistoryCache(cacheMsgs);
    check("stampHistoryCache does not mutate input", cacheMsgs[2].content[1].cache_control === undefined);
    check(
      "stampHistoryCache marks last tool_result only",
      stamped[2].content[1].cache_control?.type === "ephemeral" && stamped[2].content[0].cache_control === undefined,
    );
    check("stampHistoryCache leaves earlier messages", stamped[0] === cacheMsgs[0]);
    const converted = compat.toCompletionsMessages("sys", stamped);
    check(
      "openai conversion drops cache_control",
      converted.every((m) => !("cache_control" in m) && (typeof m.content === "string" || m.content == null || !JSON.stringify(m).includes("cache_control"))),
    );
    const stampedUser = stampHistoryCache([{ role: "user", content: "hi" }]);
    check(
      "stampHistoryCache pins the last user text",
      stampedUser[0]?.content?.[0]?.type === "text" &&
        stampedUser[0]?.content?.[0]?.text === "hi" &&
        stampedUser[0]?.content?.[0]?.cache_control?.type === "ephemeral",
    );
    check("request overlay omits empty", workingSetForTest({ messages: [] }) === "");
    const overlayMsgs = [
      { role: "assistant", content: [{ type: "tool_use", name: "edit", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
    ];
    const overlay = workingSetForTest({ messages: overlayMsgs, hostContext: "verify failed" });
    check("request overlay includes edit path", overlay.includes("a.ts") && overlay.includes("<modified-files>"));
    check("request overlay includes host context", overlay.includes("verify failed") && overlay.startsWith("<working-set>"));
    const manyReads = {
      role: "assistant",
      content: Array.from({ length: 41 }, (_, i) => ({ type: "tool_use", name: "read_file", input: { path: `f${i}.ts` } })),
    };
    check("request overlay caps inventories", workingSetForTest({ messages: [manyReads] }).includes("<!-- 1 paths omitted -->"));
    check("cache-cost compaction waits below 100k", shouldCompactForCacheCost(99_999, 0, 120_000, false) === false);
    check("cache-cost compaction waits on a cache hit", shouldCompactForCacheCost(120_000, 0.8, 120_000, false) === false);
    check("cache-cost compaction starts on an expensive miss", shouldCompactForCacheCost(120_000, 0.1, 120_000, false) === true);
    check("cache-cost compaction waits after a revision", shouldCompactForCacheCost(120_000, 0.1, 120_000, true) === false);
    const stampedThenOverlay = [
      ...stampHistoryCache(overlayMsgs),
      { role: "user", content: overlay },
    ];
    check(
      "overlay sits after stamped tool_result",
      stampedThenOverlay.at(-1)?.content === overlay &&
        stampedThenOverlay.at(-2)?.content?.[0]?.cache_control?.type === "ephemeral",
    );
    const hdr = (v) => ({ get: (name) => (name.toLowerCase() === "retry-after" ? v : null) });
    check("retryAfter 400 is null", retryAfter(400, hdr(null), 0) === null);
    check("retryAfter 429 first wait 1s", retryAfter(429, hdr(null), 0) === 1_000);
    check("retryAfter 429 second wait 2s", retryAfter(429, hdr(null), 1) === 2_000);
    check("retryAfter 429 third is null", retryAfter(429, hdr(null), 2) === null);
    check("retryAfter honors small Retry-After", retryAfter(503, hdr("3"), 0) === 3_000);
    check("retryAfter ignores large Retry-After", retryAfter(429, hdr("120"), 0) === 1_000);
    check("retryAfter ignores http-date", retryAfter(429, hdr("Wed, 21 Oct 2015 07:28:00 GMT"), 0) === 1_000);
    check("retryAfter 529 retries", retryAfter(529, hdr(null), 0) === 1_000);
    check("parsePrintPrompt missing is null", parsePrintPrompt(["node", "agent-core.mjs"]) === null);
    check("parsePrintPrompt -p joins the rest", parsePrintPrompt(["node", "x", "-p", "fix", "the", "bug"]) === "fix the bug");
    check("parsePrintPrompt --print empty is empty", parsePrintPrompt(["node", "--print"]) === "");
    check(
      "slash / lists every command",
      matchingSlashCommands("/").map((c) => c.name).join(" ") === SLASH_COMMANDS.map((c) => c.name).join(" "),
    );
    check(
      "slash /m is model and models",
      matchingSlashCommands("/m").map((c) => c.name).join(" ") === "/model /models",
    );
    check("slash /models is exact", matchingSlashCommands("/models").map((c) => c.name).join(" ") === "/models");
    check(
      "slash /permissions lists policies",
      matchingSlashCommands("/permissions").map((c) => c.name).join(" ") ===
        "Always ask Ask on dangerous requests Always approve",
    );
    check("slash /permissions filters dangerous", matchingSlashCommands("/permissions dangerous")[0]?.submit === "/permissions dangerous");
    check(
      "slash /permissions ask is exact",
      matchingSlashCommands("/permissions ask").length === 1 && matchingSlashCommands("/permissions ask")[0]?.submit === "/permissions ask",
    );
    check("slash hides after a space", matchingSlashCommands("/help ").length === 0);
    check(
      "slash /login lists OpenAI and OpenAI (key)",
      matchingSlashCommands("/login").some((c) => c.name === "OpenAI" && c.submit === "/login openai oauth") &&
        matchingSlashCommands("/login").some((c) => c.name === "OpenAI (key)" && c.submit === "/login openai key") &&
        matchingSlashCommands("/login").some((c) => c.name === "Anthropic" && c.submit === "/login anthropic oauth") &&
        matchingSlashCommands("/login").some((c) => c.name === "Anthropic (key)" && c.submit === "/login anthropic key") &&
        matchingSlashCommands("/login").some((c) => c.name === "GitHub Copilot" && c.submit === "/login github-copilot oauth") &&
        matchingSlashCommands("/login").some((c) => c.name === "xAI" && c.submit === "/login xai oauth") &&
        matchingSlashCommands("/login").some((c) => c.name === "xAI (key)" && c.submit === "/login xai key") &&
        matchingSlashCommands("/login").some((c) => c.name === "Google Gemini (key)" && c.submit === "/login google key") &&
        !matchingSlashCommands("/login").some((c) => c.name.startsWith("/login ")),
    );
    check(
      "slash /login openai lists both modes",
      matchingSlashCommands("/login openai").map((c) => c.name).join(" ") === "OpenAI OpenAI (key)",
    );
    check(
      "slash /login key lists API key rows",
      matchingSlashCommands("/login key").length > 0 &&
        matchingSlashCommands("/login key").every((c) => c.name.endsWith(" (key)")) &&
        matchingSlashCommands("/login key").some((c) => c.name === "OpenAI (key)"),
    );
    check(
      "slash /login oauth lists OAuth rows",
      matchingSlashCommands("/login oauth").every((c) => !c.name.endsWith(" (key)")) &&
        matchingSlashCommands("/login oauth").some((c) => c.name === "OpenAI") &&
        !matchingSlashCommands("/login oauth").some((c) => c.name === "Google Gemini (key)"),
    );
    check(
      "slash /login a is Anthropic only",
      matchingSlashCommands("/login a").map((c) => c.name).join(" ") === "Anthropic Anthropic (key)",
    );
    check(
      "slash /login gemini is Google Gemini (key)",
      matchingSlashCommands("/login gemini").map((c) => c.name).join(" ") === "Google Gemini (key)",
    );
    check(
      "slash /login opencode lists Go and Zen keys",
      matchingSlashCommands("/login opencode").map((c) => c.name).join(" ") === "OpenCode Go (key) OpenCode Zen (key)",
    );
    check("slash Tab /login completes to /login ", completeSlashLine("/login") === "/login ");
    check(
      "slash /models lists provider-prefixed ids",
      matchingSlashCommands("/models", SLASH_COMMANDS, [
        { name: "openai-codex/gpt-5.4", hint: "openai-codex", submit: "/model openai-codex/gpt-5.4" },
        { name: "anthropic/claude-sonnet-4-5", hint: "anthropic", submit: "/model anthropic/claude-sonnet-4-5" },
      ]).map((c) => c.name).join(" ") === "openai-codex/gpt-5.4 anthropic/claude-sonnet-4-5",
    );
    check(
      "slash /models a is Anthropic only",
      matchingSlashCommands("/models a", SLASH_COMMANDS, [
        { name: "openai-codex/gpt-5.4", hint: "openai-codex", submit: "/model openai-codex/gpt-5.4" },
        { name: "anthropic/claude-sonnet-4-5", hint: "anthropic", submit: "/model anthropic/claude-sonnet-4-5" },
      ]).map((c) => c.name).join(" ") === "anthropic/claude-sonnet-4-5",
    );
    check(
      "slash /models refresh is not a model row",
      matchingSlashCommands("/models refresh", SLASH_COMMANDS, [
        { name: "openai-codex/gpt-5.4", hint: "openai-codex", submit: "/model openai-codex/gpt-5.4" },
      ]).length === 0,
    );
    check("slash Tab unique picker does not expand", completeSlashLine("/login google") === "/login google");
    check("slash ignores prompts", matchingSlashCommands("hello").length === 0);
    check("slash Tab /m completes to /model", completeSlashLine("/m") === "/model");
    check("slash Tab /ex completes to /exit", completeSlashLine("/ex") === "/exit");
    check("slash Tab /foo is unchanged", completeSlashLine("/foo") === "/foo");
    const terminalControl = await import("../../../shared/terminal-control.ts");
    check("thinkingStartupArgs is empty when thinking is shown", terminalControl.thinkingStartupArgs(true).length === 0);
    check(
      "thinkingStartupArgs hides thinking",
      terminalControl.thinkingStartupArgs(false).length === 1 && terminalControl.thinkingStartupArgs(false)[0] === "--hide-thinking",
    );
    check("parseHideThinking reads the core flag", terminalControl.parseHideThinking(["node", "agent-core.mjs", "--hide-thinking"]) === true);
    const commandsMod = await import("../../../shared/commands.ts");
    check(
      "showThinking defaults to true",
      /showThinking:\s*true/.test(readFileSync(new URL("../../../shared/types.ts", import.meta.url), "utf8")),
    );
    check(
      "toggle-thinking is registered",
      commandsMod.COMMAND_DEFINITIONS.some((c) => c.command === "toggle-thinking" && c.label === "Toggle Thinking" && c.defaultShortcut === "CmdOrCtrl+Shift+H"),
    );
    const themesMod = await import("../../../src/terminal-themes.ts");
    function luminance(hex) {
      const n = Number.parseInt(hex.slice(1), 16);
      const rgb = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }
    function contrastRatio(a, b) {
      const l1 = luminance(a);
      const l2 = luminance(b);
      const hi = Math.max(l1, l2);
      const lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    }
    for (const theme of Object.keys(themesMod.TERMINAL_THEMES)) {
      const coreTheme = themesMod.terminalTheme(theme, "core");
      const plainTheme = themesMod.terminalTheme(theme, "pi");
      check(
        `core ${theme} has three extendedAnsi entries`,
        Array.isArray(coreTheme.extendedAnsi) && coreTheme.extendedAnsi.length === 3,
      );
      check(`pi ${theme} has no extendedAnsi override`, plainTheme.extendedAnsi === undefined);
      check(
        `core ${theme} tool backgrounds keep 4.5 contrast`,
        coreTheme.extendedAnsi.every((bg) => contrastRatio(coreTheme.foreground, bg) >= 4.5),
      );
      check(
        `core ${theme} thinking dim keeps 4.5 contrast`,
        contrastRatio(coreTheme.brightBlack, coreTheme.background) >= 4.5,
      );
      check(
        `core ${theme} code cyan keeps 4.5 contrast`,
        contrastRatio(coreTheme.cyan, coreTheme.background) >= 4.5,
      );
    }
    
    const tuiMod = await import("../../../agent-core/tui.ts");
    check("wrapText splits on width", tuiMod.wrapText("abcdef", 3).join("|") === "abc|def");
    check("wrapText keeps newlines", tuiMod.wrapText("ab\ncd", 10).join("|") === "ab|cd");
    check("wrapText keeps emoji graphemes", tuiMod.wrapText("👍👍", 1).join("|") === "👍|👍");
    check("cellWidth treats CJK as two cells", tuiMod.cellWidth("界") === 2);
    check("cellWidth treats combining marks as one cell", tuiMod.cellWidth("e\u0301") === 1);
    check("cursorRowCol treats newline as a wrap break", tuiMod.cursorRowCol("> ", ["a", "\n", "b"], 2, 80).row === 1);
    check("cursorRowCol places the caret on the next line", tuiMod.cursorRowCol("> ", ["a", "\n", "b"], 3, 80).col === 1);
    check("cursorRowCol stays on the first line before the break", tuiMod.cursorRowCol("> ", ["a", "\n", "b"], 1, 80).row === 0);
    const semanticTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    semanticTui.appendAssistant("hello ");
    semanticTui.appendThinking("reason");
    semanticTui.appendAssistant("world");
    semanticTui.appendPlain("note\n");
    semanticTui.appendError("boom\n");
    const h1 = semanticTui.startTool("read_file", "a.ts");
    const h2 = semanticTui.startTool("read_file", "a.ts");
    semanticTui.finishTool(h2, "error", "nope");
    semanticTui.finishTool(h1, "success", "ok");
    const semFrame = semanticTui.frame();
    check(
      "semantic transcript keeps insertion order",
      semFrame.indexOf("hello") < semFrame.indexOf("reason") &&
        semFrame.indexOf("reason") < semFrame.indexOf("world") &&
        semFrame.includes("done") &&
        semFrame.includes("failed"),
    );
    semanticTui.finishTool(h1, "success");
    semanticTui.finishTool(/** @type {any} */ ({}), "success");
    check("forged or duplicate tool handles stay bounded", semanticTui.frame().includes("invalid tool handle"));
    const boundTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    for (let i = 0; i < 2100; i++) boundTui.appendPlain("x");
    check("transcript evicts oldest settled entries", !boundTui.frame().includes("hello") && boundTui.frame().includes("x"));
    const truncTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    truncTui.appendAssistant("a".repeat(410_000));
    const truncText = String(truncTui.entries?.[0]?.text ?? truncTui.frame());
    check(
      "active assistant over budget keeps one truncation marker",
      (truncText.match(/\[truncated\]/g) || []).length === 1 && truncText.length <= 400_000 + 32,
    );
    const hideTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    hideTui.appendAssistant("A1");
    hideTui.appendThinking("secret-think");
    hideTui.appendAssistant("A2");
    hideTui.setThinkingVisible(false);
    check("hidden thinking leaves assistant text", hideTui.frame().includes("A1") && hideTui.frame().includes("A2") && !hideTui.frame().includes("secret-think"));
    hideTui.setThinkingVisible(true);
    check("showing thinking restores the same entry", hideTui.frame().includes("secret-think"));
    const resumeTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    renderHistoryTranscript(
      [
        { role: "user", content: [{ type: "text", text: "hello there" }, { type: "context", text: "hidden-working-set" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "resume-think" },
            { type: "redacted_thinking", thinking: "hidden-encrypted" },
            { type: "text", text: "hi back" },
            { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok file" }] },
        { role: "assistant", content: [{ type: "text", text: "done reading" }] },
      ],
      resumeTui,
    );
    const resumeFrame = resumeTui.frame();
    check(
      "resume paints stored messages",
      resumeFrame.includes("hello there") &&
        resumeFrame.includes("hi back") &&
        resumeFrame.includes("a.ts") &&
        resumeFrame.includes("ok file") &&
        resumeFrame.includes("done reading") &&
        resumeFrame.includes("resume-think") &&
        !resumeFrame.includes("hidden-working-set") &&
        !resumeFrame.includes("hidden-encrypted") &&
        !resumeFrame.includes("resumed 4 messages"),
    );
    resumeTui.setThinkingVisible(false);
    check(
      "resume keeps thinking hideable",
      resumeTui.frame().includes("hi back") && !resumeTui.frame().includes("resume-think"),
    );
    const resumePair = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    renderHistoryTranscript(
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "read_file", input: { path: "first.ts" } },
            { type: "tool_use", id: "b", name: "read_file", input: { path: "second.ts" } },
            { type: "tool_use", id: "", name: "read_file", input: { path: "empty-id.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "b", content: "second-body" },
            { type: "tool_result", tool_use_id: "a", content: "first-body" },
            { type: "tool_result", tool_use_id: "", content: "empty-body" },
            { type: "tool_result", tool_use_id: "missing", content: "orphan-body" },
          ],
        },
      ],
      resumePair,
    );
    const pairFrame = resumePair.frame();
    check(
      "resume pairs tools out of order and keeps orphan results",
      pairFrame.includes("first.ts") &&
        pairFrame.includes("second.ts") &&
        pairFrame.includes("empty-id.ts") &&
        pairFrame.includes("first-body") &&
        pairFrame.includes("second-body") &&
        pairFrame.includes("empty-body") &&
        pairFrame.includes("orphan-body") &&
        !pairFrame.includes("running"),
    );
    const resumeCancel = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    renderHistoryTranscript(
      [{ role: "assistant", content: [{ type: "tool_use", id: "open", name: "bash", input: { command: "sleep 1" } }] }],
      resumeCancel,
    );
    check("resume cancels tools with no result", resumeCancel.frame().includes("cancelled") && resumeCancel.frame().includes("sleep 1"));
    const resumeHandoff = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    renderHistoryTranscript(
      [
        { role: "user", content: "<context-handoff>prior work</context-handoff>" },
        { role: "user", content: [{ type: "text", text: "see this" }, { type: "image", source: { type: "file", name: "x.png" } }] },
      ],
      resumeHandoff,
    );
    check(
      "resume paints handoff and image notices",
      resumeHandoff.frame().includes("prior work") &&
        resumeHandoff.frame().includes("see this") &&
        resumeHandoff.frame().includes("(image)") &&
        !resumeHandoff.frame().includes("<context-handoff>"),
    );
    function paintCapture(setup) {
      const writes = [];
      const tui = new tuiMod.AgentTui({
        stdout: { write: (s) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true },
        stdin: { isTTY: true, setRawMode: () => {}, resume: () => {} },
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      });
      setup(tui);
      tui.start();
      const out = writes.join("");
      tui.stop();
      return out;
    }
    const runningPaint = paintCapture((tui) => {
      tui.startTool("bash", "ls");
    });
    check(
      "pending tool uses index 16",
      runningPaint.includes("\x1b[48;5;16m") && runningPaint.includes("running") && runningPaint.includes("\x1b[0m"),
    );
    check(
      "tui start does not enable mouse tracking",
      runningPaint.includes("\x1b[?1049h") && !runningPaint.includes("\x1b[?1000h") && !runningPaint.includes("\x1b[?1006h"),
    );
    const donePaint = paintCapture((tui) => {
      tui.finishTool(tui.startTool("bash", "ls"), "success", "ok");
    });
    check("successful tool uses index 17", donePaint.includes("\x1b[48;5;17m") && donePaint.includes("done"));
    const failedPaint = paintCapture((tui) => {
      tui.finishTool(tui.startTool("bash", "ls"), "error", "nope");
    });
    check("failed tool uses index 18", failedPaint.includes("\x1b[48;5;18m") && failedPaint.includes("failed"));
    const cancelledPaint = paintCapture((tui) => {
      tui.startTool("bash", "ls");
      tui.cancelPendingTools();
    });
    check(
      "cancelled tool keeps pending background",
      cancelledPaint.includes("\x1b[48;5;16m") && cancelledPaint.includes("cancelled") && !cancelledPaint.includes("\x1b[48;5;18m"),
    );
    const csiTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    csiTui.appendAssistant("visible-a");
    csiTui.appendThinking("hidden-think");
    csiTui.appendAssistant("visible-b");
    csiTui.setDraft("keep-draft");
    const hideSeq = terminalControl.HIDE_THINKING_CSI;
    let hideOk = true;
    for (let i = 1; i < hideSeq.length; i++) {
      const split = new tuiMod.AgentTui({
        stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
        stdin: { isTTY: false },
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      });
      split.appendAssistant("visible-a");
      split.appendThinking("hidden-think");
      split.appendAssistant("visible-b");
      split.setDraft("keep-draft");
      split.feed(hideSeq.slice(0, i));
      split.feed(hideSeq.slice(i));
      const frame = split.frame();
      if (frame.includes("hidden-think") || !frame.includes("visible-a") || !frame.includes("keep-draft")) hideOk = false;
    }
    check("hide CSI works at every split", hideOk);
    csiTui.feed(hideSeq);
    check(
      "complete hide CSI keeps the draft",
      !csiTui.frame().includes("hidden-think") && csiTui.frame().includes("keep-draft"),
    );
    csiTui.setDraft("keep-draft");
    csiTui.feed("\x1b[?25h");
    csiTui.feed("\x1b[?9001;h");
    csiTui.feed(`\x1b[?${"0".repeat(40)}hhello`);
    check(
      "unknown and malformed private CSI stay out of the draft",
      csiTui.frame().includes("keep-drafthello") &&
        !csiTui.frame().includes("9001") &&
        !csiTui.frame().includes("hidden-think"),
    );
    csiTui.feed(terminalControl.SHOW_THINKING_CSI);
    check("show CSI restores thinking", csiTui.frame().includes("hidden-think"));
    const mdTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    mdTui.appendAssistant("*em* **strong** `code`\n");
    check("markdown frame drops emphasis markers", mdTui.frame().includes("em") && mdTui.frame().includes("strong") && !mdTui.frame().includes("*em*"));
    const unclosedMd = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    unclosedMd.appendAssistant("**not closed *em*");
    check(
      "unclosed strong stays literal",
      unclosedMd.frame().includes("**not closed") && unclosedMd.frame().includes("em") && !unclosedMd.frame().includes("*em*"),
    );
    unclosedMd.appendAssistant("\n```js\nstill-open");
    check("unclosed fence stays literal", unclosedMd.frame().includes("```js") && unclosedMd.frame().includes("still-open"));
    unclosedMd.appendAssistant("\n```\n");
    check("closed fence drops markers", unclosedMd.frame().includes("still-open") && !unclosedMd.frame().includes("```js"));
    const nestMd = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    nestMd.appendAssistant(`${"> ".repeat(9)}deep\n`);
    check("quote nesting beyond eight stays literal", nestMd.frame().includes("> > > > > > > > > deep") && !nestMd.frame().includes("│ │ │ │ │ │ │ │ │"));
    const scanMd = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    scanMd.appendAssistant(`${"> quote line\n".repeat(8000)}`);
    scanMd.frame();
    const scannedBefore = scanMd.markdownScannedChars;
    scanMd.appendAssistant("tail-only");
    scanMd.frame();
    const scannedDelta = scanMd.markdownScannedChars - scannedBefore;
    check("markdown scan stays on the unfinished suffix", scannedDelta > 0 && scannedDelta <= "tail-only".length * 4);
    const streamTail = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    streamTail.appendAssistant("a".repeat(80_000));
    streamTail.frame();
    const streamBefore = streamTail.markdownScannedChars;
    streamTail.appendAssistant("Z");
    const streamFrame = streamTail.frame();
    const streamDelta = streamTail.markdownScannedChars - streamBefore;
    check("streaming wrap scans a window not the whole entry", streamDelta > 0 && streamDelta <= 80 * 24 * 8);
    check("streaming wrap keeps the visible tail", streamFrame.includes("Z"));
    const hideOld = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    hideOld.appendPlain("UNIQUE_OLD_MARKER\n");
    hideOld.appendAssistant(`${"a".repeat(80_000)}TAILEND`);
    check(
      "a huge newer entry does not splice older rows into the tail",
      hideOld.frame().replace(/\s+/g, "").includes("TAILEND") && !hideOld.frame().includes("UNIQUE_OLD_MARKER"),
    );
    const showOld = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    showOld.appendPlain("UNIQUE_OLD_MARKER\n");
    showOld.appendAssistant("short-new");
    check(
      "a short newer entry still shows older rows",
      showOld.frame().includes("UNIQUE_OLD_MARKER") && showOld.frame().includes("short-new"),
    );
    const cjkTail = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    cjkTail.appendAssistant(`${"界".repeat(20_000)}尾`);
    check("CJK tail wrap keeps the last grapheme", cjkTail.frame().includes("尾"));
    const mixTrunc = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    mixTrunc.appendPlain("s".repeat(390_000));
    mixTrunc.appendAssistant(`keep-me-${"a".repeat(20_000)}`);
    const mixText = String(mixTrunc.entries?.[0]?.text ?? mixTrunc.frame());
    check(
      "eviction runs before active-stream truncation",
      mixText.includes("keep-me-") && !mixText.includes("[truncated]"),
    );
    const sanTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    sanTui.appendPlain("\x1b[31mSAFE\x1b[0m");
    sanTui.appendAssistant("\x1b]0;title\x07SAFE");
    check("sanitizer strips escapes and keeps SAFE", sanTui.frame().includes("SAFE") && !sanTui.frame().includes("\x1b"));
    sanTui.appendThinking("\x1b[");
    sanTui.appendPlain("SAFE2");
    check("incomplete escape does not leak into the next entry", sanTui.frame().includes("SAFE2") && !sanTui.frame().includes("[SAFE2"));
    check(
      "layoutHeights keeps a transcript",
      tuiMod.layoutHeights(24, 1, 7).transcript >= 2 && tuiMod.layoutHeights(24, 1, 7).header === 2,
    );
    check("layoutHeights fits a tiny screen", tuiMod.layoutHeights(5, 1, 7).transcript >= 1 && tuiMod.layoutHeights(5, 1, 7).slash < 7);
    const visSrc = Array.from({ length: 80 }, (_, i) => `L${String(i).padStart(2, "0")}`).join("\n") + "\n";
    const vis = tuiMod.visibleLines(visSrc, 10, 3, 0);
    check("visibleLines is the tail", vis.join("|").includes("L79") && !vis.join("|").includes("L00"));
    const submitted = [];
    const exits = [];
    const tui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => submitted.push(line),
      onInterrupt: () => {},
      onExit: () => exits.push(true),
    });
    tui.setStatus({
      model: "anthropic/claude",
      auth: "oauth",
      effort: "max",
      usage: usageIndicators,
    });
    tui.appendPlain("hello from transcript\n");
    const frame = tui.frame();
    const frameLines = frame.split("\n");
    check("tui status names the kernel", frame.includes("▸ termina"));
    check("tui status shows the model", frame.includes("anthropic/claude"));
    check("tui status shows effort", frame.includes("anthropic/claude · max"));
    check(
      "tui status stays at the bottom",
      frameLines.at(-3)?.includes("anthropic/claude") && frameLines.at(-2)?.includes("cache 67%"),
    );
    const narrowTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 40, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    narrowTui.setStatus({ model: "openrouter/a-very-long-model-name", effort: "max" });
    check("tui keeps effort visible with a long model", narrowTui.frame().includes(" · max"));
    check("tui status shows token usage", frame.includes("tokens 1.5K in/250 out"));
    check("tui status shows cache", frame.includes("cache 67%"));
    check("tui status shows context", frame.includes("context ~20K/200K 10%"));
    check("tui status keeps cost visible at 80 columns", frame.includes("$0.0123"));
    const imgTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    imgTui.setPendingImageCount(2);
    imgTui.appendPlain("x");
    check("tui status shows pending images", imgTui.frame().includes("2 img"));
    const combinedStatusTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    combinedStatusTui.setStatus({
      model: "openrouter/模型-very-long-model-name",
      auth: "oauth",
      effort: "maximum",
      permissions: "ask",
    });
    combinedStatusTui.setPendingImageCount(2);
    combinedStatusTui.setQueued("queue a late UTF-8 ✅ mutation");
    const combinedStatusHeader = combinedStatusTui.frame().split("\n").at(-3) ?? "";
    check(
      "tui combined status preserves every control label",
      combinedStatusHeader.includes("maximum") &&
        combinedStatusHeader.includes("perm ask") &&
        combinedStatusHeader.includes("2 img") &&
        combinedStatusHeader.includes("queued") &&
        combinedStatusHeader.includes("oauth") &&
        tuiMod.cellWidth(combinedStatusHeader) <= 80,
    );
    let hostRefresh = 0;
    const refreshTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onHostRefresh: () => {
        hostRefresh += 1;
      },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    refreshTui.setDraft("keep this");
    refreshTui.feed("\x1b[201~");
    check(
      "standalone paste-end refreshes host images without changing the draft",
      hostRefresh === 1 && refreshTui.frame().includes("keep this"),
    );
    refreshTui.feed("\x1b[200~abc\x1b[201~");
    check("bracketed paste end does not invoke host refresh", hostRefresh === 1 && refreshTui.frame().includes("keep this"));
    const effortPicks = [];
    const effortTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => effortPicks.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    effortTui.setEffortLevels(["low", "max"]);
    effortTui.feed("/effort");
    check(
      "tui effort picker shows only supported levels",
      effortTui.frame().includes("use low reasoning effort") &&
        effortTui.frame().includes("use maximum reasoning effort") &&
        !effortTui.frame().includes("use medium reasoning effort"),
    );
    effortTui.feed("\x1b[B\r");
    check("tui effort picker submits max", effortPicks[0] === "/effort max");
    const permissionPicks = [];
    const permissionTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => permissionPicks.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    permissionTui.feed("/permissions");
    check("tui permissions picker shows all policies", permissionTui.frame().includes("Ask on dangerous requests"));
    permissionTui.feed("\x1b[B\r");
    check("tui permissions picker submits dangerous", permissionPicks[0] === "/permissions dangerous");
    permissionTui.setDraft("keep this draft");
    permissionTui.setChoices("Approve bash? rm -rf build", [
      { name: "Deny", hint: "reject", submit: "/approve deny" },
      { name: "Approve once", hint: "run", submit: "/approve once" },
    ]);
    permissionTui.setBusy(true);
    check(
      "tui approval is selectable while busy",
      permissionTui.frame().includes("Approve bash? rm -rf build") && permissionTui.frame().includes("↑↓ · Enter"),
    );
    permissionTui.feed("\r");
    check("tui approval defaults to deny", permissionPicks[1] === "/approve deny");
    check("tui approval keeps an in-flight draft", permissionTui.frame().includes("> keep this draft"));
    permissionTui.setBusy(false);
    const shortcutLines = [];
    let shortcutInterrupts = 0;
    const shortcutTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => shortcutLines.push(line),
      onInterrupt: () => shortcutInterrupts++,
      onExit: () => {},
    });
    shortcutTui.setModelRows([
      { name: "anthropic/a", hint: "a", submit: "/model anthropic/a" },
      { name: "anthropic/b", hint: "b", submit: "/model anthropic/b" },
      { name: "anthropic/c", hint: "c", submit: "/model anthropic/c" },
    ]);
    shortcutTui.setEffortLevels(["low", "max"]);
    shortcutTui.setStatus({ model: "anthropic/b", effort: "low" });
    shortcutTui.feed("\x0c");
    check("Ctrl+L opens the model picker", shortcutTui.frame().includes("anthropic/a"));
    shortcutTui.feed("\x10");
    shortcutTui.feed("\x1b[112;6u");
    shortcutTui.feed("\x1b[Z");
    shortcutTui.feed("\x1b");
    check(
      "Escape cancels the model picker",
      !shortcutTui.frame().includes("anthropic/a") && shortcutTui.frame().includes("> /models"),
    );
    shortcutTui.feed("\x1b");
    shortcutTui.frame();
    check("Ctrl+P cycles models forward", shortcutLines[0] === "/model anthropic/c");
    check("Ctrl+Shift+P cycles models backward", shortcutLines[1] === "/model anthropic/a");
    check("Shift+Tab cycles effort", shortcutLines[2] === "/effort max");
    check("Escape interrupts", shortcutInterrupts === 1);
    check("tui transcript is visible", frame.includes("hello from transcript"));
    const emptyTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    check("tui empty state orients the user", emptyTui.frame().includes("Type a task") && emptyTui.frame().includes("/help lists keys"));
    check(
      "tui idle footer is short",
      emptyTui.frame().includes("↵ send") && emptyTui.frame().includes("@ file") && emptyTui.frame().includes("/ cmd") && emptyTui.frame().includes("^J newline"),
    );
    emptyTui.feed("!echo hello");
    check(
      "tui marks bang commands as bash input",
      emptyTui.frame().includes("BASH") && emptyTui.frame().includes("↵ run") && emptyTui.frame().includes("> !echo hello"),
    );
    emptyTui.feed("\x15");
    check("tui leaves bash mode when bang input is cleared", !emptyTui.frame().includes("BASH"));
    emptyTui.setStatus({ permissions: "ask" });
    check("tui shows permissions in the header", emptyTui.frame().includes(" ask "));
    emptyTui.setQueued("fix the test");
    check("tui shows a queued prompt", emptyTui.frame().includes("queued fix the test"));
    const escKeep = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      fileMatches: (query) => rankFileTags(["ok.txt", "agent-core/auth.ts"], query),
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    escKeep.feed("fix @au");
    escKeep.feed("\x1b");
    escKeep.frame();
    check(
      "Escape keeps the draft when closing the file picker",
      escKeep.frame().includes("fix @au") && !escKeep.frame().includes("agent-core/auth.ts"),
    );
    const histSearch = [];
    const histTuiSearch = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => histSearch.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    histTuiSearch.feed("alpha one\r");
    histTuiSearch.feed("beta two\r");
    histTuiSearch.feed("\x12");
    histTuiSearch.feed("beta");
    check("Ctrl+R searches prompt history", histTuiSearch.frame().includes("beta two") && histTuiSearch.frame().includes("(search)"));
    tui.feed("/");
    check("tui slash menu lists help and exit", tui.frame().includes("/help") && tui.frame().includes("/exit"));
    const tagSubmitted = [];
    const tagTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      fileMatches: (query) => rankFileTags(["ok.txt", "pkg/src/a.ts", "agent-core/auth.ts"], query),
      onSubmit: (line) => tagSubmitted.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    tagTui.feed("@");
    check("tui @ lists cwd files first", tagTui.frame().includes("ok.txt") && tagTui.frame().includes("pkg/src/a.ts"));
    tagTui.feed("auth");
    check(
      "tui @ filters as you type",
      tagTui.frame().includes("agent-core/auth.ts") && !tagTui.frame().includes("ok.txt"),
    );
    tagTui.feed("\r");
    check("tui @ enter inserts the path", tagTui.frame().includes("@agent-core/auth.ts") && tagSubmitted.length === 0);
    tagTui.feed("\r");
    check("tui @ second enter submits", tagSubmitted[0] === "@agent-core/auth.ts");
    const tagTab = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      fileMatches: (query) => rankFileTags(["ok.txt"], query),
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    tagTab.feed("@ok\t");
    check("tui @ tab completes a unique file", tagTab.frame().includes("@ok.txt"));
    const tagExact = [];
    const tagExactTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      fileMatches: (query) => rankFileTags(["ok.txt"], query),
      onSubmit: (line) => tagExact.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    tagExactTui.feed("@ok.txt\r");
    check("tui @ enter on an exact path submits", tagExact[0] === "@ok.txt");
    tui.feed("\r");
    check("tui enter on / submits help", submitted[0] === "/help");
    const loginPicks = [];
    const loginTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => loginPicks.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    loginTui.feed("/login");
    check(
      "tui /login shows OpenAI and OpenAI (key)",
      loginTui.frame().includes("OpenAI (key)") && loginTui.frame().includes("Anthropic") && !loginTui.frame().includes("/login openai oauth"),
    );
    loginTui.feed("\x1b[B\x1b[B\r");
    check("tui enter on highlighted OpenAI", loginPicks[0] === "/login openai oauth");
    check(
      "tui login echo uses the picker label",
      loginTui.frame().includes("> OpenAI") && !loginTui.frame().includes("> /login openai oauth"),
    );
    loginTui.feed("/login openai key\r");
    check("tui enter on /login openai key", loginPicks[1] === "/login openai key");
    loginTui.feed("/login openai oauth\r");
    check("tui enter on /login openai oauth", loginPicks[2] === "/login openai oauth");
    const loginFromSlash = [];
    const slashLoginTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => loginFromSlash.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    slashLoginTui.feed("/");
    slashLoginTui.feed("\x1b[B\r");
    check(
      "tui enter on /login command opens picker",
      loginFromSlash.length === 0 && slashLoginTui.frame().includes("OpenAI (key)"),
    );
    tui.feed("/exit\r");
    check("tui /exit hits onExit", exits[0] === true);
    tui.setRawInput(true);
    tui.feed("/\r");
    check("raw input does not expand slash", submitted.at(-1) === "/");
    tui.feed("/login\r");
    check("raw input submits /login as a line", submitted.at(-1) === "/login");
    tui.setRawInput(false);
    const histLines = [];
    const histTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => histLines.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    histTui.feed("hello\r");
    histTui.feed("/login openai oauth\r");
    histTui.feed("\x1b[A\x1b[A\r");
    check("tui history up past a login command", histLines.at(-1) === "hello");
    tui.appendPlain("\x1b[31mred-text\x1b[0m");
    check("tui strips ansi from transcript", tui.frame().includes("red-text") && !tui.frame().includes("\x1b[31m"));
    const pasteLines = [];
    const pasteTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => pasteLines.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    pasteTui.feed("\x1b[200~hello\nworld\x1b[201~\r");
    check("paste keeps newlines", pasteLines[0] === "hello\nworld");
    const nlLines = [];
    const nlTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => nlLines.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    nlTui.feed("ab\x1b[13;2ucd\r");
    check("Shift+Enter inserts a newline", nlLines[0] === "ab\ncd");
    nlTui.feed("ab\x1b\rcd\r");
    check("Alt+Enter inserts a newline", nlLines[1] === "ab\ncd");
    nlTui.feed("ab\x1b[13;3ucd\r");
    check("CSI-u Alt+Enter inserts a newline", nlLines[2] === "ab\ncd");
    const killLines = [];
    const killTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => killLines.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    killTui.feed("one two\x17\r");
    check("ctrl-w kills the last word", killLines[0] === "one");
    const editLines = [];
    const editTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => editLines.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    editTui.setDraft("one two");
    editTui.feed("\x1bb\x0b\r");
    check("Alt+B and Ctrl+K edit by word and line", editLines[0] === "one");
    editTui.setDraft("ab\ncd");
    editTui.feed("\x01X\x05Y\r");
    check("Ctrl+A and Ctrl+E use the current line", editLines[1] === "ab\nXcdY");
    editTui.setDraft("ab\ncd");
    editTui.feed("\x1b[AX\r");
    check("up arrow keeps the screen column", editLines[2] === "Xab\ncd");
    editTui.setDraft("ab\ncd");
    editTui.feed("\x1b[A\x1b[B!\r");
    check("down arrow returns to the next input line", editLines[3] === "ab\ncd!");
    editTui.setDraft("\ncd");
    editTui.feed("\x1b[AX\r");
    check("up arrow from a later line reaches an empty first line", editLines[4] === "X\ncd");
    const draftLines = [];
    const draftTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => draftLines.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    draftTui.setDraft("prefill text");
    check("setDraft shows in the frame", draftTui.frame().includes("prefill text"));
    draftTui.feed("\r");
    check("setDraft submits", draftLines[0] === "prefill text");
    const tuiFail = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24 },
      stdin: { isTTY: true, setRawMode: () => { throw new Error("no raw"); } },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    check("tui start fails closed", tuiFail.start() === false && tuiFail.active() === false);
    
    const scrollTestTui = new tuiMod.AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    scrollTestTui.appendAssistant("line\n".repeat(100));
    scrollTestTui.feed("\x1b[<64;1;1M");
    check("mouse wheel up scrolls by 1 line", scrollTestTui.scroll === 1);
    scrollTestTui.feed("\x1b[<64;1;1M");
    check("second mouse wheel up scrolls by 1 line", scrollTestTui.scroll === 2);
    scrollTestTui.feed("\x1b[<65;1;1M");
    check("mouse wheel down scrolls by 1 line", scrollTestTui.scroll === 1);
    scrollTestTui.feed("\x1b[5~");
    check("page up scrolls by full page", scrollTestTui.scroll > 10);
    
    
    const failed = results.filter((r) => !r).length;
    expect(failed).toBe(0);
    expect(results.length).toBeGreaterThanOrEqual(874);
  }, 180_000);
});
