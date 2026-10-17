import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { inspectInput, titleKey, normalize } from "../public/text.js";
import { migrateTitleKeys } from "../migrations/title-keys.js";
import { createApp } from "../server.js";

test("unsafe characters are rejected before segmentation, without consuming posts or creation allowance", () => {
  const s = new Store(":memory:");
  try {
    const id = s.create("安全な本", 4000).id;
    const bad = [
      "あ\0いう",
      "\0",
      "x\u0001",
      "x\u007f",
      "x\u0085",
      "x\ud800",
      "x\udfff",
      "x\ud800y\udc00",
    ];
    for (let n = 0x202a; n <= 0x202e; n++)
      bad.push("x" + String.fromCodePoint(n));
    for (let n = 0x2066; n <= 0x2069; n++)
      bad.push("x" + String.fromCodePoint(n));
    for (const text of bad) {
      const p = randomUUID();
      assert.equal(inspectInput(text).valid, false);
      assert.equal(inspectInput(text, true).valid, false);
      assert.throws(() => s.post(id, p, randomUUID(), text), /使用できない/);
      assert.throws(
        () => s.publish(text, 4000, p, randomUUID(), "原稿"),
        /使用できない/,
      );
      assert.throws(
        () => s.publish("公開失敗", 4000, p, randomUUID(), text),
        /使用できない/,
      );
      assert.equal(s.creationStatus(p).canCreate, true);
      assert.equal(s.get(id, p).count, 0);
      assert.equal(s.get(id, p).own, null);
    }
    assert.equal(s.list().length, 1);
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM participants").get().n,
      0,
    );
    assert.equal(s.db.prepare("SELECT count(*) n FROM creations").get().n, 0);
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM creation_limits").get().n,
      0,
    );
  } finally {
    s.close();
  }
});

test("body newline normalization and tabs, emoji, LRM/RLM remain supported; title controls do not", () => {
  const s = new Store(":memory:");
  try {
    const id = s.create("改行", 4000).id;
    const text = "あ\r\nい\r\t😀\u200e\u200f";
    const result = s.post(id, randomUUID(), randomUUID(), text);
    assert.equal(result.original, normalize(text));
    assert.equal(s.get(id, "").posts[0].published, normalize(text));
    for (const title of ["あ\nい", "あ\rい", "あ\r\nい", "あ\tい"])
      assert.throws(() => s.create(title, 4000), /制御文字/);
    assert.equal(inspectInput("題\u200e\u200f", true).valid, true);
    assert.equal(titleKey("題\u200e\u200f"), "題");
  } finally {
    s.close();
  }
});

test("shared title keys reject invisible, NFD, width, whitespace and case variants; preserve display and kana distinction", () => {
  const s = new Store(":memory:");
  try {
    for (const [original, variants] of [
      [
        "俺とスイカと青春",
        [
          "俺と\u200bスイカと青春",
          "俺とスイカと青春\u2060",
          "俺とスイカと青春\ufe00",
          "俺とスイカと青春\u200d",
          "俺とスイカと青春\u200e\u200f",
          "俺と スイカと 青春",
        ],
      ],
      ["がぱ", ["か\u3099は\u309a"]],
      ["ABC", ["ＡＢＣ", "abc", " A b C ", "A　BC"]],
      ["ガ", ["ｶﾞ"]],
    ]) {
      const id = s.create(original, 4000).id;
      assert.equal(s.get(id, "").title, original);
      for (const variant of variants) {
        assert.equal(titleKey(original), titleKey(variant));
        assert.equal(s.titleAvailability(variant).available, false);
        for (const admin of [false, true])
          assert.throws(
            () =>
              s.publish(variant, 4000, randomUUID(), randomUUID(), "文", admin),
            /既にあります/,
          );
      }
    }
    assert.ok(s.create("が", 4000));
    for (const title of ["\u200b", "\u2060\ufe00", " \u200d "])
      assert.equal(
        inspectInput(title, true).error,
        "本の名前を入力してください。",
      );
  } finally {
    s.close();
  }
});

