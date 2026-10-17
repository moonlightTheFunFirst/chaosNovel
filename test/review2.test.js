import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { createApp } from "../server.js";
import { adminLogin } from "../admin-login.js";
import { cookieIdentity } from "../identity.js";
import { inspectInput } from "../public/text.js";
import { mergeDelta } from "../public/sync.js";
const password = "test-only-strong-password";
async function start(store, options = {}) {
  const server = createApp(store, options);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    close: () => new Promise((r) => server.close(r)),
    call: (
      path,
      body,
      cookie = "",
      method = body ? "POST" : "GET",
      extra = {},
    ) =>
      fetch(base + path, {
        method,
        headers: {
          cookie,
          ...(body ? { "content-type": "application/json" } : {}),
          ...extra,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
  };
}
async function fixture(t, options = {}) {
  const store = new Store(":memory:");
  const app = await start(store, options);
  t.after(async () => {
    await app.close();
    store.close();
  });
  return { ...app, store };
}
async function guest(app) {
  const response = await app.call("/api/session");
  assert.equal((await response.json()).isAdmin, false);
  return response.headers.get("set-cookie").split(";")[0];
}
async function elevate(app, cookie, pass = password) {
  const response = await app.call("/api/admin", { password: pass }, cookie);
  assert.equal(response.status, 200);
  return cookie + "; " + response.headers.get("set-cookie").split(";")[0];
}
const manuscript = () => ({ text: "あ", key: randomUUID() });

test("login disabled without ADMIN_PASSWORD; no implicit default", async (t) => {
  const app = await fixture(t, { adminPassword: "" }),
    cookie = await guest(app);
  assert.equal(
    (await app.call("/api/admin", { password: "1234" }, cookie)).status,
    503,
  );
  assert.equal((await app.call("/api/admin", {}, cookie)).status, 503);
});
test("five failed attempts block even correct passwords for five minutes, ignoring spoofed forwarding", async (t) => {
  let now = 1000000;
  const app = await fixture(t, { adminPassword: password, now: () => now }),
    cookie = await guest(app);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (
        await app.call("/api/admin", { password: "bad" }, cookie, "POST", {
          "x-forwarded-for": String(i),
        })
      ).status,
      403,
    );
  const blocked = await app.call("/api/admin", { password: "bad" }, cookie);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "300");
  assert.equal(
    (await app.call("/api/admin", { password }, cookie)).status,
    429,
  );
  now += 299999;
  assert.equal(
    (await app.call("/api/admin", { password }, cookie)).status,
    429,
  );
  now++;
  await elevate(app, cookie);
});
test("global failures delay but do not block another IP, and expire", async () => {
  let time = 0;
  const delays = [];
  const login = adminLogin({
    password,
    now: () => time,
    delay: async (ms) => delays.push(ms),
  });
  for (let i = 0; i < 100; i++)
    await assert.rejects(login("ip" + i, "bad"), (e) => e.status === 403);
  await login("new-ip", password);
  assert.equal(delays.at(-1), 2500);
  const before = delays.length;
  time = 300000;
  await login("new-ip", password);
  assert.equal(delays.length, before);
});

