import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../store.js";
import { createApp } from "../server.js";
import {
  applyClosure,
  isFinished,
  bookStatus,
  finishReason,
} from "../public/book-state.js";
test("Node forced finish preserves text/count/revision, blocks all new posts, releases slot and keeps receipt", () => {
  const s = new Store(":memory:", { maxActiveNovels: 1 }),
    p = randomUUID(),
    key = randomUUID();
  try {
    const { id } = s.publish("終了", 4000, p, key, "あ", true),
      before = s.get(id, p);
    assert.throws(
      () => s.finish(id),
      (e) => e.status === 403,
    );
    s.finish(id, true);
    s.finish(id, true);
    const after = s.get(id, p);
    assert.equal(after.closed, 1);
    assert.equal(after.count, 1);
    assert.equal(after.revision, 1);
    assert.deepEqual(after.posts, before.posts);
    assert.equal(s.get(id, p, 1).closed, 1);
    assert.deepEqual(s.get(id, p, 1).posts, []);
    for (const admin of [false, true])
      assert.throws(
        () => s.post(id, randomUUID(), randomUUID(), "い", admin),
        (e) => e.status === 409,
      );
    assert.deepEqual(s.post(id, p, key, "あ", true), before.own);
    assert.equal(s.creationStatus(p, true).activeCount, 0);
    assert.equal(s.list({ filter: "writing" }).length, 0);
    assert.equal(s.list({ filter: "complete" })[0].id, id);
    assert.ok(s.publish("次", 4000, p, randomUUID(), "い", true).id);
    s.delete(id, true);
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM novel_closures").get().n,
      0,
    );
    assert.throws(
      () => s.finish("missing", true),
      (e) => e.status === 404,
    );
  } finally {
    s.close();
  }
});
test("Node finish API requires admin cookie and remains readable after logout", async (t) => {
  const s = new Store(":memory:");
  const server = createApp(s, {
    adminPassword: "test-password-long",
    cookieSecret: "s".repeat(40),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    s.close();
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  let cookie = "";
  async function call(path, body) {
    const r = await fetch(origin + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: { origin, "content-type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.getSetCookie();
    if (set.length)
      cookie = [cookie, ...set.map((c) => c.split(";")[0])]
        .filter(Boolean)
        .join("; ");
    return r;
  }
  await call("/session");
  const { id } = s.publish("API", 4000, randomUUID(), randomUUID(), "文");
  assert.equal((await call("/novels/" + id + "/finish", {})).status, 403);
  assert.equal(
    (await call("/admin", { password: "test-password-long" })).status,
    200,
  );
  assert.equal((await call("/novels/" + id + "/finish", {})).status, 200);
  assert.equal((await (await call("/novels/" + id)).json()).closed, 1);
});
test("closure-only delta changes metadata without moving the displayed text snapshot", () => {
  const posts = [{ sequence: 1, published: "原稿", count: 2 }],
    book = { count: 2, capacity: 4000, revision: 1, posts };
  assert.equal(applyClosure(book, { closed: 1, updated_at: "now" }), true);
  assert.equal(book.posts, posts);
  assert.equal(book.revision, 1);
  assert.equal(book.count, 2);
  assert.ok(isFinished(book));
  assert.equal(bookStatus(book), "執筆終了");
  assert.equal(applyClosure(book, { closed: 1 }), false);
});

test("finished display has a common status and separate reason for both completion paths", () => {
  const natural = { count: 4000, capacity: 4000 },
    forced = { count: 1, capacity: 4000, closed: 1 },
    writing = { count: 1, capacity: 4000 };
  assert.equal(bookStatus(natural), "執筆終了");
  assert.equal(bookStatus(forced), "執筆終了");
  assert.equal(finishReason(natural), "文字数到達");
  assert.equal(finishReason(forced), "管理者による終了");
  assert.equal(bookStatus(writing), "執筆中");
  assert.equal(finishReason(writing), "");
});