test("v3 expression indexes migrate atomically without registering SQL functions, choosing oldest duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-key-v4-")),
    path = join(dir, "db.sqlite");
  let s;
  try {
    const old = new DatabaseSync(path);
    old.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    for (const [id, title, date] of [
      ["b", "ABC", "2020"],
      ["a", "ＡＢＣ", "2020"],
      ["c", "a b c", "2021"],
    ])
      old
        .prepare(
          "INSERT INTO novels(id,title,capacity,created_at,updated_at) VALUES (?,?,4000,?,?)",
        )
        .run(id, title, date, date);
    old.function("title_key", { deterministic: true }, (t) =>
      normalize(t).trim(),
    );
    old.exec(
      readFileSync(
        new URL("../migrations/004-title-uniqueness.sql", import.meta.url),
        "utf8",
      ),
    );
    old.close();
    s = new Store(path);
    assert.equal(s.db.prepare("PRAGMA user_version").get().user_version, 4);
    const rows = s.db
      .prepare(
        "SELECT id,title_key,title_legacy_duplicate d FROM novels ORDER BY id",
      )
      .all();
    assert.deepEqual(
      rows.map((r) => [r.id, r.title_key, r.d]),
      [
        ["a", "abc", 0],
        ["b", "abc", 1],
        ["c", "abc", 1],
      ],
    );
    assert.equal(
      s.db
        .prepare("SELECT value FROM app_meta WHERE key='title_key_version'")
        .get().value,
      "1",
    );
    assert.throws(() => s.create("abc", 4000), /既にあります/);
    s.delete("a", true);
    assert.equal(s.titleAvailability("ABC").available, false);
    assert.throws(() => s.create("ABC", 4000), /既にあります/);
    s.close();
    s = null;
    const raw = new DatabaseSync(path);
    assert.equal(
      raw.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    raw
      .prepare(
        "INSERT INTO novels(id,title,capacity,created_at,updated_at,title_key) VALUES ('raw','外部',4000,'2022','2022','外部')",
      )
      .run();
    // Simulate a previous key rule and require a rebuild on the next startup.
    raw.exec(
      "UPDATE app_meta SET value='0' WHERE key='title_key_version'; UPDATE novels SET title_key='stale-' || id",
    );
    raw.close();
    s = new Store(path);
    assert.equal(
      s.db.prepare("SELECT title_key FROM novels WHERE id='b'").get().title_key,
      "abc",
    );
    assert.equal(
      s.db
        .prepare("SELECT title_legacy_duplicate d FROM novels WHERE id='b'")
        .get().d,
      0,
    );
    s.delete("b", true);
    s.delete("c", true);
    assert.ok(s.create("ＡＢＣ", 4000));
    assert.equal(s.list().length, 2);
  } finally {
    s?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed key rebuild rolls back index, row keys and version together", () => {
  const s = new Store(":memory:");
  try {
    s.create("題", 4000);
    s.db.exec(
      "UPDATE app_meta SET value='0' WHERE key='title_key_version'; UPDATE novels SET title_key='old'; CREATE TRIGGER fail_key BEFORE UPDATE OF title_key ON novels BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    assert.throws(() => migrateTitleKeys(s.db), /test failure/);
    assert.equal(
      s.db.prepare("SELECT title_key FROM novels").get().title_key,
      "old",
    );
    assert.equal(
      s.db
        .prepare("SELECT value FROM app_meta WHERE key='title_key_version'")
        .get().value,
      "0",
    );
    assert.ok(
      s.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='novels_unique_title_key'",
        )
        .get(),
    );
  } finally {
    s.close();
  }
});

test("HTTP returns clear unsafe-character errors and normalized availability without consuming allowance", async (t) => {
  const s = new Store(":memory:");
  s.create("ABC", 4000);
  const server = createApp(s, { adminMode: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    s.close();
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const session = await fetch(base + "/api/session");
  const cookie = session.headers.getSetCookie()[0].split(";")[0];
  const call = (path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const available = await call("/api/title-availability", {
    title: "Ａ b\u200b C",
  });
  assert.deepEqual(await available.json(), { available: false });
  for (const [title, text] of [
    ["bad\0title", "文"],
    ["失敗", "あ\0いう"],
    ["失敗", "\u202e"],
    ["失敗", "\ud800"],
  ]) {
    const result = await call("/api/novels", {
      title,
      text,
      capacity: 4000,
      key: randomUUID(),
    });
    assert.equal(result.status, 400);
    assert.match((await result.json()).error, /使用できない/);
  }
  const result = await call("/api/novels", {
    title: "安全",
    text: "あ\n\tい",
    capacity: 4000,
    key: randomUUID(),
  });
  assert.equal(result.status, 200);
});
