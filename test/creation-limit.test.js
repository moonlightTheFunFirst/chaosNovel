import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Store } from "../store.js";
import { createApp } from "../server.js";
const week = 7 * 24 * 60 * 60 * 1000;
test("seven days: failure, retry, deletion, other books, exact boundary and admins", () => {
  let now = Date.parse("2026-10-17T00:00:00Z");
  const s = new Store(":memory:", { now: () => now });
  try {
    const p = s.participant(),
      key = randomUUID();
    assert.throws(() => s.publish("題", 4000, p, key, ""));
    assert.equal(s.creationStatus(p).canCreate, true);
    const first = s.publish("題", 4000, p, key, "あ");
    const next = s.creationStatus(p).nextCreationAt;
    assert.equal(Date.parse(next), now + week);
    assert.deepEqual(s.publish("題", 4000, p, key, "あ"), first);
    assert.equal(s.creationStatus(p).nextCreationAt, next);
    assert.throws(
      () => s.publish("二冊目", 4000, p, randomUUID(), "い"),
      (e) => e.status === 429 && e.creation.nextCreationAt === next,
    );
    const other = s.publish(
      "別の人",
      4000,
      s.participant(),
      randomUUID(),
      "い",
    );
    assert.ok(s.post(other.id, p, randomUUID(), "続"));
    s.delete(first.id, true);
    assert.equal(s.creationStatus(p).canCreate, false);
    assert.deepEqual(s.publish("題", 4000, p, key, "あ"), first);
    for (let i = 0; i < 3; i++)
      s.publish("管理者", 4000, p, randomUUID(), "文", true);
    assert.equal(s.creationStatus(p, true).canCreate, true);
    assert.equal(s.creationStatus(p).nextCreationAt, next);
    now += week - 1;
    assert.throws(
      () => s.publish("早い", 4000, p, randomUUID(), "文"),
      (e) => e.status === 429,
    );
    now++;
    assert.ok(s.publish("七日後", 4000, p, randomUUID(), "文"));
    assert.equal(Date.parse(s.creationStatus(p).nextCreationAt), now + week);
  } finally {
    s.close();
  }
});
test("independent connections race: one creation, durable limit and idempotent recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-limit-")),
    path = join(dir, "test.sqlite");
  let s = new Store(path);
  try {
    const p = s.participant();
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      keys.map(
        (key) =>
          new Promise((resolve, reject) => {
            const worker = new Worker(
              new URL("../test-support/create-worker.js", import.meta.url),
              { workerData: { path, p, key } },
            );
            worker.on("message", resolve);
            worker.on("error", reject);
          }),
      ),
    );
    assert.equal(results.filter((r) => r.id).length, 1);
    assert.equal(results.filter((r) => r.status === 429).length, 1);
    assert.equal(s.list().length, 1);
    s.close();
    s = new Store(path);
    assert.equal(s.creationStatus(p).canCreate, false);
    const i = results.findIndex((r) => r.id);
    assert.deepEqual(s.publish("同時", 4000, p, keys[i], "あ"), results[i]);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP exposes creation eligibility and enforces server mode, preserving draft error metadata", async (t) => {
  const s = new Store(":memory:");
  const server = createApp(s, { adminMode: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    s.close();
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const session = await fetch(base + "/api/session");
  const cookie = session.headers.get("set-cookie").split(";")[0];
  assert.equal((await session.json()).creation.canCreate, true);
  const publish = (key) =>
    fetch(base + "/api/novels", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "本",
        capacity: 4000,
        text: "あ",
        key,
        isAdmin: true,
      }),
    });
  const key = randomUUID();
  assert.equal((await publish(key)).status, 200);
  assert.equal((await publish(key)).status, 200);
  const denied = await publish(randomUUID());
  assert.equal(denied.status, 429);
  assert.ok((await denied.json()).creation.nextCreationAt);
  const next = await fetch(base + "/api/session", { headers: { cookie } });
  assert.equal((await next.json()).creation.canCreate, false);
});
