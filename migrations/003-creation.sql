BEGIN IMMEDIATE;
ALTER TABLE novels ADD COLUMN updated_at TEXT;
UPDATE novels SET updated_at=created_at;
CREATE TABLE IF NOT EXISTS creations (
 participant_id TEXT NOT NULL, request_key TEXT NOT NULL,
 payload TEXT NOT NULL, novel_id TEXT NOT NULL,
 PRIMARY KEY(participant_id, request_key)
);
PRAGMA user_version = 3;
COMMIT;
