import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PathLookup } from "../../../electron/path-lookup.ts";
import { worldlineAppReadPaths } from "../../../electron/worldlines/bootstrap.ts";
import { candidateSandboxLaunch, filterCandidateEnvironment, terminateSandboxProcessGroup, writeSandboxProfile } from "../../../electron/sandbox.ts";
import { readVerifyStages, writeVerifyPackage } from "../../fixtures/verify-package.ts";

function toolPaths(node: string, npm: string, npmCli: string): PathLookup {
  const paths = new PathLookup();
  vi.spyOn(paths, "findOnPath").mockImplementation((name) => name === "node" ? node : name === "npm" ? npm : null);
  vi.spyOn(paths, "cachedRealpath").mockImplementation((path) => path === npm ? npmCli : process.execPath);
  return paths;
}

describe("candidate npm runtime read paths", () => {
  it("allows npm's resolved package, not its installation prefix or home", () => {
    const home = "/test-home";
    const prefix = join(home, ".node");
    const npmRoot = join(prefix, "lib", "node_modules", "npm");
    const npmCli = join(npmRoot, "bin", "npm-cli.js");
    const reads = worldlineAppReadPaths(process.execPath, toolPaths(join(prefix, "bin", "node"), join(prefix, "bin", "npm"), npmCli));
    expect(reads).toContain(npmRoot);
    expect(reads).toContain(npmCli);
    expect(reads).not.toContain(home);
    expect(reads).not.toContain(prefix);
    expect(reads).not.toContain(dirname(npmRoot));
  });

  it("does not infer a package root from an arbitrary npm wrapper", () => {
    const home = "/test-home";
    const wrapper = join(home, "npm-cli.js");
    const reads = worldlineAppReadPaths(process.execPath, toolPaths("/tools/bin/node", "/tools/bin/npm", wrapper));
    expect(reads).not.toContain(wrapper);
    expect(reads).not.toContain(home);
    expect(reads).not.toContain("/");
  });

  for (const packageRun of [false, true]) {
    const action = packageRun ? "runs the package lifecycle" : "loads npm and preserves filesystem isolation";
    it.skipIf(process.platform !== "darwin")(`${action} with npm installed below the denied home`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "termina-candidate-npm-")));
      let cleanupConfirmed = true;
      try {
        const home = join(root, "real-home");
        const prefix = join(home, ".node");
        const bin = join(prefix, "bin");
        const npmRoot = join(prefix, "lib", "node_modules", "npm");
        const npmCli = join(npmRoot, "bin", "npm-cli.js");
        const hostPaths = new PathLookup();
        const hostNpm = hostPaths.findOnPath("npm");
        expect(hostNpm, "the npm runtime is required for this execution regression").not.toBeNull();
        const hostNpmRoot = dirname(dirname(hostPaths.cachedRealpath(hostNpm!)));
        await cp(hostNpmRoot, npmRoot, { recursive: true });
        await mkdir(bin, { recursive: true });
        await symlink(process.execPath, join(bin, "node"));
        await symlink(npmCli, join(bin, "npm"));
        const comparison = join(root, "user-data", "worlds", "comparison");
        const candidate = join(comparison, "A");
        const support = join(comparison, "A-support");
        const primary = join(root, "primary");
        const sibling = join(comparison, "B");
        for (const dir of [candidate, support, primary, sibling, join(support, "home"), join(support, "tmp")]) {
          await mkdir(dir, { recursive: true });
        }
        const protectedFiles = [join(home, "secret"), join(primary, "secret"), join(sibling, "secret"), join(npmRoot, "package.json")];
        for (const path of protectedFiles.slice(0, 3)) await writeFile(path, "private fixture\n");
        await writeVerifyPackage(candidate, {
          pretest: "termina-verify-fixture pre",
          test: "termina-verify-fixture main && node check-isolation.cjs",
          posttest: "termina-verify-fixture post",
        });
        await writeFile(join(candidate, "check-isolation.cjs"), `const fs = require("node:fs");
const paths = ${JSON.stringify(protectedFiles)};
for (const path of paths.slice(0, 3)) {
  let denied = false;
  try { fs.readFileSync(path); } catch (error) { denied = ["EACCES", "EPERM"].includes(error.code); }
  if (!denied) throw new Error("protected read was allowed: " + path);
}
for (const path of paths) {
  let denied = false;
  try { fs.writeFileSync(path, "unexpected write"); } catch (error) { denied = ["EACCES", "EPERM"].includes(error.code); }
  if (!denied) throw new Error("protected write was allowed: " + path);
}
console.log("isolation preserved");
${packageRun ? "" : `process.argv = [process.execPath, ${JSON.stringify(npmCli)}, "--version"]; require(${JSON.stringify(npmCli)});`}
`);
        const profile = join(comparison, "profiles", "A.sb");
        writeSandboxProfile(profile, {
          candidateRoot: candidate, candidateSupport: support, siblingDir: sibling,
          templateDir: join(comparison, "template"), worldsRoot: join(root, "user-data", "worlds"),
          primaryRoot: primary, sourceObjectsDir: join(primary, ".git", "objects"),
          realHome: home, storeDir: join(root, "store"), primaryEventsDir: join(root, "events"),
          userData: join(root, "user-data"), agentHomeDir: join(support, "agent"), denyNetwork: true,
          appReadPaths: worldlineAppReadPaths(process.execPath, toolPaths(join(bin, "node"), join(bin, "npm"), npmCli)),
        });
        const command = packageRun ? ["/bin/sh", "-c", "npm run test"] : [process.execPath, join(candidate, "check-isolation.cjs")];
        const launch = candidateSandboxLaunch(profile, command);
        const child = spawn(launch.cmd, launch.args, {
          cwd: candidate, detached: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...filterCandidateEnvironment(process.env, null, [bin, dirname(process.execPath)]), HOME: join(support, "home"), TMPDIR: join(support, "tmp") },
        });
        cleanupConfirmed = false;
        let output = "";
        child.stdout.on("data", (data) => { output += data.toString(); });
        child.stderr.on("data", (data) => { output += data.toString(); });
        try {
          const [code] = await once(child, "close", { signal: AbortSignal.timeout(30_000) });
          expect(code, output).toBe(0);
          expect(output).toContain("isolation preserved");
          if (packageRun) {
            expect((await readVerifyStages(candidate)).map((stage) => stage.event)).toEqual(["pretest", "test", "posttest"]);
          } else {
            const { version } = JSON.parse(await readFile(join(npmRoot, "package.json"), "utf8"));
            expect(output.trim().split("\n").at(-1)).toBe(version);
          }
          expect(await readFile(join(home, "secret"), "utf8")).toBe("private fixture\n");
        } finally {
          cleanupConfirmed = await terminateSandboxProcessGroup(child);
          expect(cleanupConfirmed, `candidate npm process cleanup was not confirmed; retaining ${root}`).toBe(true);
        }
      } finally {
        if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
        else console.warn(`[test] retaining ${root}: candidate npm process cleanup was not confirmed`);
      }
    }, 60_000);
  }
});
