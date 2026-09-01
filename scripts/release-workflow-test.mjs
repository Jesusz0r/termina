/** Release publication is a single all-platform transaction after the test gate. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageScripts = packageJson.scripts ?? {};

function jobBlock(name) {
  const startMatch = new RegExp(`^  ${name}:\\s*$`, "m").exec(workflow);
  assert.ok(startMatch, `release workflow needs a ${name} job`);
  const start = startMatch.index;
  const rest = workflow.slice(start + startMatch[0].length);
  const nextJob = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(rest);
  return workflow.slice(start, nextJob ? start + startMatch[0].length + nextJob.index : undefined);
}

function countCommand(script, command) {
  return (String(script ?? "").match(new RegExp(`(?:^|&&|\\s)${command.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?=\\s|$)`, "g")) ?? []).length;
}

const testJob = jobBlock("test");
const buildJob = jobBlock("build");
const publishJob = jobBlock("publish");

assert.match(workflow, /^\s*workflow_dispatch:\s*$/m, "manual dry-run builds must remain available");
assert.match(workflow, /push:\s*\n\s+tags:\s*\["v\*"\]/, "tag pushes must remain the release trigger");
assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m, "workflow defaults must be read-only");
assert.match(testJob, /permissions:\s*\n\s+contents:\s*read\b/, "test job must declare read-only repository access");
assert.match(buildJob, /permissions:\s*\n\s+contents:\s*read\b/, "build job must declare read-only repository access");
assert.match(publishJob, /permissions:\s*\n\s+contents:\s*write\b/, "publish job must be the only release writer");
assert.doesNotMatch(testJob, /contents:\s*write\b/, "test job must not receive release write access");
assert.doesNotMatch(buildJob, /contents:\s*write\b/, "build job must not receive release write access");
assert.match(testJob, /- run: npm run test:release\b/, "release workflow must run the canonical functional gate");
assert.match(buildJob, /needs:\s*(?:test|\[\s*test\s*\])\b/, "platform packaging must wait for functional tests");
assert.match(buildJob, /strategy:\s*\n\s+fail-fast:\s*false\s*\n\s+matrix:/, "both platform builds must be part of one complete matrix");
assert.match(buildJob, /os:\s*macos-14\b/, "matrix must include the macOS release leg");
assert.match(buildJob, /os:\s*ubuntu-22\.04\b/, "matrix must include the Linux release leg");

assert.doesNotMatch(buildJob, /--publish\s+always\b/, "matrix legs must never publish through electron-builder");
assert.doesNotMatch(buildJob, /\bgh\s+release\s+(?:create|upload|edit)\b/, "matrix legs must not mutate a release");
assert.doesNotMatch(buildJob, /draft=false/, "matrix legs must not make a release public");
assert.doesNotMatch(buildJob, /uses:\s*[^\n]*(?:gh-?release|release-action|publish-release)/i, "matrix legs must not invoke a public release action");
const builderCommands = [...buildJob.matchAll(/^\s*(?:npx\s+)?electron-builder\b.*$/gm)].map((match) => match[0]);
assert.ok(builderCommands.length >= 1, "matrix must package with electron-builder");
for (const command of builderCommands) {
  assert.match(command, /--publish\s+never\b/, `matrix package command must use --publish never: ${command.trim()}`);
}
assert.doesNotMatch(buildJob, /\bsleep\b/, "package retry must not stall a runner with sleep");
assert.doesNotMatch(buildJob, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/, "packaging must not receive a release token");

assert.match(buildJob, /-c\.mac\.notarize=true/, "macOS notarization behavior must be preserved");
for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
  assert.match(buildJob, new RegExp(`\\b${secret}:`), `${secret} must still be available to signing/notarization`);
}

assert.match(buildJob, /name:\s*termina-release-\$\{\{\s*matrix\.artifact\s*\}\}/, "each platform must upload a uniquely named workflow artifact");
assert.match(buildJob, /if-no-files-found:\s*error/, "missing packaged artifacts must fail the matrix leg");
for (const pattern of ["release/*.dmg", "release/*.zip", "release/*.AppImage", "release/*.blockmap", "release/latest*.yml", "release/termina-core-*"]) {
  assert.ok(buildJob.includes(pattern), `workflow artifact must include ${pattern}`);
}
assert.match(buildJob, /cp\s+[^\n]*termina-core[^\n]*release\/\$\{\{\s*matrix\.core-asset\s*\}\}/, "raw core must be staged inside the platform workflow artifact");

for (const match of workflow.matchAll(/^\s*- uses:\s*([^@\s]+)@([^\s]+)\s*$/gm)) {
  assert.match(match[2], /^[0-9a-f]{40}$/, `third-party action ${match[1]} must use an immutable commit SHA`);
}
assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain@stable\b/, "Rust setup must not follow the mutable stable tag");
assert.match(workflow, /dtolnay\/rust-toolchain@[0-9a-f]{40}[\s\S]*?toolchain:\s*1\.97\.1/, "Rust toolchain must use an immutable action and exact version");
assert.match(testJob, /node-version:\s*22\.23\.2\b/, "test job must use the reviewed Node runtime version");
assert.match(buildJob, /node-version:\s*22\.23\.2\b/, "build job must use the reviewed Node runtime version");

assert.match(publishJob, /needs:\s*(?:build|\[\s*build\s*\])\b/, "publication must wait for the complete build matrix");
const publishHeader = publishJob.slice(0, publishJob.indexOf("steps:"));
assert.doesNotMatch(publishHeader, /if:\s*startsWith\(github\.ref/, "workflow_dispatch must run the downstream dry validation job");
for (const [name, destination] of [["termina-release-mac-arm64", "release-input/mac-arm64"], ["termina-release-linux-x64", "release-input/linux-x64"]]) {
  assert.match(publishJob, new RegExp(`name:\\s*${name.replaceAll("-", "\\-")}\\s*\\n\\s+path:\\s*${destination.replaceAll("/", "\\/")}`), `publish job must download ${name} separately`);
}

const validationIndex = publishJob.indexOf("name: Validate complete release asset set");
assert.ok(validationIndex >= 0, "publish job needs a platform-completeness validation step");
const firstMutation = publishJob.search(/\bgh\s+release\s+(?:create|upload|edit)\b/);
assert.ok(firstMutation > validationIndex, "all release assets must be validated before any release mutation");
for (const required of ["*.dmg", "*.zip", "latest-mac.yml", "*.AppImage", "latest-linux.yml", "*.blockmap", "termina-core-darwin-arm64", "termina-core-linux-x64"]) {
  assert.ok(publishJob.includes(required), `validation must require a nonempty ${required} asset class`);
}
assert.match(publishJob, /-size\s+\+0/, "asset validation must reject empty files");
assert.match(publishJob, /uniq\s+-d/, "asset validation must reject colliding asset names");

assert.match(publishJob, /gh\s+release\s+create[^\n]*--draft\b[^\n]*--verify-tag\b/, "tag publication must start from a draft release");
assert.match(publishJob, /isDraft/, "an existing release may only be reused after proving it is still a draft");
assert.equal((workflow.match(/\bgh\s+release\s+create\b/g) ?? []).length, 1, "only the downstream publish job may create a release");
assert.equal((workflow.match(/\bgh\s+release\s+upload\b/g) ?? []).length, 1, "all release assets must be uploaded in one downstream command");
assert.match(publishJob, /gh\s+release\s+upload[^\n]*release-assets\/\*/, "the one upload must include the complete validated asset set");

