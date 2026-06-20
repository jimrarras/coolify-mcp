// Bundles the CLI (+ MCP server + all runtime deps) into a single self-contained
// dist/cli/index.js with NO native dependencies, so `npm install github:…` needs
// no toolchain and runs no install scripts on the user's machine.
//
// ssh2 ships native bindings (its own sshcrypto.node + the optional cpu-features);
// both are externalized as *.node / cpu-features, so the bundled require() throws
// at runtime and ssh2 transparently falls back to pure-JS crypto (verified live).
//
// After bundling, THIRD-PARTY-NOTICES.txt is regenerated from the esbuild metafile
// so the license/copyright notices of every bundled package travel with the
// published artifact (the bundle inlines MIT/BSD deps whose licenses require it).
import { build } from "esbuild";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

// NOTE: no shebang here — esbuild preserves the entry file's own shebang
// (src/cli/index.ts) and hoists it to line 1, above this banner.
const banner =
  // CJS-compat shims for the bundled CommonJS deps (ssh2 etc.) under ESM output.
  "import{createRequire as __cr}from'module';" +
  "import{fileURLToPath as __ffu}from'url';" +
  "import{dirname as __dn}from'path';" +
  "const require=__cr(import.meta.url);" +
  "const __filename=__ffu(import.meta.url);" +
  "const __dirname=__dn(__filename);";

const result = await build({
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/cli/index.js",
  external: ["cpu-features", "*.node"],
  banner: { js: banner },
  legalComments: "none",
  metafile: true,
});
console.error("bundled -> dist/cli/index.js");

writeThirdPartyNotices(result.metafile);

/**
 * Regenerates THIRD-PARTY-NOTICES.txt from the set of npm packages esbuild actually
 * inlined into the bundle (read from the metafile inputs), so attribution is exact —
 * no more, no less than what is redistributed.
 */
function writeThirdPartyNotices(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    // input paths use forward slashes, e.g. "node_modules/ssh2/lib/x.js" or
    // "node_modules/@scope/pkg/index.js" (incl. nested node_modules).
    const m = input.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)(?:\/|$)/g);
    if (!m) continue;
    const last = m[m.length - 1].replace(/^.*node_modules\//, "").replace(/\/$/, "");
    names.add(last);
  }

  const sorted = [...names].sort();
  let out =
    "THIRD-PARTY SOFTWARE NOTICES\n" +
    "============================\n\n" +
    "coolify-mcp is distributed as a single self-contained bundle (dist/cli/index.js)\n" +
    "that inlines the following third-party packages. Their license and copyright\n" +
    "notices are reproduced below as required by their respective licenses.\n\n";

  for (const name of sorted) {
    const dir = join("node_modules", name);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue; // not a resolvable package root (defensive)
    }
    out += `\n${"=".repeat(72)}\n${pkg.name}@${pkg.version}  —  ${licenseOf(pkg)}\n${"=".repeat(72)}\n\n`;
    const text = readLicenseText(dir);
    out += (text ? text.trimEnd() : "(No bundled license file; see SPDX identifier above.)") + "\n";
  }

  writeFileSync("THIRD-PARTY-NOTICES.txt", out);
  console.error(`wrote THIRD-PARTY-NOTICES.txt (${sorted.length} bundled packages)`);
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type || l).join(", ");
  if (pkg.license && pkg.license.type) return pkg.license.type;
  return "see notice";
}

function readLicenseText(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const file = entries.find((e) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(e));
  if (!file) return undefined;
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}
