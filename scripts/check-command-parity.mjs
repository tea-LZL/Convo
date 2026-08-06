import fs from "node:fs";

const api = fs.readFileSync("src/lib/api.ts", "utf8");
const rust = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
const invokes = [...api.matchAll(/invoke(?:<[^>]+>)?\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
const registered = new Set([...rust.matchAll(/::([a-zA-Z0-9_]+),/g)].map((m) => m[1]));
const aliases = new Set(["list_models_for_provider", "list_all_models"]);
const missing = invokes.filter((name) => !registered.has(name) && !aliases.has(name));
if (missing.length) {
  console.error(`Missing Tauri registrations: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`Checked ${invokes.length} frontend commands.`);
