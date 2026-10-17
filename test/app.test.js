import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Store } from "../store.js";
import { createApp } from "../server.js";
import { split, count, normalize } from "../public/text.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "chaos-"));
  const path = join(dir, "test.sqlite");
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path };
}
function submit(
  store,
  id,
  text,
  participant = store.participant(),
  key = randomUUID(),
) {
  return store.post(id, participant, key, text);
}
function fill(store, id, n) {
  while (n > 0) {
    const length = Math.min(n, 400);
    submit(store, id, "文".repeat(length));
    n -= length;
  }
}
test("graphemes, newline normalization and clipping", () => {
  assert.equal(count("👨‍👩‍👧‍👦か\u3099🇯🇵\r\n "), 5);
  assert.equal(normalize("a\rb\r\nc"), "a\nb\nc");
  assert.deepEqual(split("👩🏽‍💻あ"), ["👩🏽‍💻", "あ"]);
});
test("1 and 400 accepted; empty/401 rejected without consuming participation", (t) => {
  const { store } = fixture(t);
  const a = store.create("題", 4000).id;
  const p = store.participant();
  assert.throws(() => submit(store, a, "", p), /1〜400/);
  assert.throws(() => submit(store, a, "文".repeat(401), p), /1〜400/);
  assert.equal(submit(store, a, "あ", p).publishedCount, 1);
  assert.equal(submit(store, a, "文".repeat(400)).publishedCount, 400);
  assert.equal(submit(store, a, " \n").publishedCount, 2);
  assert.throws(() => submit(store, a, "二回", p), /すでに/);
  assert.equal(
    submit(store, store.create("別の本", 4000).id, "別", p).publishedCount,
    1,
  );
});
test("idempotency survives completion and rejects changed payload", (t) => {
  const { store } = fixture(t);
  const id = store.create("題", 4000).id;
  fill(store, id, 3999);
  const p = store.participant(),
    key = randomUUID();
  const first = submit(store, id, "終わり", p, key);
  assert.deepEqual(submit(store, id, "終わり", p, key), first);
  assert.throws(() => submit(store, id, "変更", p, key), /変更できません/);
  assert.equal(store.get(id, p).count, 4000);
  assert.throws(() => submit(store, id, "あ"), /完結/);
});
test("last 150 graphemes published; original and remainder retained", (t) => {
  const { store } = fixture(t);
  const id = store.create("題", 4000).id;
  fill(store, id, 3850);
  const result = submit(store, id, "👨‍👩‍👧‍👦".repeat(400));
  assert.equal(result.publishedCount, 150);
  assert.equal(count(result.unpublished), 250);
  assert.equal(result.total, 4000);
  assert.equal(result.complete, true);
});
test("count is per-post sum and text is preserved literally", (t) => {
  const { store } = fixture(t);
  const id = store.create("<script>alert(1)</script>", 4000).id;
  submit(store, id, "あ");
  submit(store, id, "\u3099");
  submit(store, id, "<img src=x onerror=alert(1)>\r\n");
  const book = store.get(id, "none");
  assert.equal(book.count, 2 + count("<img src=x onerror=alert(1)>\n"));
  assert.equal(
    book.posts.map((p) => p.published).join(""),
    "あ\u3099<img src=x onerror=alert(1)>\n",
  );
});
test("persistent data is visible to a reopened connection", (t) => {
  const { store, path } = fixture(t);
  const id = store.create("保存", 12000).id,
    p = store.participant(),
    key = randomUUID();
  const result = submit(store, id, "保存する", p, key);
  const reopened = new Store(path);
  try {
    assert.equal(reopened.get(id, p).count, 4);
    assert.deepEqual(reopened.post(id, p, key, "保存する"), result);
  } finally {
    reopened.close();
  }
});
async function race(path, id, participants) {
  const gate = new SharedArrayBuffer(4);
  const flag = new Int32Array(gate);
  const workers = participants.map(
    (p) =>
      new Worker(new URL("../test-support/racer.js", import.meta.url), {
        workerData: { path, id, p, gate },
      }),
  );
  let ready = 0;
  const results = workers.map(
    (worker) =>
      new Promise((resolve, reject) => {
        worker.on("message", (m) => {
          if (m.ready) {
            if (++ready === workers.length) {
              Atomics.store(flag, 0, 1);
              Atomics.notify(flag, 0);
            }
          } else resolve(m);
        });
        worker.on("error", reject);
      }),
  );
  return Promise.all(results);
}

