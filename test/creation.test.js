import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../store.js";
import { sortBooks } from "../public/book-meta.js";
test("publication is atomic, idempotent, and consumes regular participation", () => {
  const s = new Store(":memory:");
  try {
    const p = s.participant(),
      key = randomUUID();
    for (const text of ["", "あ".repeat(401)]) {
      assert.throws(() => s.publish("題", 4000, p, key, text));
      assert.equal(s.list().length, 0);
    }
    const result = s.publish("題", 4000, p, key, "あ");
    const book = s.get(result.id, p);
    assert.equal(book.count, 1);
    assert.equal(book.posts.length, 1);
    assert.equal(book.created_at, book.updated_at);
    assert.deepEqual(s.publish("題", 4000, p, key, "あ"), result);
    assert.equal(s.list().length, 1);
    assert.throws(() => s.publish("別", 4000, p, key, "あ"));
    assert.throws(() => s.post(result.id, p, randomUUID(), "続"));
    assert.equal(s.get(result.id, p).updated_at, book.updated_at);
    s.db
      .prepare("UPDATE novels SET updated_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", result.id);
    const postKey = randomUUID();
    s.post(result.id, p, postKey, "続", true);
    const updated = s.get(result.id, p).updated_at;
    assert.notEqual(updated, "2000-01-01T00:00:00.000Z");
    s.post(result.id, p, postKey, "続", true);
    assert.equal(s.get(result.id, p).updated_at, updated);
    assert.equal(
      s.publish("長い", 4000, p, randomUUID(), "👩🏽‍💻".repeat(400)).id.length > 0,
      true,
    );
    assert.ok(s.publish("空白", 4000, p, randomUUID(), " "));
  } finally {
    s.close();
  }
});
test("all shelf sort directions and stable ties", () => {
  const books = [
    { id: "b", title: "い", created_at: "2020", updated_at: "2023" },
    { id: "a", title: "あ", created_at: "2021", updated_at: "2022" },
  ];
  for (const [order, expected] of [
    ["title:asc", "ab"],
    ["title:desc", "ba"],
    ["created_at:asc", "ba"],
    ["created_at:desc", "ab"],
    ["updated_at:asc", "ab"],
    ["updated_at:desc", "ba"],
  ])
    assert.equal(
      sortBooks(books, order)
        .map((b) => b.id)
        .join(""),
      expected,
    );
  assert.equal(books[0].id, "b");
});
