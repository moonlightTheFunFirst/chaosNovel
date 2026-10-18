


CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS novels (
 id TEXT PRIMARY KEY, title TEXT NOT NULL,
 capacity INTEGER NOT NULL CHECK(capacity IN (4000,12000,40000)),
 count INTEGER NOT NULL DEFAULT 0 CHECK(count >= 0 AND count <= capacity),
 revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS posts (
 novel_id TEXT NOT NULL REFERENCES novels(id),
 participant_id TEXT NOT NULL REFERENCES participants(id),
 sequence INTEGER NOT NULL,
 request_key TEXT NOT NULL,
 original TEXT NOT NULL,
 published TEXT NOT NULL,
 count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 400),
 result TEXT NOT NULL,
 is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
 PRIMARY KEY(novel_id, sequence),
 UNIQUE(novel_id, participant_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_regular_post ON posts(novel_id, participant_id) WHERE is_admin = 0;
CREATE TABLE IF NOT EXISTS creations (
 participant_id TEXT NOT NULL, request_key TEXT NOT NULL,
 payload TEXT NOT NULL, novel_id TEXT NOT NULL,
 PRIMARY KEY(participant_id, request_key)
);
CREATE TABLE IF NOT EXISTS creation_limits (
 participant_id TEXT PRIMARY KEY REFERENCES participants(id),
 next_allowed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_epochs (participant_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);

CREATE TABLE batch_guard (id TEXT PRIMARY KEY, ok INTEGER CONSTRAINT cas_ok CHECK(ok=1));
CREATE TABLE login_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, start INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX login_limits_start ON login_limits(start);
CREATE INDEX novels_created ON novels(created_at,id);
CREATE INDEX novels_updated ON novels(updated_at,id);
CREATE INDEX novels_title ON novels(title,id);
INSERT INTO app_meta(key,value) VALUES ('title_key_version','1');