test("production password minimum, development warning and secret minimum validated at startup", () => {
  const store = new Store(":memory:");
  try {
    for (const settings of [
      { publicOrigin: "https://books.example" },
      { cookieSecure: true },
    ])
      assert.throws(
        () => createApp(store, { ...settings, adminPassword: "short" }),
        /12文字/,
      );
    assert.throws(() => createApp(store, { cookieSecret: "short" }), /32文字/);
    const warnings = [];
    adminLogin({
      password: "short",
      warn: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1);
    assert.doesNotThrow(() =>
      createApp(store, {
        publicOrigin: "https://books.example",
        adminPassword: "",
      }),
    );
  } finally {
    store.close();
  }
});
test("real password login supports repeated posts and deletion; logout revokes copied token", async (t) => {
  const app = await fixture(t, { adminPassword: password }),
    cookie = await guest(app),
    admin = await elevate(app, cookie);
  const id = app.store.create("本", 4000).id;
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await app.call("/api/novels/" + id + "/posts", manuscript(), admin))
        .status,
      200,
    );
  const full = await (
    await app.call("/api/novels/" + id, undefined, admin)
  ).json();
  assert.equal(full.own.sequence, 2);
  const delta = await (
    await app.call("/api/novels/" + id + "?after=2", undefined, admin)
  ).json();
  assert.equal(Object.hasOwn(delta, "own"), false);
  assert.deepEqual(delta.posts, []);
  const another = app.store.create("削除", 4000).id;
  assert.equal(
    (await app.call("/api/novels/" + another, {}, admin, "DELETE")).status,
    200,
  );
  assert.equal((await app.call("/api/admin", {}, admin, "DELETE")).status, 200);
  assert.equal(
    (await (await app.call("/api/session", undefined, admin)).json()).isAdmin,
    false,
  );
  assert.equal(
    (await app.call("/api/novels/" + id + "/posts", manuscript(), admin))
      .status,
    409,
  );
  assert.equal(
    (await app.call("/api/novels/" + id, {}, admin, "DELETE")).status,
    403,
  );
  assert.equal(
    (await app.call("/api/novels/" + id + "/posts", manuscript(), cookie))
      .status,
    409,
  );
  await elevate(app, cookie);
  assert.equal(
    (await (await app.call("/api/session", undefined, admin)).json()).isAdmin,
    false,
  );
});
test("persistent signing key preserves participant, one-post limit and seven-day limit across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-auth-")),
    path = join(dir, "books.sqlite");
  let store = new Store(path),
    app = await start(store, { adminPassword: password });
  try {
    const cookie = await guest(app);
    const published = await app.call(
      "/api/novels",
      { title: "本", capacity: 4000, ...manuscript() },
      cookie,
    );
    assert.equal(published.status, 200);
    const { id } = await published.json();
    const key = store.db
      .prepare("SELECT value FROM app_meta WHERE key='cookie_secret'")
      .get().value;
    assert.equal(key.length, 64);
    await app.close();
    store.close();
    store = new Store(path);
    app = await start(store, { adminPassword: password });
    const session = await app.call("/api/session", undefined, cookie);
    assert.equal(session.headers.get("set-cookie"), null);
    assert.equal((await session.json()).creation.canCreate, false);
    assert.equal(
      (await app.call("/api/novels/" + id + "/posts", manuscript(), cookie))
        .status,
      409,
    );
    assert.equal(
      (
        await app.call(
          "/api/novels",
          { title: "二冊目", capacity: 4000, ...manuscript() },
          cookie,
        )
      ).status,
      429,
    );
    assert.equal(
      store.db
        .prepare("SELECT value FROM app_meta WHERE key='cookie_secret'")
        .get().value,
      key,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("password rotation and persisted logout epochs invalidate previous admin cookies after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-revoke-")),
    path = join(dir, "books.sqlite");
  let store = new Store(path),
    app = await start(store, { adminPassword: password });
  try {
    const cookie = await guest(app),
      old = await elevate(app, cookie);
    await app.close();
    store.close();
    store = new Store(path);
    app = await start(store, { adminPassword: password + "-changed" });
    assert.equal(
      (await (await app.call("/api/session", undefined, old)).json()).isAdmin,
      false,
    );
    const current = await elevate(app, cookie, password + "-changed");
    await app.call("/api/admin", {}, current, "DELETE");
    await app.close();
    store.close();
    store = new Store(path);
    app = await start(store, { adminPassword: password + "-changed" });
    assert.equal(
      (await (await app.call("/api/session", undefined, current)).json())
        .isAdmin,
      false,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("configured secret overrides DB key; legacy unsigned participant migration retained", () => {
  const store = new Store(":memory:");
  try {
    const id = randomUUID();
    store.db.prepare("INSERT INTO participants VALUES (?)").run(id);
    const persistent = cookieIdentity(store),
      old = persistent.participant(id);
    assert.equal(old.id, id);
    assert.equal(cookieIdentity(store).participant(old.token).id, id);
    const configured = cookieIdentity(store, "override-".repeat(8));
    assert.notEqual(configured.participant(old.token).id, id);
    assert.equal(configured.participant(id).id, id);
  } finally {
    store.close();
  }
});
test("unchanged own omitted from deltas, full fetch and new own returned, merge preserves receipt", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create("本", 4000).id,
      p = store.participant();
    store.post(id, p, randomUUID(), "あ");
    const full = store.get(id, p);
    assert.ok(full.own);
    const empty = store.get(id, p, 1);
    assert.equal(Object.hasOwn(empty, "own"), false);
    assert.equal(mergeDelta(full, empty).own, full.own);
    const newer = store.get(id, p, 0);
    assert.ok(newer.own);
    assert.equal(newer.own.sequence, 1);
    store.post(id, store.participant(), randomUUID(), "い");
    const delta = store.get(id, p, 1);
    assert.equal(Object.hasOwn(delta, "own"), false);
    assert.deepEqual(mergeDelta(full, delta).own, full.own);
  } finally {
    store.close();
  }
});
test("cursor pages survive insert/delete between pages in all six sort orders and tie keys", () => {
  for (const sort of [
    "title:asc",
    "title:desc",
    "created_at:asc",
    "created_at:desc",
    "updated_at:asc",
    "updated_at:desc",
  ]) {
    const store = new Store(":memory:");
    try {
      for (let i = 0; i < 8; i++) {
        const { id } = store.create(String(i >> 1), 4000);
        store.db
          .prepare("UPDATE novels SET created_at=?,updated_at=? WHERE id=?")
          .run(String(i >> 1), String(i >> 1), id);
      }
      const expected = store.list({ sort, limit: 100 }).map((b) => b.id),
        first = store.listPage({ sort, limit: 3 });
      store.delete(first.books.at(-1).id, true);
      const { id } = store.create(sort.endsWith("asc") ? "!" : "z", 4000);
      store.db
        .prepare("UPDATE novels SET created_at=?,updated_at=? WHERE id=?")
        .run(
          sort.endsWith("asc") ? "!" : "z",
          sort.endsWith("asc") ? "!" : "z",
          id,
        );
      let cursor = first.nextCursor,
        remaining = [];
      while (cursor) {
        const page = store.listPage({ sort, limit: 2, cursor });
        remaining.push(...page.books.map((b) => b.id));
        cursor = page.nextCursor;
      }
      assert.deepEqual(remaining, expected.slice(3));
      assert.throws(() =>
        store.listPage({
          cursor: first.nextCursor,
          sort: sort === "title:asc" ? "title:desc" : "title:asc",
        }),
      );
      assert.throws(() => store.listPage({ cursor: "not-json" }));
    } finally {
      store.close();
    }
  }
});
test("32 code points per cluster accepts boundary and ordinary 400 emoji; rejects 33 in both fields", () => {
  const good = "a" + "\u0301".repeat(31),
    bad = good + "\u0301";
  const store = new Store(":memory:");
  try {
    assert.equal(inspectInput(good.repeat(400)).valid, true);
    assert.equal(inspectInput(bad.repeat(400)).valid, false);
    assert.equal(inspectInput(good.repeat(100), true).valid, true);
    assert.equal(inspectInput(bad, true).valid, false);
    const { id } = store.create("本", 4000);
    assert.throws(
      () => store.post(id, store.participant(), randomUUID(), bad),
      /32/,
    );
    assert.throws(() => store.create(bad, 4000));
    for (const cluster of ["👩🏽‍💻", "👨‍👩‍👧‍👦", "か\u3099"])
      assert.equal(
        store.post(id, store.participant(), randomUUID(), cluster.repeat(400))
          .publishedCount,
        400,
      );
  } finally {
    store.close();
  }
});

test("HTTP cursor continuation returns existing remainder after a new first book", async (t) => {
  const app = await fixture(t);
  for (const title of ["b", "c", "d"]) app.store.create(title, 4000);
  const page = await (
    await app.call("/api/novels?limit=1&sort=title:asc")
  ).json();
  assert.equal(page.books[0].title, "b");
  assert.ok(page.nextCursor);
  app.store.create("a", 4000);
  const rest = await (
    await app.call(
      "/api/novels?limit=10&sort=title:asc&cursor=" +
        encodeURIComponent(page.nextCursor),
    )
  ).json();
  assert.deepEqual(
    rest.books.map((b) => b.title),
    ["c", "d"],
  );
  assert.equal(rest.nextCursor, null);
});
