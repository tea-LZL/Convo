import fs from "node:fs";

const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const tauri = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const versions = { package: packageVersion, cargo, tauri };
const unique = new Set(Object.values(versions));
if (unique.size !== 1 || !packageVersion) {
  console.error(`Version mismatch: ${JSON.stringify(versions)}`);
  process.exit(1);
}
console.log(`Version ${packageVersion} is consistent.`);
