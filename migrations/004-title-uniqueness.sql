-- Historical schema only. Superseded by title-keys.js; do not apply on startup.
-- Non-unique index preserves existing duplicate titles. Triggers block new duplicates.
-- title_key is registered by Store using normalize(title).trim().
CREATE INDEX IF NOT EXISTS novels_title_key ON novels(title_key(title));
CREATE TRIGGER IF NOT EXISTS novels_unique_title_insert
BEFORE INSERT ON novels
WHEN EXISTS (SELECT 1 FROM novels WHERE title_key(title) = title_key(NEW.title))
BEGIN
  SELECT RAISE(ABORT, 'duplicate_novel_title');
END;
CREATE TRIGGER IF NOT EXISTS novels_unique_title_update
BEFORE UPDATE OF title ON novels
WHEN title_key(OLD.title) != title_key(NEW.title)
 AND EXISTS (SELECT 1 FROM novels WHERE id != OLD.id AND title_key(title) = title_key(NEW.title))
BEGIN
  SELECT RAISE(ABORT, 'duplicate_novel_title');
END;
