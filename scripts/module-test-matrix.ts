/**
 * Module↔test coverage matrix (issue #331).
 *
 * Walk production TypeScript modules and tests/unit. Assign one owning
 * `*.test.ts` file, or none. Write docs/reference/MODULE-TEST-MATRIX.md.
 *
 * knip is not used. This script does not delete exports.
 *
 *   node --experimental-strip-types --no-warnings scripts/module-test-matrix.ts
 */
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_ROOTS = ["agent-core", "electron", "shared", "src"] as const;
const TEST_ROOT = "tests/unit";
const OUT_REL = "docs/reference/MODULE-TEST-MATRIX.md";

const IMPORT_SPEC = /(?:from\s+|import\s*\(\s*|vi\.mock\(\s*)["']([^"']+)["']/g;

interface MatrixRow {
  readonly module: string;
  readonly owner: string | null;
}

interface MatrixReport {
  readonly modules: readonly string[];
  readonly rows: readonly MatrixRow[];
  readonly unitFiles: readonly string[];
  readonly unitTests: readonly string[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(rel: string): string {
  return rel.split(/[\\/]/).join("/");
}

function isProductionModule(rel: string): boolean {
  if (rel.endsWith(".d.ts")) return false;
  if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) return false;
  return PRODUCTION_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
}

function isUnitTest(rel: string): boolean {
  return rel.startsWith(`${TEST_ROOT}/`) && rel.endsWith(".test.ts");
}

/** Walk regular files only. Do not follow symbolic links. */
function walkFiles(relRoot: string): string[] {
  const paths: string[] = [];
  const visit = (abs: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      throw new Error(`cannot read ${rel || relRoot}`);
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(abs, entry.name);
      let isLink = entry.isSymbolicLink();
      if (!isLink) {
        try {
          isLink = lstatSync(childAbs).isSymbolicLink();
        } catch {
          throw new Error(`cannot stat ${childRel}`);
        }
      }
      if (isLink) continue;
      if (entry.isDirectory()) {
        visit(childAbs, childRel);
        continue;
      }
      if (entry.isFile()) paths.push(childRel);
    }
  };
  visit(join(ROOT, relRoot), relRoot);
  return paths.sort(cmp);
}

interface NameArea {
  readonly prefix: string;
  /** When true, only files directly in `prefix` match (not nested). */
  readonly directOnly: boolean;
  /** When true, only exact stem matches count (no `stem-` prefix). */
  readonly exactOnly: boolean;
}

function nameAreas(modulePath: string): NameArea[] {
  if (modulePath.startsWith("agent-core/")) {
    return [{ prefix: `${TEST_ROOT}/agent-core/`, directOnly: false, exactOnly: false }];
  }
  if (modulePath.startsWith("electron/")) {
    return [
      { prefix: `${TEST_ROOT}/electron/`, directOnly: false, exactOnly: false },
      { prefix: `${TEST_ROOT}/`, directOnly: true, exactOnly: true },
    ];
  }
  if (modulePath.startsWith("shared/")) {
    return [
      { prefix: `${TEST_ROOT}/shared/`, directOnly: false, exactOnly: false },
      { prefix: `${TEST_ROOT}/`, directOnly: true, exactOnly: true },
    ];
  }
  if (modulePath.startsWith("src/")) {
    return [
      { prefix: `${TEST_ROOT}/ui/`, directOnly: false, exactOnly: false },
      { prefix: `${TEST_ROOT}/scripts/`, directOnly: false, exactOnly: false },
    ];
  }
  return [];
}

function testInArea(testPath: string, area: NameArea): boolean {
  if (!testPath.startsWith(area.prefix)) return false;
  if (!area.directOnly) return true;
  return !testPath.slice(area.prefix.length).includes("/");
}

function stripExt(modulePath: string): string {
  return modulePath.replace(/\.(tsx|ts)$/, "").replace(/\.gen$/, "");
}

/** Dashed path after the production root. `index.ts` drops the last segment. */
function primaryStem(modulePath: string): string {
  const parts = stripExt(modulePath).split("/");
  const rest = parts.slice(1);
  if (rest.length === 0) return "";
  const file = rest[rest.length - 1] ?? "";
  if (file === "index" && rest.length >= 2) return rest.slice(0, -1).join("-");
  return rest.join("-");
}

function basenameStem(modulePath: string): string {
  const parts = stripExt(modulePath).split("/");
  const file = parts[parts.length - 1] ?? "";
  if (file === "index" && parts.length >= 2) return parts[parts.length - 2] ?? "";
  return file;
}

function testStem(testPath: string): string {
  const base = testPath.split("/").pop() ?? "";
  return base.endsWith(".test.ts") ? base.slice(0, -".test.ts".length) : base;
}

function tryResolveModule(spec: string, fromFile: string): string | null {
  const candidates: string[] = [];
  if (spec.startsWith(".")) {
    const abs = resolve(ROOT, dirname(fromFile), spec);
    const rel = toPosix(relative(ROOT, abs));
    candidates.push(rel);
  } else if (PRODUCTION_ROOTS.some((root) => spec === root || spec.startsWith(`${root}/`))) {
    candidates.push(toPosix(spec));
  } else {
    return null;
  }

  const expanded: string[] = [];
  for (const rel of candidates) {
    expanded.push(rel);
    if (rel.endsWith(".js")) expanded.push(`${rel.slice(0, -".js".length)}.ts`);
    if (!/\.(ts|tsx|js)$/.test(rel)) {
      expanded.push(`${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`);
    }
  }

  for (const rel of expanded) {
    const posix = toPosix(rel);
    if (isProductionModule(posix) && existsSync(join(ROOT, posix))) return posix;
  }
  return null;
}

function collectReferencedModules(testPath: string, source: string): Set<string> {
  const found = new Set<string>();
  IMPORT_SPEC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_SPEC.exec(source))) {
    const spec = match[1];
    if (!spec) continue;
    const resolved = tryResolveModule(spec, testPath);
    if (resolved) found.add(resolved);
  }
  return found;
}

