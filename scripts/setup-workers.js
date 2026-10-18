import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
try {
  writeFileSync(
    ".dev.vars.local",
    `# Local development only. Edit ADMIN_PASSWORD to enable login.\nCOOKIE_SECRET=${randomBytes(32).toString("hex")}\nADMIN_PASSWORD=\n`.replaceAll(
      "\\n",
      "\n",
    ),
    { flag: "wx" },
  );
  console.log(
    "Created .dev.vars.local (persistent local signing key; admin login disabled).",
  );
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  console.log("Using existing .dev.vars.local.");
}
