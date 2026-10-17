import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

await build({
  entryPoints: ["public/app.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/app.js",
  logLevel: "info",
});
const license = await readFile("node_modules/graphemer/LICENSE", "utf8");
await writeFile("dist/licenses.txt", `graphemer 1.4.0\n\n${license}`);
