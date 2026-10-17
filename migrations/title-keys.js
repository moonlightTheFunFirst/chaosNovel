import { titleKey, TITLE_KEY_VERSION } from "../public/text.js";

export function migrateTitleKeys(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const keyVersion = db
      .prepare("SELECT value FROM app_meta WHERE key='title_key_version'")
      .get()?.value;
    if (version < 4 || keyVersion !== TITLE_KEY_VERSION) {
      // Drop expression objects before updating rows; no SQL function is needed.
      db.exec(`DROP TRIGGER IF EXISTS novels_unique_title_insert;
        DROP TRIGGER IF EXISTS novels_unique_title_update;
        DROP INDEX IF EXISTS novels_title_key;
        DROP INDEX IF EXISTS novels_unique_title_key;`);
      const columns = db
        .prepare("PRAGMA table_info(novels)")
        .all()
        .map((c) => c.name);
      if (!columns.includes("title_key"))
        db.exec("ALTER TABLE novels ADD COLUMN title_key TEXT");
      if (!columns.includes("title_legacy_duplicate"))
        db.exec(
          "ALTER TABLE novels ADD COLUMN title_legacy_duplicate INTEGER NOT NULL DEFAULT 0",
        );
      const seen = new Set();
      const update = db.prepare(
        "UPDATE novels SET title_key=?, title_legacy_duplicate=? WHERE id=?",
      );
      for (const row of db
        .prepare("SELECT id,title FROM novels ORDER BY created_at,id")
        .all()) {
        const key = titleKey(row.title);
        update.run(key, seen.has(key) ? 1 : 0, row.id);
        seen.add(key);
      }
      db.exec(`CREATE UNIQUE INDEX novels_unique_title_key ON novels(title_key) WHERE title_legacy_duplicate=0;
        CREATE INDEX IF NOT EXISTS novels_all_title_keys ON novels(title_key);
        PRAGMA user_version=4;`);
      db.prepare(
        "INSERT INTO app_meta(key,value) VALUES ('title_key_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(TITLE_KEY_VERSION);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
