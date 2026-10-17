import { adminLogin, clientAddressResolver } from "./admin-login.js";
import { cookieIdentity } from "./identity.js";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, AppError } from "./store.js";

export function createApp(
  store,
  {
    adminMode,
    cookieSecret = process.env.COOKIE_SECRET,
    publicOrigin = process.env.PUBLIC_ORIGIN,
    adminPassword = process.env.ADMIN_PASSWORD,
    now = Date.now,
    warn = console.warn,
    delay,
    trustProxy = process.env.TRUST_PROXY === "1",
    trustProxyHops = process.env.TRUST_PROXY_HOPS ?? 1,
    cookieSecure = process.env.COOKIE_SECURE === "1",
  } = {},
) {
  const clientAddress = clientAddressResolver(trustProxy, trustProxyHops);
  if ((publicOrigin || cookieSecure) && cookieSecret === undefined)
    warn(
      "COOKIE_SECRETが未設定です。公開時は環境変数で渡し、DBバックアップとは別に管理してください。",
    );
  const login = adminLogin({
    password: adminPassword,
    production: !!publicOrigin || cookieSecure,
    warn,
    delay,
    now,
  });
  const identity = cookieIdentity(store, cookieSecret, {
    password: adminPassword,
    now,
  });
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const host = req.headers.host;
      const port = req.socket.localPort;
      const suffix = port === 80 ? "" : ":" + port;
      const allowed = publicOrigin
        ? [new URL(publicOrigin).host]
        : ["localhost", "127.0.0.1", "[::1]"].map((h) => h + suffix);
      if (!allowed.includes(host))
        throw new AppError("許可されていないHostです。", 421);
      if (["POST", "DELETE"].includes(req.method)) {
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new AppError("別のサイトからの送信はできません。", 403);
        const expected = publicOrigin
          ? new URL(publicOrigin).origin
          : "http://" + host;
        if (req.headers.origin && req.headers.origin !== expected)
          throw new AppError("別のサイトからの送信はできません。", 403);
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new AppError("JSONが必要です。", 415);
      }
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
      const cookies = Object.fromEntries(
        (req.headers.cookie || "").split(";").map((v) => v.trim().split("=")),
      );
      const person = identity.participant(cookies.participant);
      const participant = person.id;
      const cookieAttrs =
        "; HttpOnly; SameSite=Lax; Path=/" + (cookieSecure ? "; Secure" : "");
      const responseCookies = [];
      if (person.token !== cookies.participant)
        responseCookies.push(
          "participant=" + person.token + cookieAttrs + "; Max-Age=31536000",
        );
      let isAdmin = adminMode ?? identity.admin(participant, cookies.admin);
      if (responseCookies.length) res.setHeader("Set-Cookie", responseCookies);
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
      if (url.pathname === "/api/title-availability" && req.method === "POST") {
        result = store.titleAvailability(body.title);
      } else if (url.pathname === "/api/admin" && req.method === "POST") {
        await login(clientAddress(req), body.password);
        responseCookies.push(
          "admin=" +
            identity.adminToken(participant) +
            cookieAttrs +
            "; Max-Age=43200",
        );
        res.setHeader("Set-Cookie", responseCookies);
        result = { isAdmin: true };
      } else if (url.pathname === "/api/admin" && req.method === "DELETE") {
        if (isAdmin) identity.revokeAdmin(participant);
        responseCookies.push("admin=" + cookieAttrs + "; Max-Age=0");
        res.setHeader("Set-Cookie", responseCookies);
        result = { isAdmin: false };
      } else if (url.pathname === "/api/session" && req.method === "GET")
        result = {
          isAdmin: isAdmin,
          creation: store.creationStatus(participant, isAdmin),
        };
      else if (url.pathname === "/api/novels" && req.method === "GET")
        result = store.listPage(Object.fromEntries(url.searchParams));
      else if (url.pathname === "/api/novels" && req.method === "POST")
        result = store.publish(
          body.title,
          body.capacity,
          participant,
          body.key,
          body.text,
          isAdmin,
        );
      else if (match && !match[2] && req.method === "GET")
        result = store.get(
          match[1],
          participant,
          url.searchParams.has("after")
            ? Number(url.searchParams.get("after"))
            : null,
        );
      else if (match && !match[2] && req.method === "DELETE")
        result = store.delete(match[1], isAdmin);
      else if (match?.[2] && req.method === "POST")
        result = store.post(
          match[1],
          participant,
          body.key,
          body.text,
          isAdmin,
        );
      else throw new AppError("Not found", 404);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
    } catch (error) {
      if (!error.status) console.error(error);
      res.statusCode = error.status || 500;
      if (error.retryAfter)
        res.setHeader("Retry-After", String(error.retryAfter));
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          creation: error.creation,
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
