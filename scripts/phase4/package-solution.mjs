import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const output = path.join(root, "solution.zip");
const stagingParent = await mkdtemp(path.join(os.tmpdir(), "agent-engine-solution-"));
const solution = path.join(stagingParent, "solution");
const code = path.join(solution, "code");
const includedAtRoot = new Set([".github", ".gitignore", "README.md", "docs", "package-lock.json", "package.json", "scripts", "spikes", "src", "tests", "tsconfig.json"]);
const excludedDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const sensitiveBasenames = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|credentials(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i;
const sensitiveExtensions = /\.(?:key|pem|p12|pfx|jks|keystore)$/i;

function isSensitive(name) {
  return sensitiveBasenames.test(name) || sensitiveExtensions.test(name);
}

async function copyTree(source, target, relative = "") {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!relative && !includedAtRoot.has(entry.name)) continue;
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    if (entry.isFile() && isSensitive(entry.name)) throw new Error(`Refusing to package sensitive file: ${path.join(relative, entry.name)}`);
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, path.join(relative, entry.name));
    else if (entry.isFile()) await cp(from, to);
  }
}

try {
  await mkdir(solution, { recursive: true });
  await cp(path.join(root, "INSTRUCTION.md"), path.join(solution, "INSTRUCTION.md"));
  await copyTree(root, code);
  const tar = spawnSync("tar", ["-a", "-c", "-f", output, "solution"], { cwd: stagingParent, stdio: "inherit" });
  if (tar.status !== 0) throw new Error("tar failed while creating solution.zip");
  const archive = await stat(output);
  if (archive.size === 0) throw new Error("solution.zip is empty");
  const listing = execFileSync("tar", ["-tf", output], { encoding: "utf8" });
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.includes("solution/INSTRUCTION.md") || !entries.includes("solution/code/package.json")) throw new Error("solution.zip has an invalid layout");
  if (entries.some((entry) => /(?:node_modules|dist|coverage|\.git)\//.test(entry))) throw new Error("solution.zip contains a local dependency, build, or VCS directory");
  if (entries.some((entry) => isSensitive(path.basename(entry)))) throw new Error("solution.zip contains a sensitive file");
  console.log(`Created ${output} (${archive.size} bytes)`);
} finally {
  await rm(stagingParent, { recursive: true, force: true });
}
