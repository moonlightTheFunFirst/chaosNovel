import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, AppError } from "./store.js";

export function createApp(
  store,
  { adminMode = process.env.ADMIN_MODE !== "0" } = {},
) {
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      if (!url.pathname.startsWith("/api/")) {
        const files = {
          "/licenses.txt": ["dist/licenses.txt", "text/plain"],
          "/app.js": ["dist/app.js", "text/javascript"],
          "/style.css": ["public/style.css", "text/css"],
          "/reading-room.css": ["public/reading-room.css", "text/css"],
        };
        const target =
          files[url.pathname] ??
          (url.pathname === "/" || /^\/novels\/[\w-]+$/.test(url.pathname)
            ? ["public/index.html", "text/html"]
            : null);
        if (!target) throw new AppError("Not found", 404);
        res.setHeader("Content-Type", target[1] + "; charset=utf-8");
        res.end(readFileSync(new URL(target[0], import.meta.url)));
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "POST" || req.method === "DELETE") {
        const expected =
          process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expected)
          throw new AppError("別のサイトからの送信はできません。", 403);
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new AppError("JSONが必要です。", 415);
      }
      const cookie = req.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("participant="))
        ?.slice(12);
      const participant = store.participant(cookie);
      if (participant !== cookie)
        res.setHeader(
          "Set-Cookie",
          `participant=${participant}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`,
        );
      let body;
      if (req.method === "POST") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 262144) throw new AppError("原稿が大きすぎます。", 413);
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new AppError("JSONが正しくありません。");
        }
        if (!body || typeof body !== "object")
          throw new AppError("投稿形式が正しくありません。");
      }
      let result;
      const match = url.pathname.match(/^\/api\/novels\/([\w-]+)(\/posts)?$/);
      if (url.pathname === "/api/session" && req.method === "GET")
        result = { isAdmin: adminMode };
      else if (url.pathname === "/api/novels" && req.method === "GET")
        result = store.list();
      else if (url.pathname === "/api/novels" && req.method === "POST")
        result = store.publish(
          body.title,
          body.capacity,
          participant,
          body.key,
          body.text,
          adminMode,
        );
      else if (match && !match[2] && req.method === "GET")
        result = store.get(match[1], participant);
      else if (match && !match[2] && req.method === "DELETE")
        result = store.delete(match[1], adminMode);
      else if (match?.[2] && req.method === "POST")
        result = store.post(
          match[1],
          participant,
          body.key,
          body.text,
          adminMode,
        );
      else throw new AppError("Not found", 404);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
    } catch (error) {
      if (!error.status) console.error(error);
      res.statusCode = error.status || 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: error.status
            ? error.message
            : "保存に失敗しました。同じ原稿を再送できます。",
        }),
      );
    }
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const path = resolve(process.env.DB_PATH || "./data/novels.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const store = new Store(path);
  const server = createApp(store);
  server.listen(
    Number(process.env.PORT || 3000),
    process.env.HOST || "127.0.0.1",
    () =>
      console.log(
        `Local: http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}`,
      ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(() => {
        store.close();
        process.exit(0);
      }),
    );
}