test("closed database reopens with complete 40,000-character novel", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-restart-"));
  const path = join(dir, "restart.sqlite");
  let store = new Store(path);
  try {
    const id = store.create("長編", 40000).id;
    fill(store, id, 40000);
    store.close();
    store = new Store(path);
    const book = store.get(id, "none");
    assert.equal(book.count, 40000);
    assert.equal(book.posts.length, 100);
    assert.equal(book.posts.map((p) => p.published).join("").length, 40000);
    assert.throws(() => submit(store, id, "あ"), /完結/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("title boundaries and allowed length classes", (t) => {
  const { store } = fixture(t);
  for (const title of ["", " \n", "あ".repeat(101)])
    assert.throws(() => store.create(title, 4000));
  for (const capacity of [4000, 12000, 40000])
    assert.ok(store.create("👩🏽‍💻".repeat(100), capacity).id);
  assert.throws(() => store.create("本", 100));
});
test("independent connections concurrently append all posts with unique sequence", async (t) => {
  const { store, path } = fixture(t);
  const id = store.create("同時", 4000).id;
  const ps = Array.from({ length: 6 }, () => store.participant());
  const results = await race(path, id, ps);
  assert.equal(results.filter((r) => r.ok).length, 6);
  const book = store.get(id, ps[0]);
  assert.equal(book.count, 6);
  assert.deepEqual(
    book.posts.map((p) => p.sequence),
    [1, 2, 3, 4, 5, 6],
  );
});
test("same participant race and last-character race each publish only once", async (t) => {
  const { store, path } = fixture(t);
  const id = store.create("同じ人", 4000).id,
    p = store.participant();
  assert.equal((await race(path, id, [p, p])).filter((r) => r.ok).length, 1);
  const last = store.create("最後", 4000).id;
  fill(store, last, 3999);
  assert.equal(
    (await race(path, last, [store.participant(), store.participant()])).filter(
      (r) => r.ok,
    ).length,
    1,
  );
  assert.equal(store.get(last, p).count, 4000);
});
test("HTTP independent cookies, repeat request, invalid input and origin", async (t) => {
  const { store } = fixture(t);
  const server = createApp(store, { adminMode: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const init = await fetch(base + "/api/novels");
  const cookie = init.headers.get("set-cookie").split(";")[0];
  const second = await fetch(base + "/api/novels");
  const cookie2 = second.headers.get("set-cookie").split(";")[0];
  assert.notEqual(cookie, cookie2);
  const request = (path, body, c = cookie, extra = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { cookie: c, "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  const created = await request("/api/novels", {
    title: "共有",
    text: "始",
    key: randomUUID(),
    capacity: 4000,
  });
  const { id } = await created.json();
  const payload = { key: randomUUID(), text: "あ" };
  const [one, two] = await Promise.all([
    request(`/api/novels/${id}/posts`, payload),
    request(`/api/novels/${id}/posts`, payload),
  ]);
  assert.deepEqual(await one.json(), await two.json());
  assert.equal(
    (
      await request(
        `/api/novels/${id}/posts`,
        { key: randomUUID(), text: "い" },
        cookie2,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/novels/${id}/posts`, payload, cookie, {
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/novels", null)).status, 400);
  const book = await (
    await fetch(base + `/api/novels/${id}`, { headers: { cookie } })
  ).json();
  assert.equal(book.count, 3);
  assert.ok(book.own);
});
