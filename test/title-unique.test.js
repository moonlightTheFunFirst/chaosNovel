import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { Store } from "../store.js";
import { createApp } from "../server.js";
const duplicate = (e) =>
  e.status === 400 && /この名前の本は既に/.test(e.message);
test("normalized title comparison; failed duplicate does not consume allowance or save records", () => {
  const s = new Store(":memory:");
  try {
    s.create(" 本の名前 ", 4000);
    for (const admin of [false, true]) {
      const p = randomUUID(),
        key = randomUUID();
      for (const title of ["本の名前", "　本 の名前 ", "\u00a0本の名前\uFEFF"])
        assert.throws(
          () => s.publish(title, 4000, p, key, "原稿", admin),
          duplicate,
        );
      assert.equal(s.creationStatus(p).canCreate, true);
      assert.equal(
        s.db.prepare("SELECT count(*) n FROM participants WHERE id=?").get(p).n,
        0,
      );
      assert.equal(
        s.db
          .prepare("SELECT count(*) n FROM creations WHERE participant_id=?")
          .get(p).n,
        0,
      );
      const result = s.publish("変更後" + admin, 4000, p, key, "原稿", admin);
      assert.equal(s.get(result.id, p).own.original, "原稿");
      assert.deepEqual(
        s.publish("変更後" + admin, 4000, p, key, "原稿", admin),
        result,
      );
    }
    for (const title of ["ABC", "あ", "ア"]) assert.ok(s.create(title, 4000));
  } finally {
    s.close();
  }
});
test("legacy duplicates survive migration/restart and name is reusable only after every matching book is deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-titles-")),
    path = join(dir, "db.sqlite");
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const [id, title] of [
    ["old1", "重複"],
    ["old2", "　重複 "],
  ])
    old
      .prepare(
        "INSERT INTO novels(id,title,capacity,created_at,updated_at) VALUES (?,?,4000,?,?)",
      )
      .run(id, title, "2026", "2026");
  old.close();
  let s = new Store(path);
  try {
    assert.equal(s.list().length, 2);
    assert.equal(s.get("old2", "").title, "　重複 ");
    assert.throws(() => s.create("重複", 4000), duplicate);
    s.delete("old1", true);
    assert.throws(() => s.create("重複", 4000), duplicate);
    s.close();
    s = new Store(path);
    assert.throws(() => s.create("重複", 4000), duplicate);
    s.delete("old2", true);
    assert.ok(s.create("重複", 4000));
    assert.throws(
      () =>
        s.db
          .prepare(
            "INSERT INTO novels(id,title,capacity,created_at,updated_at,title_key) VALUES (?,?,4000,?,?,?)",
          )
          .run("bypass", "重複", "2026", "2026", "重複"),
      /UNIQUE constraint failed/,
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("independent participants concurrently publishing the same title yield one success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-title-race-")),
    path = join(dir, "db.sqlite");
  const s = new Store(path);
  try {
    const people = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      people.map(
        (p) =>
          new Promise((resolve, reject) => {
            const worker = new Worker(
              new URL("../test-support/create-worker.js", import.meta.url),
              { workerData: { path, p, key: randomUUID() } },
            );
            worker.on("message", resolve);
            worker.on("error", reject);
          }),
      ),
    );
    assert.equal(results.filter((r) => r.id).length, 1);
    assert.equal(results.filter((r) => r.status === 400).length, 1);
    const loser = results.findIndex((r) => r.status === 400);
    assert.equal(s.creationStatus(people[loser]).canCreate, true);
    assert.equal(s.list().length, 1);
    assert.equal(s.db.prepare("SELECT count(*) n FROM posts").get().n, 1);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP duplicate is an editable error and retrying another title preserves manuscript", async (t) => {
  const s = new Store(":memory:");
  s.create("既存", 4000);
  const server = createApp(s, { adminMode: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    s.close();
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const session = await fetch(base + "/api/session");
  const cookie = session.headers.getSetCookie()[0].split(";")[0];
  const payload = {
    title: "既存",
    capacity: 4000,
    text: "消えない原稿",
    key: randomUUID(),
  };
  const send = () =>
    fetch(base + "/api/novels", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const denied = await send();
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /別の名前/);
  payload.title = "変更したタイトル";
  const success = await send();
  assert.equal(success.status, 200);
  const book = s.get((await success.json()).id, "");
  assert.equal(book.posts[0].text ?? book.posts[0].published, "消えない原稿");
});
