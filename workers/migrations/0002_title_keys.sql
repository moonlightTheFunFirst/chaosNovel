-- Preserve the v1 unique column for compatibility; new comparisons use this column.
ALTER TABLE novels ADD COLUMN title_key_v2 TEXT;
ALTER TABLE novels ADD COLUMN title_legacy_duplicate INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX novels_unique_title_v2 ON novels(title_key_v2) WHERE title_legacy_duplicate=0;
CREATE INDEX novels_all_title_v2 ON novels(title_key_v2);
UPDATE app_meta SET value='pending:2' WHERE key='title_key_version';
-- Do not allow publication between schema migration and JS key reconstruction.
CREATE TRIGGER title_keys_pending BEFORE INSERT ON novels
WHEN (SELECT value FROM app_meta WHERE key='title_key_version') NOT LIKE '2:%'
BEGIN SELECT RAISE(ABORT, 'title keys migration required'); END;
