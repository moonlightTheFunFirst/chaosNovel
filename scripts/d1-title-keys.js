import { titleKey, TITLE_KEY_VERSION } from "../public/text.js";
// Rows must come from a quiescent DB export. SQL is applied as one D1 batch.
export function titleKeyStatements(rows, unicode = process.versions.unicode) {
  const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
  const ordered = [...rows].sort((a, b) =>
    a.created_at < b.created_at
      ? -1
      : a.created_at > b.created_at
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  const seen = new Set();
  const statements = [
    "UPDATE novels SET title_key_v2=NULL, title_legacy_duplicate=0",
  ];
  for (const row of ordered) {
    const key = titleKey(row.title),
      duplicate = seen.has(key) ? 1 : 0;
    seen.add(key);
    statements.push(
      `UPDATE novels SET title_key_v2=${quote(key)}, title_legacy_duplicate=${duplicate} WHERE id=${quote(row.id)}`,
    );
  }
  // Fail the batch rather than leave a concurrently inserted row without a key.
  statements.push(
    "INSERT INTO batch_guard VALUES ('title-key-migration', NOT EXISTS(SELECT 1 FROM novels WHERE title_key_v2 IS NULL))",
  );
  statements.push("DELETE FROM batch_guard WHERE id='title-key-migration'");
  statements.push(
    `UPDATE app_meta SET value=${quote(TITLE_KEY_VERSION + ":" + unicode)} WHERE key='title_key_version'`,
  );
  return statements;
}
