import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { Store } from "../store.js";
import { createApp } from "../server.js";
import { inspectInput, POST_UNITS, TITLE_UNITS } from "../public/text.js";
import {
  mergeDelta,
  visiblePolling,
  refreshAfterSuccess,
} from "../public/sync.js";
import { cookieIdentity } from "../identity.js";

test("A: data limits reject pathological graphemes; 400 normal emoji/ZWJ/combining clusters succeed", () => {
  const s = new Store(":memory:");
  try {
    const id = s.create("題", 40000).id;
    const huge = ("a" + "\u0301".repeat(100)).repeat(400);
    assert.equal(inspectInput(huge).count, null);
    assert.throws(
      () => s.post(id, s.participant(), randomUUID(), huge),
      /データ/,
    );
    assert.throws(() => s.create("a" + "\u0301".repeat(TITLE_UNITS), 4000));
    for (const cluster of ["😀", "👩🏽‍💻", "👨‍👩‍👧‍👦", "か\u3099"]) {
      const text = cluster.repeat(400);
      assert.equal(inspectInput(text).valid, true);
      assert.equal(
        s.post(id, s.participant(), randomUUID(), text).publishedCount,
        400,
      );
    }
    assert.equal(inspectInput("a".repeat(POST_UNITS + 1)).count, null);
    assert.equal(inspectInput("a".repeat(401)).valid, false);
    assert.equal(inspectInput("a" + "\u0301".repeat(31), true).valid, true);
  } finally {
    s.close();
  }
});
test("B: revision deltas are empty when unchanged and merge without duplication; gaps trigger recovery", () => {
  const s = new Store(":memory:");
  try {
    const p = s.participant(),
      id = s.create("本", 4000).id;
    const base = s.get(id, p);
    s.post(id, p, randomUUID(), "あ", true);
    const delta = s.get(id, p, 0);
    assert.equal(delta.posts.length, 1);
    const merged = mergeDelta(base, delta);
    assert.equal(merged.posts[0].published, "あ");
    const empty = s.get(id, p, 1);
    assert.deepEqual(empty.posts, []);
    assert.deepEqual(mergeDelta(merged, empty).posts, merged.posts);
    s.post(id, p, randomUUID(), "い", true);
    const second = s.get(id, p, 1);
    assert.equal(second.posts.length, 1);
    assert.equal(second.posts[0].sequence, 2);
    assert.equal(mergeDelta(merged, second).posts.length, 2);
    assert.throws(() => mergeDelta(base, second));
    assert.throws(() => mergeDelta(merged, { ...second, posts: [] }));
    assert.throws(() => s.get(id, p, -1));
  } finally {
    s.close();
  }
});
test("B: polling pauses while hidden and resumes immediately without overlapping requests", async () => {
  const doc = new EventTarget();
  doc.hidden = true;
  let scheduled = null,
    calls = 0,
    done;
  const stop = visiblePolling(
    doc,
    async () => {
      calls++;
      await new Promise((r) => (done = r));
    },
    {
      setTimeout: (fn) => {
        scheduled = fn;
        return 1;
      },
      clearTimeout: () => {
        scheduled = null;
      },
    },
  );
  assert.equal(scheduled, null);
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 1);
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 1);
  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  done();
  await new Promise((r) => setImmediate(r));
  assert.equal(scheduled, null);
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 2);
  done();
  await new Promise((r) => setImmediate(r));
  assert.ok(scheduled);
  stop();
  assert.equal(scheduled, null);
});
test("E: refresh failure is returned separately after successful posting", async () => {
  const failure = new Error("offline");
  const result = await refreshAfterSuccess(async () => {
    throw failure;
  });
  assert.equal(result.refreshError, failure);
  assert.equal(result.book, null);
  assert.deepEqual(await refreshAfterSuccess(async () => ({ revision: 3 })), {
    book: { revision: 3 },
    refreshError: null,
  });
});
test("E: bounded shelf pages and server sorting/filtering", () => {
  const s = new Store(":memory:");
  try {
    for (let i = 0; i < 105; i++) s.create(String(i).padStart(3, "0"), 4000);
    assert.equal(s.list().length, 30);
    assert.equal(s.list({ limit: 1000 }).length, 100);
    assert.equal(
      s.list({
        sort: "title:asc",
        cursor: s.listPage({ sort: "title:asc", limit: 30 }).nextCursor,
        limit: 1,
      })[0].title,
      "030",
    );
    assert.equal(s.list({ filter: "complete" }).length, 0);
    assert.throws(() => s.list({ sort: "title; DROP TABLE novels" }));
  } finally {
    s.close();
  }
});
async function fixture(t, options = {}) {
  const store = new Store(":memory:"),
    server = createApp(store, options);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
  });
  const port = server.address().port,
    base = "http://127.0.0.1:" + port;
  const call = (path, body, headers = {}, method = body ? "POST" : "GET") =>
    fetch(base + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { store, server, port, base, call };
}
test("C: anonymous reads do not insert; signed and legacy cookies register only on successful write", async (t) => {
  const { store, call } = await fixture(t, {
    cookieSecret: "test-secret".repeat(4),
  });
  for (let i = 0; i < 200; i++)
    assert.equal((await call("/api/novels")).status, 200);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM participants").get().n,
    0,
  );
  const session = await call("/api/session"),
    cookie = session.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /\./);
  const key = randomUUID(),
    body = { title: "本", capacity: 4000, text: "あ", key };
  const first = await call("/api/novels", body, { cookie });
  assert.equal(first.status, 200);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM participants").get().n,
    1,
  );
  assert.deepEqual(
    await (await call("/api/novels", body, { cookie })).json(),
    await first.json(),
  );
  const tampered = await call("/api/session", undefined, {
    cookie: cookie + "x",
  });
  assert.ok(tampered.headers.get("set-cookie"));
  const legacy = randomUUID();
  store.db.prepare("INSERT INTO participants VALUES (?)").run(legacy);
  const legacySession = await call("/api/session", undefined, {
    cookie: "participant=" + legacy,
  });
  assert.ok(legacySession.headers.get("set-cookie").includes("p:" + legacy));
  const id = store.create("別の本", 4000).id;
  const fresh = await call("/api/session");
  const freshCookie = fresh.headers.get("set-cookie").split(";")[0];
  const postBody = { key: randomUUID(), text: "い" };
  assert.equal(
    (
      await call("/api/novels/" + id + "/posts", postBody, {
        cookie: freshCookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/api/novels/" + id + "/posts",
        { ...postBody, key: randomUUID() },
        { cookie: freshCookie },
      )
    ).status,
    409,
  );
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
});
test("D: invalid Host, Origin and cross-site mutations rejected; valid local Origin accepted", async (t) => {
  const { call, base, port } = await fixture(t);
  // Raw HTTP ensures the Host header itself, not URL routing, is under test.
  const raw = (host, path = "/") =>
    new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path, headers: { host } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.equal(await raw("attacker.example:" + port), 421);
  assert.equal(await raw("localhost:1"), 421);
  const body = { title: "題", capacity: 4000, text: "あ", key: randomUUID() };
  for (const method of ["POST", "DELETE"]) {
    assert.equal(
      (
        await call(
          "/api/novels",
          body,
          { origin: "https://evil.example" },
          method,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/api/novels",
          body,
          { "sec-fetch-site": "cross-site", origin: base },
          method,
        )
      ).status,
      403,
    );
  }
  assert.equal((await call("/api/novels", body, { origin: base })).status, 200);
});
test("D: PUBLIC_ORIGIN restricts even local Host and accepts configured proxy Host", async (t) => {
  const { port } = await fixture(t, { publicOrigin: "https://books.example" });
  const send = (host) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/session",
          headers: { host },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.equal(await send("127.0.0.1:" + port), 421);
  assert.equal(await send("books.example"), 200);
});
test("admin: guest by default, password elevation is signed and bound to participant, logout", async (t) => {
  const { call } = await fixture(t, { adminPassword: "test-password-long" });
  const session = await call("/api/session");
  const cookie = session.headers.get("set-cookie").split(";")[0];
  assert.equal((await session.json()).isAdmin, false);
  assert.equal(
    (await call("/api/admin", { password: "wrong" }, { cookie })).status,
    403,
  );
  const login = await call(
    "/api/admin",
    { password: "test-password-long" },
    { cookie },
  );
  assert.equal(login.status, 200);
  const admin = login.headers.get("set-cookie").split(";")[0],
    combined = cookie + "; " + admin;
  assert.equal(
    (await (await call("/api/session", undefined, { cookie: combined })).json())
      .isAdmin,
    true,
  );
  assert.equal(
    (await (await call("/api/session", undefined, { cookie: admin })).json())
      .isAdmin,
    false,
  );
  assert.equal(
    (
      await (
        await call("/api/session", undefined, { cookie: combined + "x" })
      ).json()
    ).isAdmin,
    false,
  );
  const logout = await call("/api/admin", {}, { cookie: combined }, "DELETE");
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
});

