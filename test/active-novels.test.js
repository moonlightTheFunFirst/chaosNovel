import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../store.js";
import { activeNovelLimit } from "../active-novels.js";
test("active limit configuration defaults to 30 and rejects invalid values", () => {
  assert.equal(activeNovelLimit(), 30);
  assert.equal(activeNovelLimit("100"), 100);
  for (const value of [0, -1, "", "x", 1.5, Infinity])
    assert.throws(() => activeNovelLimit(value));
});
test("Node active cap applies to admins, preserves retries and releases on completion/deletion", () => {
  const s = new Store(":memory:", { maxActiveNovels: 1 });
  const p = randomUUID(),
    key = randomUUID();
  try {
    const { id } = s.publish("一冊", 4000, p, key, "あ", true);
    assert.deepEqual(s.publish("一冊", 4000, p, key, "あ", true), { id });
    for (const admin of [false, true])
      assert.throws(
        () => s.publish("次", 4000, randomUUID(), randomUUID(), "い", admin),
        (e) => e.status === 409 && e.creation.activeLimitReached,
      );
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM creation_limits").get().n,
      0,
    );
    assert.equal(s.db.prepare("SELECT count(*) n FROM creations").get().n, 1);
    for (let i = 0; i < 9; i++)
      s.post(id, p, randomUUID(), "あ".repeat(400), true);
    s.post(id, p, randomUUID(), "あ".repeat(399), true);
    assert.equal(s.creationStatus(p, true).activeCount, 0);
    const second = s.publish("次", 4000, p, randomUUID(), "い", true).id;
    s.delete(second, true);
    assert.equal(s.creationStatus(p, true).canCreate, true);
  } finally {
    s.close();
  }
});
test("Node lower cap preserves existing books, 7-day cooldown remains after slot opens", () => {
  const s = new Store(":memory:", { maxActiveNovels: 1 }),
    p = randomUUID();
  try {
    const id = s.publish("本", 4000, p, randomUUID(), "あ").id;
    s.maxActiveNovels = 1;
    s.create("既存", 4000);
    assert.equal(s.creationStatus(p, true).activeCount, 2);
    assert.throws(
      () => s.publish("不可", 4000, randomUUID(), randomUUID(), "あ", true),
      (e) => e.status === 409,
    );
    s.delete(id, true);
    for (const b of s.db.prepare("SELECT id FROM novels").all())
      s.delete(b.id, true);
    assert.throws(
      () => s.publish("次", 4000, p, randomUUID(), "あ"),
      (e) => e.status === 429,
    );
  } finally {
    s.close();
  }
});
