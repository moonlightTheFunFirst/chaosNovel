import "../build.js";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
await mkdir(".workers-assets", { recursive: true });
for (const file of ["index.html", "style.css", "reading-room.css"])
  await copyFile("public/" + file, ".workers-assets/" + file);
for (const file of ["app.js", "licenses.txt"])
  await copyFile("dist/" + file, ".workers-assets/" + file);
await writeFile(
  ".workers-assets/_headers",
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
`,
);