function pickOwner(modulePath: string, tests: readonly string[], importers: readonly string[]): string | null {
  const areas = nameAreas(modulePath);
  const primary = primaryStem(modulePath);
  const base = basenameStem(modulePath);
  const exactStems = new Set([primary, base].filter((stem) => stem.length > 0));

  const exactPrimary: string[] = [];
  const exactExtra: string[] = [];
  const prefixed: string[] = [];
  const primaryArea = areas[0];
  for (const testPath of tests) {
    const stem = testStem(testPath);
    for (const area of areas) {
      if (!testInArea(testPath, area)) continue;
      if (exactStems.has(stem)) {
        if (primaryArea && area.prefix === primaryArea.prefix && area.directOnly === primaryArea.directOnly) {
          exactPrimary.push(testPath);
        } else {
          exactExtra.push(testPath);
        }
        break;
      }
      if (!area.exactOnly && primary.length > 0 && stem.startsWith(`${primary}-`)) {
        prefixed.push(testPath);
        break;
      }
    }
  }
  exactPrimary.sort(cmp);
  if (exactPrimary.length > 0) return exactPrimary[0] ?? null;
  exactExtra.sort(cmp);
  if (exactExtra.length > 0) return exactExtra[0] ?? null;
  prefixed.sort(cmp);
  if (prefixed.length > 0) return prefixed[0] ?? null;
  if (importers.length === 1) return importers[0] ?? null;
  return null;
}

function buildMatrix(): MatrixReport {
  const productionFiles = PRODUCTION_ROOTS.flatMap((root) => walkFiles(root));
  const modules = productionFiles.filter(isProductionModule).sort(cmp);
  const unitFiles = walkFiles(TEST_ROOT).filter((rel) => rel.endsWith(".ts")).sort(cmp);
  const unitTests = unitFiles.filter(isUnitTest);

  const importersByModule = new Map<string, string[]>();
  for (const modulePath of modules) importersByModule.set(modulePath, []);
  for (const testPath of unitTests) {
    const source = readFileSync(join(ROOT, testPath), "utf8");
    for (const modulePath of collectReferencedModules(testPath, source)) {
      const list = importersByModule.get(modulePath);
      if (list) list.push(testPath);
    }
  }
  for (const list of importersByModule.values()) list.sort(cmp);

  const rows: MatrixRow[] = modules.map((modulePath) => ({
    module: modulePath,
    owner: pickOwner(modulePath, unitTests, importersByModule.get(modulePath) ?? []),
  }));

  return { modules, rows, unitFiles, unitTests };
}

