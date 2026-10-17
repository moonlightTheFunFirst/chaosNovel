BEGIN IMMEDIATE;
CREATE TABLE posts_v2 (
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
INSERT INTO posts_v2(novel_id,participant_id,sequence,request_key,original,published,count,result)
 SELECT novel_id,participant_id,sequence,request_key,original,published,count,result FROM posts;
DROP TABLE posts;
ALTER TABLE posts_v2 RENAME TO posts;
CREATE UNIQUE INDEX one_regular_post ON posts(novel_id, participant_id) WHERE is_admin = 0;
PRAGMA user_version = 2;
COMMIT;
