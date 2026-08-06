import fs from "node:fs";
import path from "node:path";

function sourceFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(file));
    else if (/\.(ts|tsx|rs)$/.test(entry.name)) files.push(file);
  }
  return files;
}

const frontendFiles = sourceFiles("src");
const rustFiles = sourceFiles("src-tauri/src");
const frontendInvokes = new Map();
for (const file of frontendFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/\binvoke(?:<[^>]+>)?\s*\(\s*["']([^"']+)["']/g)) {
    const command = match[1];
    if (!frontendInvokes.has(command)) frontendInvokes.set(command, file);
  }
}

const rustCommands = new Map();
for (const file of rustFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/#\[tauri::command(?:\([^\]]*\))?\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g)) {
    rustCommands.set(match[1], file);
  }
}

const lib = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
const registered = new Set([...lib.matchAll(/::([A-Za-z0-9_]+),/g)].map((match) => match[1]));
const missingRegistration = [...frontendInvokes.keys()].filter((name) => !registered.has(name));
const unregisteredCommands = [...rustCommands.keys()].filter((name) => !registered.has(name));

if (missingRegistration.length || unregisteredCommands.length) {
  if (missingRegistration.length) {
    console.error(`Frontend commands without invoke_handler registration: ${missingRegistration.join(", ")}`);
  }
  if (unregisteredCommands.length) {
    console.error(`Rust commands without invoke_handler registration: ${unregisteredCommands.join(", ")}`);
  }
  process.exit(1);
}

console.log(`Checked ${frontendInvokes.size} frontend commands and ${rustCommands.size} Rust commands.`);
