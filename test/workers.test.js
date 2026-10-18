import { titleKeyStatements } from "../scripts/d1-title-keys.js";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { D1Store } from "../workers/store.js";
import { login } from "../workers/login.js";
import "../scripts/build-workers.js";
const password = "worker-test-password-long";
const bundled = await build({
  entryPoints: ["workers/index.js"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  external: ["node:*"],
  write: false,
});
const script = bundled.outputFiles[0].text;
const schema = readFileSync(
  new URL("../workers/migrations/0001_initial.sql", import.meta.url),
  "utf8",
);
const keySchema = readFileSync(
  new URL("../workers/migrations/0002_title_keys.sql", import.meta.url),
  "utf8",
);
async function migrateKeys(db) {
  // Trigger bodies contain semicolons; keep the trigger as one statement.
  const [ddl, trigger] = keySchema
    .replace(/--[^\n]*/g, "")
    .split("CREATE TRIGGER");
  await db.batch([
    ...ddl
      .split(";")
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
    db.prepare("CREATE TRIGGER" + trigger),
  ]);
  const rows = (
    await db.prepare("SELECT id,title,created_at FROM novels").all()
  ).results;
  await db.batch(titleKeyStatements(rows).map((s) => db.prepare(s)));
}
function options(extra = {}) {
  return {
    port: 18789,
    modules: true,
    script,
    compatibilityDate: "2026-10-18",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    bindings: {
      PUBLIC_ORIGIN: "http://127.0.0.1:18789",
      COOKIE_SECURE: "0",
      LOCAL_DEV: "1",
      COOKIE_SECRET: "test-secret-".repeat(4),
      ADMIN_PASSWORD: password,
    },
    assets: {
      routerConfig: { has_user_worker: true },
      directory: resolve(".workers-assets"),
      binding: "ASSETS",
      run_worker_first: ["/api/*", "/novels/*"],
    },
    ...extra,
  };
}
async function fixture(t, old = false) {
  const mf = new Miniflare(convertV4MiniflareOptions(options()));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await db.batch(
    schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  if (!old) await migrateKeys(db);
  await db
    .prepare(
      readFileSync(
        new URL(
          "../workers/migrations/0004_novel_closures.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
    .run();
  await db
    .prepare(
      readFileSync(
        new URL(
          "../workers/migrations/0003_active_novels.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
    .run();
  return { mf, db, store: new D1Store(db) };
}
function client(mf) {
  const jar = new Map();
  return {
    cookie: () => [...jar].map(([k, v]) => k + "=" + v).join("; "),
    async call(path, body, method = body ? "POST" : "GET", extra = {}) {
      const r = await mf.dispatchFetch("http://127.0.0.1:18789" + path, {
        method,
        headers: {
          cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          "content-type": "application/json",
          origin: "http://127.0.0.1:18789",
          ...extra,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      for (const c of r.headers.getSetCookie()) {
        const [k, v] = c.split(";")[0].split("=");
        jar.set(k, v);
      }
      return r;
    },
  };
}
const payload = (title = "本" + randomUUID(), text = "あ") => ({
  title,
  text,
  capacity: 4000,
  key: randomUUID(),
});
const err = (status) => (e) => e.status === status;

test("Workers HTTP: empty shelf, lazy participant, title validation, first passage and seven-day limit", async (t) => {
  const { mf, db } = await fixture(t),
    c = client(mf);
  assert.deepEqual(await (await c.call("/api/novels")).json(), {
    books: [],
    nextCursor: null,
  });
  for (let i = 0; i < 3; i++) await c.call("/api/session");
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM participants").first()).n,
    0,
  );
  const body = payload("ＡＢＣ", "👩🏽‍💻\r\n\t文");
  const r = await c.call("/api/novels", body);
  assert.equal(r.status, 200);
  const { id } = await r.json();
  assert.deepEqual(await (await c.call("/api/novels", body)).json(), { id });
  const book = await (await c.call("/api/novels/" + id)).json();
  assert.equal(book.count, 4);
  assert.equal(book.own.original, "👩🏽‍💻\n\t文");
  assert.equal((await c.call("/api/novels", payload())).status, 429);
  const other = client(mf);
  assert.equal(
    (await other.call("/api/novels", payload("a b\u200bc"))).status,
    400,
  );
  assert.deepEqual(
    await (
      await other.call("/api/title-availability", { title: "abc" })
    ).json(),
    { available: false },
  );
  for (const text of ["", "あ".repeat(401), "あ\0いう", "\u202e", "\ud800"])
    assert.equal(
      (await other.call("/api/novels", payload(undefined, text))).status,
      400,
    );
  assert.equal((await other.call("/api/novels", payload())).status, 200);
});

test("D1 concurrent publishing: title, participant limit and idempotency are atomic", async (t) => {
  const { store, db } = await fixture(t),
    p = randomUUID(),
    key = randomUUID();
  let results = await Promise.allSettled([
    store.publish("同時", 4000, p, key, "あ"),
    store.publish("同時", 4000, p, key, "あ"),
  ]);
  assert.ok(results.every((r) => r.status === "fulfilled"));
  assert.deepEqual(results[0].value, results[1].value);
  results = await Promise.allSettled([
    store.publish("一致", 4000, randomUUID(), randomUUID(), "あ"),
    store.publish(" 一 致 ", 4000, randomUUID(), randomUUID(), "い"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 400);
  const author = randomUUID();
  results = await Promise.allSettled([
    store.publish("一冊目", 4000, author, randomUUID(), "あ"),
    store.publish("二冊目", 4000, author, randomUUID(), "あ"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 429);
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM batch_guard").first()).n,
    0,
  );
});

test("D1 concurrent posts, one-post limit and ambiguous retry preserve exact results", async (t) => {
  const { store } = await fixture(t),
    id = (await store.publish("投稿", 4000, randomUUID(), randomUUID(), "初"))
      .id;
  const p = randomUUID(),
    key = randomUUID();
  const same = await Promise.all([
    store.post(id, p, key, "文"),
    store.post(id, p, key, "文"),
  ]);
  assert.deepEqual(same[0], same[1]);
  await assert.rejects(store.post(id, p, key, "変更"), err(409));
  await assert.rejects(store.post(id, p, randomUUID(), "続"), err(409));
  const author = randomUUID();
  const race = await Promise.allSettled([
    store.post(id, author, randomUUID(), "一"),
    store.post(id, author, randomUUID(), "二"),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  await Promise.all([
    store.post(id, randomUUID(), randomUUID(), "A"),
    store.post(id, randomUUID(), randomUUID(), "B"),
  ]);
  const book = await store.get(id, p);
  assert.equal(book.count, 5);
  assert.deepEqual(
    book.posts.map((x) => x.sequence),
    [1, 2, 3, 4, 5],
  );
  const delta = await store.get(id, p, 2);
  assert.equal(delta.posts.length, 3);
  assert.equal(Object.hasOwn(delta, "own"), false);
  assert.equal((await store.get(id, p, 5)).posts.length, 0);
});

test("D1 exact clipping and final-character race; rejected transactions leave no partial rows", async (t) => {
  const { store, db } = await fixture(t),
    admin = randomUUID();
  const id = (
    await store.publish(
      "残り150",
      4000,
      admin,
      randomUUID(),
      "あ".repeat(400),
      true,
    )
  ).id;
  for (let i = 0; i < 8; i++)
    await store.post(id, admin, randomUUID(), "あ".repeat(400), true);
  await store.post(id, admin, randomUUID(), "あ".repeat(250), true);
  const result = await store.post(
    id,
    randomUUID(),
    randomUUID(),
    "👨‍👩‍👧‍👦".repeat(400),
  );
  assert.equal(result.publishedCount, 150);
  assert.equal(result.total, 4000);
  assert.equal(result.unpublished, "👨‍👩‍👧‍👦".repeat(250));
  const last = (
    await store.publish(
      "残り1",
      4000,
      admin,
      randomUUID(),
      "あ".repeat(400),
      true,
    )
  ).id;
  for (let i = 0; i < 8; i++)
    await store.post(last, admin, randomUUID(), "あ".repeat(400), true);
  await store.post(last, admin, randomUUID(), "あ".repeat(399), true);
  const race = await Promise.allSettled([
    store.post(last, randomUUID(), randomUUID(), "一"),
    store.post(last, randomUUID(), randomUUID(), "二"),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(race.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal((await store.get(last, admin)).count, 4000);
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM batch_guard").first()).n,
    0,
  );
});

test("Workers real admin cookie: repeat posts, logout replay rejection, delete and creation retry", async (t) => {
  const { mf, db } = await fixture(t),
    c = client(mf);
  await c.call("/api/session");
  assert.equal((await c.call("/api/admin", { password })).status, 200);
  const body = payload(),
    { id } = await (await c.call("/api/novels", body)).json();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await c.call("/api/novels/" + id + "/posts", {
          text: "続",
          key: randomUUID(),
        })
      ).status,
      200,
    );
  const old = c.cookie();
  assert.equal((await c.call("/api/admin", {}, "DELETE")).status, 200);
  assert.equal(
    (
      await (
        await c.call("/api/session", undefined, "GET", { cookie: old })
      ).json()
    ).isAdmin,
    false,
  );
  assert.equal(
    (
      await c.call("/api/novels/" + id + "/posts", {
        text: "続",
        key: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal((await c.call("/api/novels/" + id, {}, "DELETE")).status, 403);
  const n = (await db.prepare("SELECT count(*) n FROM admin_epochs").first()).n;
  await client(mf).call("/api/admin", {}, "DELETE");
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM admin_epochs").first()).n,
    n,
  );
  await c.call("/api/admin", { password });
  assert.equal((await c.call("/api/novels/" + id, {}, "DELETE")).status, 200);
  assert.equal((await c.call("/api/novels", body)).status, 404);
  assert.equal((await c.call("/api/novels", payload(body.title))).status, 200);
});

test("Workers Host/Origin/cross-site/body size protection and deep reading URL", async (t) => {
  const { mf } = await fixture(t),
    c = client(mf);
  assert.equal(
    (await mf.dispatchFetch("https://evil.example/api/session")).status,
    421,
  );
  assert.equal(
    (
      await c.call("/api/admin", { password }, "POST", {
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await c.call("/api/admin", {}, "DELETE", {
        "sec-fetch-site": "cross-site",
      })
    ).status,
    403,
  );
  assert.equal(
    (await c.call("/api/novels", { text: "x".repeat(270000) })).status,
    413,
  );
  const page = await c.call("/novels/any-id");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /カオス小説/);
  assert.equal((await c.call("/api/missing")).status, 404);
});

test("D1 login limit persists across store instances, expires, and global failures delay instead of lock", async (t) => {
  const { db } = await fixture(t);
  let time = 1000000;
  let store = new D1Store(db, { now: () => time });
  const opts = { delay: async () => {} };
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      login(store, password, "wrong", "ip", "secret", opts),
      err(i === 4 ? 429 : 403),
    );
  store = new D1Store(db, { now: () => time });
  await assert.rejects(
    login(store, password, password, "ip", "secret", opts),
    err(429),
  );
  await login(store, password, password, "other", "secret", opts);
  time += 300000;
  await login(store, password, password, "ip", "secret", opts);
  for (let i = 0; i < 100; i++)
    await assert.rejects(
      login(store, password, "wrong", "ip" + i, "secret", opts),
      err(403),
    );
  const delays = [];
  await login(store, password, password, "fresh", "secret", {
    delay: async (ms) => delays.push(ms),
  });
  assert.equal(delays[0], 2500);
  await assert.rejects(
    login(store, "", "1234", "fresh", "secret", opts),
    err(503),
  );
});

test("D1 cursor ordering and filters continue without skipped or repeated books", async (t) => {
  const { store } = await fixture(t);
  for (const title of ["a", "c", "e"])
    await store.publish(title, 4000, randomUUID(), randomUUID(), "文");
  const first = await store.listPage({ sort: "title:asc", limit: 1 });
  await store.publish("b", 4000, randomUUID(), randomUUID(), "文");
  const rest = await store.listPage({
    sort: "title:asc",
    limit: 100,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    rest.books.map((b) => b.title),
    ["b", "c", "e"],
  );
  assert.equal((await store.listPage({ filter: "complete" })).books.length, 0);
  await assert.rejects(
    store.listPage({ cursor: first.nextCursor, sort: "title:desc" }),
    err(400),
  );
});

test("Workers restart preserves identity, limits and data; password rotation and disabled login", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-d1-"));
  let mf;
  t.after(async () => {
    if (mf) await mf.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (pass) => {
    const config = options();

    config.bindings.ADMIN_PASSWORD = pass;
    mf = new Miniflare({
      ...convertV4MiniflareOptions(config),
      resourcePersistencePath: dir,
    });
    return mf.getD1Database("DB");
  };
  let db = await start(password);
  await db.batch(
    schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  await migrateKeys(db);
  await db
    .prepare(
      readFileSync(
        new URL(
          "../workers/migrations/0004_novel_closures.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
    .run();
  const c = client(mf);
  await c.call("/api/session");
  const { id } = await (await c.call("/api/novels", payload())).json();
  const guest = c.cookie();
  await c.call("/api/admin", { password });
  const admin = c.cookie();
  await mf.dispose();
  mf = null;
  db = await start(password);
  const again = client(mf);
  assert.equal(
    (
      await again.call(
        "/api/novels/" + id + "/posts",
        { text: "続", key: randomUUID() },
        "POST",
        { cookie: guest },
      )
    ).status,
    409,
  );
  assert.equal(
    (await again.call("/api/novels", payload(), "POST", { cookie: guest }))
      .status,
    429,
  );
  assert.equal(
    (
      await (
        await again.call("/api/session", undefined, "GET", { cookie: admin })
      ).json()
    ).isAdmin,
    true,
  );
  await mf.dispose();
  mf = null;
  await start("changed-password-long");
  assert.equal(
    (
      await (
        await client(mf).call("/api/session", undefined, "GET", {
          cookie: admin,
        })
      ).json()
    ).isAdmin,
    false,
  );
  await mf.dispose();
  mf = null;
  await start("");
  assert.equal((await client(mf).call("/api/admin", { password })).status, 503);
});

test("D1 v2 migration preserves old colliding titles, rebuilds keys and prevents new duplicates", async (t) => {
  const { db, store } = await fixture(t, true);
  for (const [id, title] of [
    ["a", "ABC"],
    ["b", "ABC\u2800"],
  ])
    await db
      .prepare(
        "INSERT INTO novels(id,title,capacity,created_at,updated_at,title_key) VALUES (?,?,4000,?,?,?)",
      )
      .bind(id, title, "2020", "2020", title.toLowerCase())
      .run();
  await migrateKeys(db);
  const rows = (
    await db
      .prepare(
        "SELECT id,title,title_key_v2,title_legacy_duplicate FROM novels ORDER BY id",
      )
      .all()
  ).results;
  assert.deepEqual(
    rows.map((r) => [r.id, r.title_key_v2, r.title_legacy_duplicate]),
    [
      ["a", "abc", 0],
      ["b", "abc", 1],
    ],
  );
  assert.equal(rows[1].title, "ABC\u2800");
  await assert.rejects(
    store.publish("ABC\u2800", 4000, randomUUID(), randomUUID(), "あ"),
    err(400),
  );
  await store.delete("a", true);
  assert.equal((await store.titleAvailability("abc")).available, false);
  await assert.rejects(
    store.publish("abc", 4000, randomUUID(), randomUUID(), "あ"),
    err(400),
  );
  await store.delete("b", true);
  assert.ok(
    (await store.publish("ABC", 4000, randomUUID(), randomUUID(), "あ")).id,
  );
  const originals = (
    await db.prepare("SELECT id,title,created_at FROM novels").all()
  ).results;
  await db.prepare("UPDATE novels SET title_key_v2='stale'").run();
  await db.batch(titleKeyStatements(originals).map((s) => db.prepare(s)));
  assert.equal((await store.titleAvailability("ABC\u2800")).available, false);
  assert.match(
    (
      await db
        .prepare("SELECT value FROM app_meta WHERE key='title_key_version'")
        .first()
    ).value,
    /^2:/,
  );
  // A stale/incomplete export must roll back all changes in the rebuild batch.
  await assert.rejects(
    db.batch(titleKeyStatements([]).map((s) => db.prepare(s))),
  );
  assert.equal((await store.titleAvailability("ABC")).available, false);
});

test("D1 concurrent publishing respects global cap for admins and guests, releases slots and preserves retries", async (t) => {
  const { db } = await fixture(t);
  const store = new D1Store(db, { maxActiveNovels: 1 });
  const requests = [
    ["一", randomUUID(), randomUUID()],
    ["二", randomUUID(), randomUUID()],
  ];
  const results = await Promise.allSettled(
    requests.map(([title, p, key]) =>
      store.publish(title, 4000, p, key, "あ", true),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  const winner = results.findIndex((r) => r.status === "fulfilled"),
    [title, p, key] = requests[winner],
    { id } = results[winner].value;
  assert.deepEqual(await store.publish(title, 4000, p, key, "あ", true), {
    id,
  });
  await assert.rejects(
    store.publish("三", 4000, randomUUID(), randomUUID(), "あ"),
    (e) => e.status === 409 && e.creation.activeCount === 1,
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM creations").first()).n,
    1,
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM participants").first()).n,
    1,
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM batch_guard").first()).n,
    0,
  );
  for (let i = 0; i < 9; i++)
    await store.post(id, p, randomUUID(), "あ".repeat(400), true);
  await store.post(id, p, randomUUID(), "あ".repeat(399), true);
  assert.equal((await store.creationStatus(p, true)).activeCount, 0);
  const next = (
    await store.publish("三", 4000, randomUUID(), randomUUID(), "あ")
  ).id;
  await store.delete(next, true);
  assert.equal((await store.creationStatus(p, true)).canCreate, true);
});

test("D1 admin finish API preserves body and appears in completed shelf; posting race is atomic", async (t) => {
  const { mf, store, db } = await fixture(t),
    c = client(mf),
    p = randomUUID(),
    key = randomUUID();
  const { id } = await store.publish("終了", 4000, p, key, "文");
  assert.equal((await c.call("/api/novels/" + id + "/finish", {})).status, 403);
  await c.call("/api/admin", { password });
  const results = await Promise.allSettled([
    store.post(id, randomUUID(), randomUUID(), "続"),
    c.call("/api/novels/" + id + "/finish", {}),
  ]);
  assert.equal(results[1].value.status, 200);
  const book = await store.get(id, p);
  assert.equal(book.closed, 1);
  assert.equal(book.count, results[0].status === "fulfilled" ? 2 : 1);
  assert.equal(book.revision, book.posts.length);
  for (const admin of [false, true])
    await assert.rejects(
      store.post(id, randomUUID(), randomUUID(), "追加", admin),
      err(409),
    );
  assert.equal((await store.post(id, p, key, "文")).sequence, 1);
  assert.equal((await store.listPage({ filter: "complete" })).books[0].id, id);
  assert.equal((await store.listPage({ filter: "writing" })).books.length, 0);
  assert.equal((await store.creationStatus(p, true)).activeCount, 0);
  const delta = await store.get(id, p, book.revision);
  assert.equal(delta.closed, 1);
  assert.deepEqual(delta.posts, []);
  await store.finish(id, true);
  await store.delete(id, true);
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM novel_closures").first()).n,
    0,
  );
});

test("D1 capacity policy preserves retries and existing long books", async (t) => {
  const { db } = await fixture(t);
  const { capacityCases } = await import("../test-support/capacities.js");
  await capacityCases(
    (capacities) => new D1Store(db, { capacities }),
    async (table) =>
      (await db.prepare("SELECT count(*) n FROM " + table).first()).n,
    (id) =>
      db.prepare("UPDATE novels SET count=39999 WHERE id=?").bind(id).run(),
  );
});
test("Workers session and publish use admin cookie for capacity exemption", async (t) => {
  const { mf } = await fixture(t),
    c = client(mf);
  assert.deepEqual(
    (await (await c.call("/api/session")).json()).creation.capacities,
    [4000, 12000],
  );
  const body = { ...payload(), capacity: 40000 };
  assert.equal((await c.call("/api/novels", body)).status, 400);
  await c.call("/api/admin", { password });
  assert.deepEqual(
    (await (await c.call("/api/session")).json()).creation.capacities,
    [4000, 12000, 40000],
  );
  assert.equal((await c.call("/api/novels", body)).status, 200);
});