function formatCell(owner: string | null): string {
  return owner === null ? "none" : `\`${owner}\``;
}

function formatMatrix(report: MatrixReport): string {
  const owned = report.rows.filter((row) => row.owner !== null).length;
  const gaps = report.rows.length - owned;
  const byRoot = PRODUCTION_ROOTS.map((root) => {
    const rows = report.rows.filter((row) => row.module.startsWith(`${root}/`));
    const withOwner = rows.filter((row) => row.owner !== null).length;
    return `| \`${root}/\` | ${rows.length} | ${withOwner} | ${rows.length - withOwner} |`;
  });

  const table = report.rows.map((row) => `| \`${row.module}\` | ${formatCell(row.owner)} |`).join("\n");

  return `# Module↔test coverage matrix (issue #331)

> **Status:** published inventory. Generated by
> \`scripts/module-test-matrix.ts\`. Not a CI gate. Owner matching is a
> prefix/importer heuristic, not a coverage owner of record: a named
> owner can be the first prefix hit or a unique importer, and \`none\`
> can miss tests that use string paths. knip is not used and is not
> required. This file does not delete unused exports (#335).

One row per production TypeScript module. The owner is one
\`tests/unit/**/*.test.ts\` file, or none. Helper files under
\`tests/unit\` (\`fake-dom.ts\`, fixtures, reports) are not owners.

Do not hand-edit the table. Refresh with:

\`\`\`bash
node --experimental-strip-types --no-warnings scripts/module-test-matrix.ts
\`\`\`

The walk uses \`node:fs\` only. It does not spawn \`git\`. It does not
install knip.

## Scope

Production modules: \`*.ts\` / \`*.tsx\` under \`agent-core/\`,
\`electron/\`, \`shared/\`, and \`src/\`. Declaration files (\`*.d.ts\`)
are excluded. \`scripts/\`, \`website/\`, and \`core/\` are out of
scope.

Unit side: every \`tests/unit/**/*.ts\` file (the #331 count), of which
the owners are the \`*.test.ts\` files.

## Owner rule

The scan assigns **one** owner. It does not list every importer.
Name matches stay inside the module's test area
(\`tests/unit/agent-core\`, \`electron\`, \`shared\`, or \`ui\`).
\`src/\` also looks in \`tests/unit/scripts/\`. \`electron/\` and
\`shared/\` also accept an exact basename match in \`tests/unit/*.test.ts\`.

1. Exact stem match — \`electron/sidecar.ts\` →
   \`tests/unit/electron/sidecar.test.ts\`. Nested modules also try the
   dashed path (\`worldlines/guards.ts\` → \`worldlines-guards.test.ts\`).
   \`index.ts\` uses the parent directory name. \`*.gen.ts\` also matches
   the name without \`.gen\`.
2. Area prefix match on the dashed path only —
   \`electron/subagents.ts\` → \`tests/unit/electron/subagents-host.test.ts\`.
   Several prefix hits pick the first path in sort order. Short nested
   basenames (\`app\`, \`main\`, \`context\`) do not match across trees.
3. Unique importer — exactly one \`*.test.ts\` file imports the module
   (\`from\`, \`import()\`, or \`vi.mock\`).
4. Otherwise **none**. A helper imported by many tests without a
   dedicated test file stays none. That is a gap, not an implied owner.

A name match wins over imports. Ticket gaps one-by-one is out of
scope for #331.

## Counts

| Item | Count |
|---|---|
| Production modules | ${report.modules.length} |
| With owning test | ${owned} |
| none | ${gaps} |
| \`tests/unit/**/*.ts\` | ${report.unitFiles.length} |
| \`tests/unit/**/*.test.ts\` | ${report.unitTests.length} |

| Root | Modules | With owner | none |
|---|---|---|---|
${byRoot.join("\n")}

## Matrix

| Module | Owning unit test |
|---|---|
${table}
`;
}

function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("module-test-matrix.ts");
}

if (isMain()) {
  const report = buildMatrix();
  const markdown = formatMatrix(report);
  writeFileSync(join(ROOT, OUT_REL), markdown, "utf8");
  const owned = report.rows.filter((row) => row.owner !== null).length;
  process.stdout.write(
    `wrote ${OUT_REL} (${report.modules.length} modules, ${owned} owned, ${report.modules.length - owned} none, ${report.unitFiles.length} unit files)\n`,
  );
}
