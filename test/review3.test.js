import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { createApp } from "../server.js";
import { adminLogin, clientAddressResolver } from "../admin-login.js";
import { readFileSync } from "node:fs";
const password = "test-strong-password";
async function fixture(t, options = {}) {
  const store = new Store(":memory:");
  const server = createApp(store, { adminPassword: password, ...options });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
  });
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    store,
    call: (method = "POST", ip = "192.0.2.1", pass = password, cookie = "") =>
      fetch(base + "/api/admin", {
        method,
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
          cookie,
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ password: pass }) }
          : {}),
      }),
  };
}
test("trusted proxy separates login failures; untrusted forwarding is ignored", async (t) => {
  for (const trustProxy of [true, false]) {
    const app = await fixture(t, { trustProxy });
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await app.call("POST", "192.0.2.1", "bad")).status,
        i === 4 ? 429 : 403,
      );
    assert.equal(
      (await app.call("POST", "192.0.2.2")).status,
      trustProxy ? 200 : 429,
    );
    assert.equal((await app.call("POST", "192.0.2.1")).status, 429);
  }
});
test("proxy hop selection, malformed headers and settings", () => {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "198.51.100.1, 192.0.2.2, 192.0.2.3" },
  };
  assert.equal(clientAddressResolver(true)(req), "192.0.2.3");
  assert.equal(clientAddressResolver(true, 2)(req), "192.0.2.2");
  assert.equal(clientAddressResolver(false)(req), "127.0.0.1");
  assert.equal(clientAddressResolver(true, 4)(req), "127.0.0.1");
  req.headers["x-forwarded-for"] = "bad";
  assert.equal(clientAddressResolver(true)(req), "127.0.0.1");
  for (const hops of [0, -1, 1.5, "bad"])
    assert.throws(() => clientAddressResolver(true, hops));
});
test("global pressure delays real HTTP login without globally locking it", async (t) => {
  const delays = [];
  const app = await fixture(t, {
    trustProxy: true,
    delay: async (ms) => delays.push(ms),
  });
  for (let i = 0; i < 120; i++)
    assert.equal(
      (await app.call("POST", "192.0.2." + (i + 1), "bad")).status,
      403,
    );
  assert.equal((await app.call("POST", "198.51.100.1")).status, 200);
  assert.equal(delays.at(-1), 3000);
  assert.ok(delays.every((ms) => ms <= 3000));
});
test("IP records evict oldest at 10000, preserving recent lockouts", async () => {
  const login = adminLogin({ password, now: () => 0, delay: async () => {} });
  for (let i = 0; i < 5; i++) await assert.rejects(login("old", "bad"));
  for (let i = 0; i < 9999; i++) await assert.rejects(login("ip" + i, "bad"));
  await assert.rejects(login("old", password), (e) => e.status === 429);
  await assert.rejects(login("overflow", "bad"));
  await login("old", password);
  for (let i = 0; i < 4; i++) await assert.rejects(login("overflow", "bad"));
  await assert.rejects(login("overflow", password), (e) => e.status === 429);
});
test("guest logout writes no admin epochs; authenticated logout revokes token", async (t) => {
  const app = await fixture(t);
  for (let i = 0; i < 50; i++) {
    const r = await app.call("DELETE");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { isAdmin: false });
    assert.ok(
      r.headers
        .getSetCookie()
        .some((v) => v.startsWith("admin=") && v.includes("Max-Age=0")),
    );
  }
  assert.equal(
    app.store.db.prepare("SELECT count(*) AS n FROM admin_epochs").get().n,
    0,
  );
  const r = await app.call();
  const cookie = r.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  await app.call("DELETE", "192.0.2.1", password, cookie);
  assert.equal(
    app.store.db.prepare("SELECT count(*) AS n FROM admin_epochs").get().n,
    1,
  );
  await app.call("DELETE", "192.0.2.1", password, cookie);
  assert.equal(
    app.store.db.prepare("SELECT epoch FROM admin_epochs").get().epoch,
    1,
  );
});
test("code point title order and cursor agree with Japanese, numbers, supplementary characters and ties", () => {
  const store = new Store(":memory:");
  try {
    // Simulate legacy duplicates before the new insert guard.

    const titles = ["ア", "あ", "本2", "本10", "本2", "😀", "𠀀", "２"];
    const books = titles.map((title, i) => {
      const id = "legacy" + i;
      store.db
        .prepare(
          "INSERT INTO novels(id,title,capacity,created_at,updated_at,title_key,title_legacy_duplicate) VALUES (?,?,4000,?,?,?,1)",
        )
        .run(id, title, "2026", "2026", title);
      return { title, id };
    });
    for (const direction of ["asc", "desc"]) {
      const expected = [...books].sort(
        (a, b) =>
          (direction === "asc" ? 1 : -1) *
            Buffer.compare(Buffer.from(a.title), Buffer.from(b.title)) ||
          (a.id < b.id ? -1 : 1),
      );
      let cursor = null,
        found = [];
      do {
        const page = store.listPage({
          sort: "title:" + direction,
          limit: 2,
          cursor,
        });
        found.push(...page.books.map((b) => b.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(
        found,
        expected.map((b) => b.id),
      );
      assert.equal(new Set(found).size, titles.length);
    }
    const ui = readFileSync(
      new URL("../public/app.js", import.meta.url),
      "utf8",
    );
    assert.ok(ui.includes("本の名前：コードポイント昇順"));
    assert.ok(ui.includes("本の名前：コードポイント降順"));
  } finally {
    store.close();
  }
});
test("production warns on DB signing key fallback only", () => {
  const store = new Store(":memory:");
  try {
    for (const config of [
      { publicOrigin: "https://books.example" },
      { cookieSecure: true },
    ]) {
      const warnings = [];
      createApp(store, {
        ...config,
        adminPassword: password,
        warn: (m) => warnings.push(m),
      });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /COOKIE_SECRET/);
      createApp(store, {
        ...config,
        adminPassword: password,
        cookieSecret: "x".repeat(32),
        warn: (m) => warnings.push(m),
      });
      assert.equal(warnings.length, 1);
    }
    const warnings = [];
    createApp(store, {
      adminPassword: password,
      warn: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 0);
  } finally {
    store.close();
  }
});
