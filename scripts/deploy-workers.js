import { execFileSync } from "node:child_process";
import { unstable_readConfig } from "wrangler";
import { validateDeployConfig } from "./deploy-config.js";
const args = process.argv.slice(2);
const checkOnly = args.length === 1 && args[0] === "--check";
if (
  !checkOnly &&
  !(
    args.length === 0 ||
    (args.length === 2 && args[0] === "--secrets-file" && args[1])
  )
)
  throw Error(
    "Use --check, or optionally --secrets-file <path> for deployment.",
  );
const config = unstable_readConfig({ config: "wrangler.jsonc", env: "" });
validateDeployConfig(config);
console.log(
  "Production configuration OK. Remote DB migrations and secret values are not checked.",
);
if (!checkOnly) {
  await import("./build-workers.js");
  execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "deploy", "--env", "", ...args],
    { stdio: "inherit" },
  );
}
