import { D1Store } from "./store.js";
import { workerIdentity } from "./identity.js";
import { login } from "./login.js";
import { AppError } from "../app-error.js";
const security = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
async function bodyJSON(request) {
  const reader = request.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) {
        await reader.cancel();
        throw new AppError("原稿が大きすぎます。", 413);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error();
    return data;
  } catch {
    throw new AppError("JSONが正しくありません。");
  }
}
export default {
  async fetch(request, env) {
    const headers = new Headers(security);
    headers.set("Cache-Control", "no-store");
    try {
      const url = new URL(request.url);
      const local =
        env.LOCAL_DEV === "1" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.protocol === "http:";
      if (
        !env.PUBLIC_ORIGIN ||
        url.origin !== env.PUBLIC_ORIGIN ||
        (request.headers.has("host") &&
          request.headers.get("host") !== url.host)
      )
        throw new AppError("許可されていないHostです。", 421);
      if (!local && (url.protocol !== "https:" || env.COOKIE_SECURE !== "1"))
        throw new Error("HTTPS and COOKIE_SECURE=1 required");
      if (env.ADMIN_PASSWORD && [...env.ADMIN_PASSWORD].length < 12 && !local)
        throw new Error("ADMIN_PASSWORD must have at least 12 characters");
      if (!["GET", "HEAD", "POST", "DELETE"].includes(request.method))
        throw new AppError("Method not allowed", 405);
      if (["POST", "DELETE"].includes(request.method)) {
        if (
          request.headers.get("sec-fetch-site") === "cross-site" ||
          (request.headers.has("origin") &&
            request.headers.get("origin") !== env.PUBLIC_ORIGIN)
        )
          throw new AppError("別のサイトからの送信はできません。", 403);
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new AppError("JSONが必要です。", 415);
      }
      if (!url.pathname.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(request.method))
          throw new AppError("Method not allowed", 405);
        const path =
          url.pathname === "/" || /^\/novels\/[\w-]+$/.test(url.pathname)
            ? "/index.html"
            : url.pathname;
        if (
          ![
            "/index.html",
            "/app.js",
            "/style.css",
            "/reading-room.css",
            "/licenses.txt",
          ].includes(path)
        )
          throw new AppError("Not found", 404);
        const asset = await env.ASSETS.fetch(
          new Request(new URL(path, url), { method: request.method }),
        );
        const response = new Response(asset.body, asset);
        for (const [k, v] of Object.entries(security))
          response.headers.set(k, v);
        return response;
      }
      const store = new D1Store(env.DB, {
          maxActiveNovels: env.MAX_ACTIVE_NOVELS ?? 30,
        }),
        identity = workerIdentity(store, env.COOKIE_SECRET, {
          password: env.ADMIN_PASSWORD,
        });
      const cookies = Object.fromEntries(
        (request.headers.get("cookie") || "")
          .split(";")
          .map((v) => v.trim().split("=")),
      );
      const person = identity.participant(cookies.participant),
        p = person.id;
      const attrs =
        "; HttpOnly; SameSite=Lax; Path=/" +
        (env.COOKIE_SECURE === "1" ? "; Secure" : "");
      if (person.token !== cookies.participant)
        headers.append(
          "Set-Cookie",
          "participant=" + person.token + attrs + "; Max-Age=31536000",
        );
      const admin = await identity.admin(p, cookies.admin),
        body = request.method === "POST" ? await bodyJSON(request) : null;
      let result;
      const path = url.pathname,
        method = request.method,
        match = path.match(/^\/api\/novels\/([\w-]+)(\/posts|\/finish)?$/);
      if (path === "/api/session" && method === "GET")
        result = {
          isAdmin: admin,
          creation: await store.creationStatus(p, admin),
        };
      else if (path === "/api/title-availability" && method === "POST")
        result = await store.titleAvailability(body.title);
      else if (path === "/api/admin" && method === "POST") {
        // Only Cloudflare's connection-derived header is used, never X-Forwarded-For.
        await login(
          store,
          env.ADMIN_PASSWORD,
          body.password,
          request.headers.get("CF-Connecting-IP") || "local",
          env.COOKIE_SECRET,
        );
        headers.append(
          "Set-Cookie",
          "admin=" + (await identity.adminToken(p)) + attrs + "; Max-Age=43200",
        );
        result = { isAdmin: true };
      } else if (path === "/api/admin" && method === "DELETE") {
        if (admin) await identity.revokeAdmin(p);
        headers.append("Set-Cookie", "admin=" + attrs + "; Max-Age=0");
        result = { isAdmin: false };
      } else if (path === "/api/novels" && method === "GET")
        result = await store.listPage(Object.fromEntries(url.searchParams));
      else if (path === "/api/novels" && method === "POST")
        result = await store.publish(
          body.title,
          body.capacity,
          p,
          body.key,
          body.text,
          admin,
        );
      else if (match && !match[2] && method === "GET")
        result = await store.get(
          match[1],
          p,
          url.searchParams.has("after")
            ? Number(url.searchParams.get("after"))
            : null,
        );
      else if (match?.[2] === "/finish" && method === "POST")
        result = await store.finish(match[1], admin);
      else if (match && !match[2] && method === "DELETE")
        result = await store.delete(match[1], admin);
      else if (match?.[2] && method === "POST")
        result = await store.post(match[1], p, body.key, body.text, admin);
      else throw new AppError("Not found", 404);
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(result), { headers });
    } catch (error) {
      if (!error.status) console.error(error);
      if (error.retryAfter)
        headers.set("Retry-After", String(error.retryAfter));
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(
        JSON.stringify({
          error: error.status
            ? error.message
            : "保存に失敗しました。同じ原稿を再送できます。",
          creation: error.creation,
        }),
        { status: error.status || 500, headers },
      );
    }
  },
};