test("HTTP delta endpoint and paged list parameters", async (t) => {
  const { store, call } = await fixture(t);
  const id = store.create("本", 4000).id,
    p = store.participant();
  store.post(id, p, randomUUID(), "あ", true);
  store.post(id, p, randomUUID(), "い", true);
  const delta = await (await call("/api/novels/" + id + "?after=1")).json();
  assert.equal(delta.posts.length, 1);
  assert.equal(delta.posts[0].sequence, 2);
  assert.equal(
    (await (await call("/api/novels/" + id + "?after=2")).json()).posts.length,
    0,
  );
  assert.equal((await call("/api/novels/" + id + "?after=no")).status, 400);
  assert.equal(
    (await (await call("/api/novels?limit=1")).json()).books.length,
    1,
  );
  assert.equal((await call("/api/novels?offset=-1")).status, 400);
});
test("forged Host and matching malicious Origin cannot authorize writes", async (t) => {
  const { port, store } = await fixture(t);
  for (const method of ["POST", "DELETE"]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/novels",
          method,
          headers: {
            host: "evil.example:" + port,
            origin: "http://evil.example:" + port,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          title: "x",
          capacity: 4000,
          text: "x",
          key: randomUUID(),
        }),
      );
    });
    assert.equal(status, 421);
  }
  assert.equal(store.list().length, 0);
});
test("non-ASCII forged signatures are rejected without throwing", () => {
  const store = new Store(":memory:");
  try {
    const identity = cookieIdentity(store, "test".repeat(8));
    assert.ok(
      identity.participant("p:" + randomUUID() + "." + "é".repeat(43)).id,
    );
    assert.equal(
      identity.admin("anything", "a:x:9999999999999." + "é".repeat(43)),
      false,
    );
  } finally {
    store.close();
  }
});
