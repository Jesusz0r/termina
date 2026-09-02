import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

describe("Source Installer Invariants", () => {
  it("builds the reviewed checkout instead of downloading an executable", () => {
    const sourcePath = resolve("scripts/install.sh");
    const source = readFileSync(sourcePath, "utf8");
    const roots: string[] = [];

    function temp(name: string) {
      const root = mkdtempSync(join(tmpdir(), `termina-install-${name}-`));
      roots.push(root);
      return root;
    }

    function executable(path: string, body: string) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
      chmodSync(path, 0o755);
    }

    function fixture(name: string, { cargo = true, repo = true } = {}) {
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

    function runFixture(value: ReturnType<typeof fixture>) {
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
      expect(source).not.toMatch(/releases\/latest|termina-core-\$\{|curl[^\n]*-o[^\n]*termina-core/);
      expect(source).toMatch(/unset TERMINA_SKIP_CORE_BUILD/);

      const good = fixture("good");
      const result = runFixture(good);
      expect(result.status).toBe(0);
      const log = readFileSync(good.log, "utf8");
      expect(log).toMatch(new RegExp(`npm:${good.checkout.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:ci`));
      expect(log).toMatch(new RegExp(`npm:${good.checkout.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:run build:skip=unset`));

      const missingRepo = fixture("missing-repo", { repo: false });
      const missingRepoResult = runFixture(missingRepo);
      expect(missingRepoResult.status).not.toBe(0);
      expect(`${missingRepoResult.stdout}\n${missingRepoResult.stderr}`).toMatch(/checked-out Termina repository/i);

      const missingCargo = fixture("missing-cargo", { cargo: false });
      const missingCargoResult = runFixture(missingCargo);
      expect(missingCargoResult.status).not.toBe(0);
      expect(`${missingCargoResult.stdout}\n${missingCargoResult.stderr}`).toMatch(/Rust.*cargo/i);

      const piped = temp("piped");
      const pipedResult = spawnSync("/bin/sh", [], {
        cwd: piped,
        input: source,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      });
      expect(pipedResult.status).not.toBe(0);
      expect(`${pipedResult.stdout}\n${pipedResult.stderr}`).toMatch(/checked-out Termina repository/i);

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
      expect(shapedPipeResult.status).not.toBe(0);
      expect(`${shapedPipeResult.stdout}\n${shapedPipeResult.stderr}`).toMatch(/scripts\/install\.sh/i);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });
});
