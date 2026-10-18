import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../store.js";
import { createApp } from "../server.js";

test("admin repeats posts; old retries stay idempotent; completion still applies", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create("管理者", 4000).id,
      p = store.participant(),
      key = randomUUID();
    const first = store.post(id, p, key, "あ", true);
    store.post(id, p, randomUUID(), "い", true);
    assert.deepEqual(store.post(id, p, key, "あ", true), first);
    assert.equal(store.get(id, p).count, 2);
    assert.equal(store.get(id, p).own.original, "い");
    assert.throws(() => store.post(id, p, key, "変更", true), /変更/);
    assert.throws(() => store.post(id, p, randomUUID(), "あ"), /すでに/);
    for (let i = 0; i < 10; i++)
      store.post(id, p, randomUUID(), "文".repeat(400), true);
    assert.equal(store.get(id, p).count, 4000);
    assert.throws(() => store.post(id, p, randomUUID(), "あ", true), /完結/);
  } finally {
    store.close();
  }
});

test("v1 migration preserves posts, supports admin repetition and atomic deletion", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-migrate-")),
    path = join(dir, "old.sqlite");
  const old = new DatabaseSync(path);
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
    .replace(
      " is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),",
      "",
    )
    .replace(
      " UNIQUE(novel_id, participant_id, request_key)",
      " UNIQUE(novel_id, participant_id),\n UNIQUE(novel_id, participant_id, request_key)",
    )
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS one_regular_post[^;]+;/, "")
    .replace(", updated_at TEXT NOT NULL", "");
  old.exec(schema);
  old.exec("PRAGMA user_version = 1");
  const result = {
    original: "あ",
    published: "あ",
    publishedCount: 1,
    sequence: 1,
    total: 1,
    complete: false,
    unpublished: "",
  };
  old.prepare("INSERT INTO participants VALUES (?)").run("person");
  old
    .prepare("INSERT INTO novels VALUES (?,?,?,?,?,?)")
    .run("book", "既存の本", 4000, 1, 1, "2026-10-17");
  const key = randomUUID();
  old
    .prepare("INSERT INTO posts VALUES (?,?,?,?,?,?,?,?)")
    .run("book", "person", 1, key, "あ", "あ", 1, JSON.stringify(result));
  old.close();
  const store = new Store(path);
  try {
    assert.equal(store.get("book", "person").count, 1);
    assert.equal(store.get("book", "person").updated_at, "2026-10-17");
    assert.deepEqual(store.post("book", "person", key, "あ", true), result);
    assert.throws(
      () => store.post("book", "person", randomUUID(), "い"),
      /すでに/,
    );
    store.post("book", "person", randomUUID(), "い", true);
    assert.throws(
      () => store.delete("book"),
      (e) => e.status === 403,
    );
    assert.equal(store.get("book", "person").count, 2);
    assert.deepEqual(store.delete("book", true), { deleted: true });
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM posts").get().n,
      0,
    );
    assert.throws(
      () => store.get("book", "person"),
      (e) => e.status === 404,
    );
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const adminMode of [true, false])
  test(`HTTP server enforces adminMode=${adminMode}`, async (t) => {
    const store = new Store(":memory:");
    const server = createApp(store, { adminMode });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      await new Promise((r) => server.close(r));
      store.close();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const session = await fetch(base + "/api/session");
    const cookie = session.headers.get("set-cookie").split(";")[0];
    assert.equal((await session.json()).isAdmin, adminMode);
    const call = (path, body, method = "POST", origin) =>
      fetch(base + path, {
        method,
        headers: {
          cookie,
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const { id } = await (
      await call("/api/novels", {
        title: "管理者テスト",
        capacity: 4000,
        text: "始",
        key: randomUUID(),
      })
    ).json();
    const post = () =>
      call(`/api/novels/${id}/posts`, {
        key: randomUUID(),
        text: "あ",
        isAdmin: true,
      });
    assert.equal((await post()).status, adminMode ? 200 : 409);
    assert.equal((await post()).status, adminMode ? 200 : 409);
    assert.equal(
      (
        await call(
          `/api/novels/${id}`,
          undefined,
          "DELETE",
          "https://elsewhere.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(`/api/novels/${id}`, undefined, "DELETE")).status,
      adminMode ? 200 : 403,
    );
    assert.equal(
      (await fetch(base + `/api/novels/${id}`)).status,
      adminMode ? 404 : 200,
    );
  });