const publicCommands = workflow.match(/\bgh\s+release\s+edit[^\n]*--draft=false\b/g) ?? [];
assert.equal(publicCommands.length, 1, "exactly one command may make the release public");
const publicStep = publishJob.indexOf("name: Make release public");
assert.ok(publicStep >= 0, "the final publication command must be an explicit step");
assert.doesNotMatch(publishJob.slice(publicStep + "name: Make release public".length), /\n\s{6}-\s/, "making the release public must be the final step");

const mutatingStepNames = ["Create or reuse draft release", "Upload complete release asset set", "Make release public"];
for (const stepName of mutatingStepNames) {
  const stepStart = publishJob.indexOf(`name: ${stepName}`);
  assert.ok(stepStart >= 0, `publish job needs the ${stepName} step`);
  const nextStep = publishJob.indexOf("\n      - ", stepStart + 1);
  const step = publishJob.slice(stepStart, nextStep < 0 ? undefined : nextStep);
  assert.match(
    step,
    /if:\s*github\.event_name\s*==\s*'push'\s*&&\s*startsWith\(github\.ref,\s*'refs\/tags\/'\)/,
    `${stepName} must require a tag push so every workflow_dispatch run remains dry`,
  );
  assert.match(step, /GH_REPO:\s*\$\{\{\s*github\.repository\s*\}\}/, `${stepName} must resolve gh commands against the workflow repository`);
}

