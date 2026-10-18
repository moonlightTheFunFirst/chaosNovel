import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { titleKey, TITLE_KEY_VERSION } from "../public/text.js";
import {
  storedTitleKeyVersion,
  migrateTitleKeys,
} from "../migrations/title-keys.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("title v2 ignores braille blank and Hangul fillers but distinguishes lookalikes", () => {
  assert.equal(TITLE_KEY_VERSION, "2");
  const s = new Store(":memory:");
  try {
    s.create("ABC", 4000);
    for (const invisible of [
      "\u2800",
      "\u115f",
      "\u1160",
      "\u3164",
      "\uffa0",
    ]) {
      assert.equal(titleKey("ABC" + invisible), "abc");
      assert.throws(() => s.create("ABC" + invisible, 4000), /既にあります/);
    }
    assert.notEqual(titleKey("a"), titleKey("а"));
    s.db.exec(
      "UPDATE app_meta SET value='1:old' WHERE key='title_key_version'; UPDATE novels SET title_key='stale'",
    );
    migrateTitleKeys(s.db);
    assert.equal(
      s.db.prepare("SELECT title_key FROM novels").get().title_key,
      "abc",
    );
    assert.equal(
      s.db
        .prepare("SELECT value FROM app_meta WHERE key='title_key_version'")
        .get().value,
      storedTitleKeyVersion,
    );
  } finally {
    s.close();
  }
});
test("fresh and schema versions 1/2/3/4 reach latest schema without bootstrap version rewrites", () => {
  for (const version of [0, 1, 2, 3, 4]) {
    const dir = mkdtempSync(join(tmpdir(), "chaos-schema-")),
      path = join(dir, "db.sqlite");
    let store;
    try {
      if (version) {
        const db = new DatabaseSync(path);
        db.exec(
          readFileSync(new URL("../schema.sql", import.meta.url), "utf8"),
        );
        if (version === 1) {
          db.exec(
            "DROP INDEX one_regular_post; ALTER TABLE posts DROP COLUMN is_admin;",
          );
        }
        if (version < 3)
          db.exec(
            "DROP TABLE creations; DROP TABLE creation_limits; ALTER TABLE novels DROP COLUMN updated_at;",
          );
        db.exec("PRAGMA user_version=" + version);
        db.close();
      }
      store = new Store(path);
      assert.equal(
        store.db.prepare("PRAGMA user_version").get().user_version,
        4,
      );
      assert.equal(
        store.db
          .prepare("SELECT value FROM app_meta WHERE key='title_key_version'")
          .get().value,
        storedTitleKeyVersion,
      );
      assert.ok(store.create("移行", 4000).id);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
