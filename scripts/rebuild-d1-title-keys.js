import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { titleKeyStatements } from "./d1-title-keys.js";
const remote = process.argv.includes("--remote");
if (!remote && !process.argv.includes("--local"))
  throw Error("Specify --local or --remote explicitly");
if (remote && !process.argv.includes("--maintenance-confirmed"))
  throw Error("Stop all writes, back up D1, then pass --maintenance-confirmed");
const base = [
  "node_modules/wrangler/bin/wrangler.js",
  "d1",
  "execute",
  remote ? "chaos-novel-db" : "chaos-novel-local",
  remote ? "--remote" : "--local",
  ...(remote ? [] : ["--env", "local"]),
];
const run = (args) =>
  execFileSync(process.execPath, [...base, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
run([
  "--command",
  "UPDATE app_meta SET value='pending:2' WHERE key='title_key_version'",
]);
const output = run([
  "--command",
  "SELECT id,title,created_at FROM novels ORDER BY created_at,id",
  "--json",
]);
const rows = JSON.parse(output).flatMap((result) => result.results);
mkdirSync(".wrangler", { recursive: true });
const file = resolve(".wrangler/title-key-rebuild.sql");
writeFileSync(file, titleKeyStatements(rows).join(";\n") + ";\n");
// Wrangler D1 execute applies the SQL file transactionally. Never issue separate row writes.
run(["--file", file, "--yes"]);
console.log(
  `Rebuilt ${rows.length} title keys. Keep the database backed up before updating runtimes.`,
);
