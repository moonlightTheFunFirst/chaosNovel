import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { normalize, split, count } from "./public/text.js";

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version === 1)
      this.db.exec(
        readFileSync(
          new URL("./migrations/002-admin.sql", import.meta.url),
          "utf8",
        ),
      );
    if (version === 1 || version === 2)
      this.db.exec(
        readFileSync(
          new URL("./migrations/003-creation.sql", import.meta.url),
          "utf8",
        ),
      );
    this.db.exec(
      readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    );
  }

  publish(title, capacity, participant, key, text, isAdmin = false) {
    if (
      typeof key !== "string" ||
      !/^[a-zA-Z0-9-]{16,100}$/.test(key) ||
      typeof text !== "string"
    )
      throw new AppError("投稿形式が正しくありません。");
    const payload = JSON.stringify([title, capacity, normalize(text)]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          "SELECT * FROM creations WHERE participant_id=? AND request_key=?",
        )
        .get(participant, key);
      if (prior) {
        if (prior.payload !== payload)
          throw new AppError("同じ送信キーで公開内容を変更できません。", 409);
        this.db.exec("COMMIT");
        return { id: prior.novel_id };
      }
      const { id } = this.create(title, capacity);
      this.post(id, participant, key, text, isAdmin, true);
      this.db
        .prepare("UPDATE novels SET created_at=updated_at WHERE id=?")
        .run(id);
      this.db
        .prepare("INSERT INTO creations VALUES (?,?,?,?)")
        .run(participant, key, payload, id);
      this.db.exec("COMMIT");
      return { id };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  participant(cookie) {
    if (
      cookie &&
      this.db.prepare("SELECT id FROM participants WHERE id=?").get(cookie)
    )
      return cookie;
    const id = randomUUID();
    this.db.prepare("INSERT INTO participants VALUES (?)").run(id);
    return id;
  }
  create(title, capacity) {
    if (
      typeof title !== "string" ||
      !title.trim() ||
      count(title) > 100 ||
      ![4000, 12000, 40000].includes(capacity)
    )
      throw new AppError(
        "タイトルは1〜100字、長さは指定の区分を選んでください。",
      );
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO novels(id,title,capacity,created_at,updated_at) VALUES (?,?,?,?,?)",
      )
      .run(
        id,
        normalize(title),
        capacity,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    return { id };
  }
  list() {
    return this.db
      .prepare("SELECT * FROM novels ORDER BY created_at DESC, rowid DESC")
      .all();
  }
  get(id, participant) {
    const novel = this.db.prepare("SELECT * FROM novels WHERE id=?").get(id);
    if (!novel) throw new AppError("この本は見つかりません。", 404);
    const own = this.db
      .prepare(
        "SELECT result FROM posts WHERE novel_id=? AND participant_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(id, participant);
    return {
      ...novel,
      posts: this.db
        .prepare(
          "SELECT sequence,published,count FROM posts WHERE novel_id=? ORDER BY sequence",
        )
        .all(id),
      own: own ? JSON.parse(own.result) : null,
    };
  }
  delete(id, isAdmin = false) {
    if (!isAdmin) throw new AppError("本の削除は管理者のみ利用できます。", 403);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT id FROM novels WHERE id=?").get(id))
        throw new AppError("この本は見つかりません。", 404);
      this.db.prepare("DELETE FROM posts WHERE novel_id=?").run(id);
      this.db.prepare("DELETE FROM novels WHERE id=?").run(id);
      this.db.exec("COMMIT");
      return { deleted: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  post(id, participant, key, text, isAdmin = false, nested = false) {
    if (
      typeof key !== "string" ||
      !/^[a-zA-Z0-9-]{16,100}$/.test(key) ||
      typeof text !== "string"
    )
      throw new AppError("投稿形式が正しくありません。");
    text = normalize(text);
    this.db.exec(nested ? "SAVEPOINT posting" : "BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare(
          "SELECT * FROM posts WHERE novel_id=? AND participant_id=? AND request_key=?",
        )
        .get(id, participant, key);
      if (previous) {
        if (previous.original !== text)
          throw new AppError("同じ送信キーで原稿を変更できません。", 409);
        this.db.exec(nested ? "RELEASE posting" : "COMMIT");
        return JSON.parse(previous.result);
      }
      const novel = this.db.prepare("SELECT * FROM novels WHERE id=?").get(id);
      if (!novel) throw new AppError("この本は見つかりません。", 404);
      if (
        !isAdmin &&
        this.db
          .prepare("SELECT 1 FROM posts WHERE novel_id=? AND participant_id=?")
          .get(id, participant)
      )
        throw new AppError("この本にはすでに投稿しています。", 409);
      if (novel.count === novel.capacity)
        throw new AppError(
          "この本は完結しました。原稿はコピーして残せます。",
          409,
        );
      const characters = split(text);
      if (!characters.length || characters.length > 400)
        throw new AppError("原稿は1〜400字で投稿してください。");
      const published = characters
        .slice(0, novel.capacity - novel.count)
        .join("");
      const publishedCount = Math.min(
        characters.length,
        novel.capacity - novel.count,
      );
      const result = {
        published,
        publishedCount,
        unpublished: characters.slice(publishedCount).join(""),
        original: text,
        sequence: novel.revision + 1,
        requestKey: key,
        total: novel.count + publishedCount,
        complete: novel.count + publishedCount === novel.capacity,
      };
      this.db
        .prepare("INSERT INTO posts VALUES (?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          participant,
          result.sequence,
          key,
          text,
          published,
          publishedCount,
          JSON.stringify(result),
          isAdmin ? 1 : 0,
        );
      this.db
        .prepare("UPDATE novels SET count=?,revision=?,updated_at=? WHERE id=?")
        .run(result.total, result.sequence, new Date().toISOString(), id);
      this.db.exec(nested ? "RELEASE posting" : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(
        nested ? "ROLLBACK TO posting; RELEASE posting" : "ROLLBACK",
      );
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
