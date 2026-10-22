// Fleet toolchain drift check. Identical in every repo; the source is the fleet-stack repo
// (D:\Documents\Tools\fleet-stack). It fails when this repo has drifted from its profile of the standard:
//   - a shared file whose bytes differ from scripts/stack-shared.json
//   - a pnpm-workspace.yaml safety-policy key with another value
//   - packageManager, engines.node or a standard script that differs, or a required script that is missing
//   - a toolchain package at another range, in the root package.json or in any workspace package
// Never fix drift by editing here: change fleet-stack and sync (docs/stack.md, "Changing the standard").
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sha256 = (text) =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
const manifest = JSON.parse(read('scripts/stack-shared.json'));
const want = manifest.packageJson;
const problems = [];

// 1. Shared files, byte for byte.
for (const [file, hash] of Object.entries(manifest.files)) {
  if (!existsSync(join(ROOT, file))) problems.push(`missing shared file ${file}`);
  else if (sha256(read(file)) !== hash) problems.push(`${file} differs from the fleet copy`);
}

// 2. pnpm-workspace.yaml: the safety policy keys (the rest of the file belongs to the repo).
const ws = existsSync(join(ROOT, 'pnpm-workspace.yaml')) ? read('pnpm-workspace.yaml') : '';
const topLevel = Object.fromEntries(
  [...ws.matchAll(/^([A-Za-z][\w-]*):[ \t]*(\S[^#\r\n]*?)[ \t]*(?:#.*)?$/gm)].map((m) => [
    m[1],
    m[2].replace(/^['"]|['"]$/g, ''),
  ]),
);
for (const [key, value] of Object.entries(manifest.workspacePolicy ?? {})) {
  if (topLevel[key] !== String(value))
    problems.push(`pnpm-workspace.yaml ${key} is ${topLevel[key] ?? 'absent'}, expected ${value}`);
}

// 3. Workspace packages (root first), from pnpm-workspace.yaml `packages:`.
const globs = [];
const block = ws.match(/^packages:[ \t]*\r?\n((?:[ \t]+-.*\r?\n?)*)/m);
if (block) for (const m of block[1].matchAll(/-\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm)) globs.push(m[1]);
const packageDirs = ['.'];
for (const g of globs) {
  if (g.startsWith('!')) continue;
  if (g.endsWith('/*') && !g.slice(0, -2).includes('*')) {
    const base = g.slice(0, -2);
    if (!existsSync(join(ROOT, base))) continue;
    for (const d of readdirSync(join(ROOT, base), { withFileTypes: true }))
      if (d.isDirectory() && existsSync(join(ROOT, base, d.name, 'package.json')))
        packageDirs.push(`${base}/${d.name}`);
  } else if (!g.includes('*')) {
    if (existsSync(join(ROOT, g, 'package.json'))) packageDirs.push(g);
  } else problems.push(`pnpm-workspace.yaml packages glob ${g} is not supported by check-stack`);
}
const packages = packageDirs.map((dir) => ({
  dir,
  pkg: JSON.parse(read(join(dir, 'package.json'))),
}));
const root = packages[0].pkg;

// 4. Root package.json fields and scripts.
if (root.packageManager !== want.packageManager)
  problems.push(`packageManager is ${root.packageManager}, expected ${want.packageManager}`);
if (root.engines?.node !== want.engines.node)
  problems.push(`engines.node is ${root.engines?.node}, expected ${want.engines.node}`);
for (const [name, value] of Object.entries(want.scripts)) {
  if (root.scripts?.[name] !== value) problems.push(`script "${name}" should be: ${value}`);
}
for (const name of want.siteScripts) {
  if (!root.scripts?.[name]) problems.push(`script "${name}" is missing (CI or tooling runs it)`);
}

// 5. Toolchain versions in every package that declares them. `toolchain` packages are required,
// `optionalToolchain` ones are checked only where a package uses them. A package may hold one back while
// a dependency of its own cannot follow yet: package.json "stackExceptions": { "<package>": { "range",
// "reason", "expires" } }. Only toolchain versions can be excepted, and an expired entry fails.
const today = new Date().toISOString().slice(0, 10);
const ranges = { ...want.optionalToolchain, ...want.toolchain };
const declared = new Set();
const held = [];
for (const { dir, pkg } of packages) {
  const where = dir === '.' ? '' : ` (${dir})`;
  const exceptions = pkg.stackExceptions ?? {};
  for (const [name, ex] of Object.entries(exceptions)) {
    if (!(name in ranges))
      problems.push(`stackExceptions.${name}${where}: not a toolchain package`);
    else if (!ex?.range || !ex?.reason || !/^\d{4}-\d{2}-\d{2}$/.test(ex?.expires ?? ''))
      problems.push(`stackExceptions.${name}${where} needs range, reason and expires (YYYY-MM-DD)`);
    else if (ex.expires < today)
      problems.push(
        `stackExceptions.${name}${where} expired on ${ex.expires}: re-check "${ex.reason}"`,
      );
    else held.push(`${name} ${ex.range}${where} until ${ex.expires}`);
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, range] of Object.entries(ranges)) {
    if (!(name in deps)) continue;
    declared.add(name);
    const expected = exceptions[name]?.range ?? range;
    if (deps[name] !== expected)
      problems.push(`${name}${where} is ${deps[name]}, expected ${expected}`);
  }
}
for (const name of Object.keys(want.toolchain)) {
  if (!declared.has(name))
    problems.push(`${name} is not declared, expected ${want.toolchain[name]}`);
}

if (problems.length) {
  console.error(`Toolchain drift (${problems.length}):\n  - ${problems.join('\n  - ')}`);
  console.error('Fix it in fleet-stack and sync (docs/stack.md, "Changing the standard").');
  process.exit(1);
}
console.log(
  `Toolchain matches the fleet standard, profile ${manifest.profile} (${Object.keys(manifest.files).length} shared files` +
    (packages.length > 1 ? `, ${packages.length} packages` : '') +
    ')' +
    (held.length ? `; declared exceptions: ${held.join(', ')}.` : '.'),
);