for (const scriptName of [
  "test:agent-core-focused",
  "test:core-client-read-budget",
  "test:promotion-native-boundary",
  "test:sandbox-security-live",
  "test:e2e-release-smoke",
]) {
  assert.equal(typeof packageScripts[scriptName], "string", `package.json must define ${scriptName}`);
}
assert.equal(countCommand(packageScripts.test, "npm run test:agent-core-focused"), 1, "default test must run the focused agent-core aggregate exactly once");
assert.equal(countCommand(packageScripts["test:agent-core-focused"], "npm run test:agent-core-security"), 1, "focused agent-core aggregate must run security exactly once");
assert.equal(countCommand(packageScripts.test, "npm run test:agent-core-security"), 0, "default test must not duplicate the security aggregate outside focused tests");
assert.equal(countCommand(packageScripts.test, "npm run test:core-client-read-budget"), 1, "default test must run the CoreClient read-budget regression exactly once");
assert.equal(countCommand(packageScripts["test:spikes"], "npm run test:promotion-native-boundary"), 1, "spike aggregate must run native promotion boundary exactly once");
assert.equal(countCommand(packageScripts.test, "npm run test:spikes"), 1, "default test must run the spike aggregate exactly once");
assert.equal(countCommand(packageScripts["test:release"], "npm run test"), 1, "release test must inherit the default gate exactly once");
for (const command of [
  "npm run test:agent-core-focused",
  "npm run test:core-client-read-budget",
  "npm run test:promotion-native-boundary",
]) {
  assert.equal(countCommand(packageScripts["test:release"], command), 0, `release test must not invoke ${command} a second time`);
}

assert.equal(typeof packageScripts["test:release-macos"], "string", "package.json must define the macOS release gate");
assert.equal(countCommand(packageScripts["test:release-macos"], "npm run test:sandbox-security-live"), 1, "macOS release gate must require one live sandbox run");
assert.equal(countCommand(packageScripts["test:release-macos"], "npm run test:e2e-release-smoke"), 1, "macOS release gate must run one representative E2E smoke");
const macGateRun = buildJob.indexOf("run: npm run test:release-macos");
const packageStep = buildJob.indexOf("name: Package");
assert.ok(macGateRun >= 0 && packageStep >= 0 && macGateRun < packageStep, "the macOS release gate must run before packaging");
const macGateStep = buildJob.slice(buildJob.lastIndexOf("\n      -", macGateRun), packageStep);
assert.match(macGateStep, /if:\s*matrix\.os\s*==\s*['"]macos-14['"]/, "the macOS release gate must be restricted to the macOS matrix leg");

console.log("release workflow publication contract passed");
