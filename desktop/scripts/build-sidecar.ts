import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const hostTuple = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split(/\r?\n/)
  .find((l) => l.startsWith("host:"))
  ?.replace("host:", "")
  .trim();

if (!hostTuple) {
  throw new Error("Unable to determine Rust target triple via `rustc -vV`.");
}

const rootDir = path.resolve(import.meta.dirname, "../..");
const binDir = path.resolve(import.meta.dirname, "../src-tauri/binaries");
mkdirSync(binDir, { recursive: true });

const ext = hostTuple.includes("windows") ? ".exe" : "";
const outfile = path.join(binDir, `diffgloss-engine-${hostTuple}${ext}`);
const entry = path.join(rootDir, "src", "cli.ts");

console.log(`Compiling Diffgloss sidecar for ${hostTuple} -> ${outfile}`);
execFileSync("bun", ["build", "--compile", entry, "--outfile", outfile], {
  cwd: rootDir,
  stdio: "inherit",
});
console.log("Sidecar build complete.");
