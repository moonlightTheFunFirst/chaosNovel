PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS novels (
 id TEXT PRIMARY KEY, title TEXT NOT NULL,
 capacity INTEGER NOT NULL CHECK(capacity IN (4000,12000,40000)),
 count INTEGER NOT NULL DEFAULT 0 CHECK(count >= 0 AND count <= capacity),
 revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
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
PRAGMA user_version = 2;
