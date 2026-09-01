/** Source installer must build the reviewed checkout instead of downloading an executable. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const sourcePath = new URL("./install.sh", import.meta.url);
const source = readFileSync(sourcePath, "utf8");
const roots = [];

function temp(name) {
  const root = mkdtempSync(join(tmpdir(), `termina-install-${name}-`));
  roots.push(root);
  return root;
}

function executable(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function fixture(name, { cargo = true, repo = true } = {}) {
  const root = temp(name);
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, "scripts", "install.sh"), source, { mode: 0o755 });
  if (repo) {
    mkdirSync(join(checkout, "core"), { recursive: true });
    writeFileSync(join(checkout, "package.json"), "{}\n");
    writeFileSync(join(checkout, "package-lock.json"), "{}\n");
    writeFileSync(join(checkout, "core", "Cargo.toml"), "[package]\nname='fixture'\nversion='0.0.0'\n");
  }
  executable(join(bin, "node"), `printf 'node:%s:%s\\n' "$PWD" "$*" >> "$TERMINA_INSTALL_TEST_LOG"`);
  executable(join(bin, "npm"), `printf 'npm:%s:%s:skip=%s\\n' "$PWD" "$*" "\${TERMINA_SKIP_CORE_BUILD-unset}" >> "$TERMINA_INSTALL_TEST_LOG"`);
  if (cargo) executable(join(bin, "cargo"), ":");
  return { root, checkout, bin, log };
}

function runFixture(value) {
  return spawnSync("/bin/sh", [join(value.checkout, "scripts", "install.sh")], {
    cwd: value.root,
    env: {
      ...process.env,
      PATH: `${value.bin}:/usr/bin:/bin`,
      TERMINA_INSTALL_TEST_LOG: value.log,
      TERMINA_SKIP_CORE_BUILD: "1",
    },
    encoding: "utf8",
  });
}

try {
  assert.doesNotMatch(source, /releases\/latest|termina-core-\$\{|curl[^\n]*-o[^\n]*termina-core/);
  assert.match(source, /unset TERMINA_SKIP_CORE_BUILD/);

  const good = fixture("good");
  const result = runFixture(good);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const log = readFileSync(good.log, "utf8");
  assert.match(log, new RegExp(`npm:${good.checkout.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:ci`));
  assert.match(log, new RegExp(`npm:${good.checkout.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:run build:skip=unset`));

  const missingRepo = fixture("missing-repo", { repo: false });
  const missingRepoResult = runFixture(missingRepo);
  assert.notEqual(missingRepoResult.status, 0);
  assert.match(`${missingRepoResult.stdout}\n${missingRepoResult.stderr}`, /checked-out Termina repository/i);

  const missingCargo = fixture("missing-cargo", { cargo: false });
  const missingCargoResult = runFixture(missingCargo);
  assert.notEqual(missingCargoResult.status, 0);
  assert.match(`${missingCargoResult.stdout}\n${missingCargoResult.stderr}`, /Rust.*cargo/i);

  const piped = temp("piped");
  const pipedResult = spawnSync("/bin/sh", [], {
    cwd: piped,
    input: source,
    env: { ...process.env, PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
  assert.notEqual(pipedResult.status, 0);
  assert.match(`${pipedResult.stdout}\n${pipedResult.stderr}`, /checked-out Termina repository/i);

  const shaped = fixture("piped-shaped");
  const shapedPipeResult = spawnSync("sh", [], {
    cwd: join(shaped.checkout, "scripts"),
    input: source,
    env: {
      ...process.env,
      PATH: `${shaped.bin}:/usr/bin:/bin`,
      TERMINA_INSTALL_TEST_LOG: shaped.log,
      TERMINA_SKIP_CORE_BUILD: "1",
    },
    encoding: "utf8",
  });
  assert.notEqual(shapedPipeResult.status, 0);
  assert.match(`${shapedPipeResult.stdout}\n${shapedPipeResult.stderr}`, /scripts\/install\.sh/i);

  console.log("source installer: 6/6 passed");
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
