import { AppError } from "./app-error.js";
import { migrateTitleKeys } from "./migrations/title-keys.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  normalize,
  split,
  count,
  inspectInput,
  titleKey,
} from "./public/text.js";

export { AppError } from "./app-error.js";
export class Store {
  constructor(path, { now = Date.now } = {}) {
    this.now = now;
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
    migrateTitleKeys(this.db);
  }

  creationStatus(participant, isAdmin = false) {
    const serverTime = this.now();
    const next = this.db
      .prepare(
        "SELECT next_allowed_at FROM creation_limits WHERE participant_id=?",
      )
      .get(participant)?.next_allowed_at;
    return {
      canCreate: isAdmin || !next || serverTime >= next,
      nextCreationAt: isAdmin || !next ? null : new Date(next).toISOString(),
      serverTime,
    };
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
        if (
          !this.db
            .prepare("SELECT 1 FROM novels WHERE id=?")
            .get(prior.novel_id)
        )
          throw new AppError("この本は削除されました。", 404);
        this.db.exec("COMMIT");
        return { id: prior.novel_id };
      }
      const permission = this.creationStatus(participant, isAdmin);
      if (!permission.canCreate) {
        const error = new AppError(
          "新しい本は7日間に一冊まで公開できます。下書きは保存されています。",
          429,
        );
        error.creation = permission;
        throw error;
      }
      this.db
        .prepare("INSERT OR IGNORE INTO participants VALUES (?)")
        .run(participant);
      const { id } = this.create(title, capacity);
      this.post(id, participant, key, text, isAdmin, true);
      this.db
        .prepare("UPDATE novels SET created_at=updated_at WHERE id=?")
        .run(id);
      this.db
        .prepare("INSERT INTO creations VALUES (?,?,?,?)")
        .run(participant, key, payload, id);
      if (!isAdmin)
        this.db
          .prepare(
            "INSERT INTO creation_limits VALUES (?,?) ON CONFLICT(participant_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at",
          )
          .run(participant, this.now() + 7 * 24 * 60 * 60 * 1000);
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

    return id;
  }
  titleAvailability(title) {
    const input = inspectInput(title, true);
    if (!input.valid) throw new AppError(input.error);
    return {
      available: !this.db
        .prepare("SELECT 1 FROM novels WHERE title_key = ? LIMIT 1")
        .get(titleKey(title)),
    };
  }
  create(title, capacity) {
    const input = inspectInput(title, true);
    if (!input.valid) throw new AppError(input.error);
    if (![4000, 12000, 40000].includes(capacity))
      throw new AppError(
        "タイトルは1〜100字、長さは指定の区分を選んでください。",
      );
    const id = randomUUID();
    try {
      const inserted = this.db
        .prepare(
          "INSERT INTO novels(id,title,capacity,created_at,updated_at,title_key) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM novels WHERE title_key=?)",
        )
        .run(
          id,
          normalize(title),
          capacity,
          new Date().toISOString(),
          new Date().toISOString(),
          titleKey(title),
          titleKey(title),
        );
      if (!inserted.changes) throw new Error("duplicate_novel_title");
    } catch (error) {
      if (
        error.message === "duplicate_novel_title" ||
        error.message === "UNIQUE constraint failed: novels.title_key"
      )
        throw new AppError(
          "この名前の本は既にあります。別の名前を入力してください。",
          400,
        );
      throw error;
    }
    return { id };
  }
  list(options = {}) {
    return this.listPage(options).books;
  }
  listPage({
    limit = 30,
    cursor = null,
    sort = "created_at:desc",
    filter = "all",
    offset,
  } = {}) {
    limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || offset !== undefined)
      throw new AppError("不正なページ指定です。");
    limit = Math.min(limit, 100);
    if (typeof sort !== "string") throw new AppError("不正な並び順です。");
    const [field, direction, ...extra] = sort.split(":");
    if (
      extra.length ||
      !["title", "created_at", "updated_at"].includes(field) ||
      !["asc", "desc"].includes(direction) ||
      !["all", "writing", "complete"].includes(filter)
    )
      throw new AppError("不正な並び順です。");
    const conditions = [],
      params = [];
    if (filter !== "all")
      conditions.push(
        filter === "writing" ? "count<capacity" : "count=capacity",
      );
    if (cursor) {
      let data;
      try {
        if (
          typeof cursor !== "string" ||
          cursor.length > 32768 ||
          !/^[A-Za-z0-9_-]+$/.test(cursor)
        )
          throw new Error();
        data = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
          data.sort !== sort ||
          data.filter !== filter ||
          typeof data.value !== "string" ||
          typeof data.id !== "string" ||
          data.id.length > 100
        )
          throw new Error();
      } catch {
        throw new AppError("不正なカーソルです。");
      }
      conditions.push(
        "(" +
          field +
          (direction === "asc" ? ">" : "<") +
          "? OR (" +
          field +
          "=? AND id>?))",
      );
      params.push(data.value, data.value, data.id);
    }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const rows = this.db
      .prepare(
        "SELECT * FROM novels" +
          where +
          " ORDER BY " +
          field +
          " " +
          direction +
          ", id ASC LIMIT ?",
      )
      .all(...params, limit + 1);
    const books = rows.slice(0, limit),
      last = books.at(-1);
    const nextCursor =
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({ sort, filter, value: last[field], id: last.id }),
          ).toString("base64url")
        : null;
    return { books, nextCursor };
  }
  get(id, participant, after = null) {
    if (after !== null && (!Number.isSafeInteger(after) || after < 0))
      throw new AppError("不正なrevisionです。");
    this.db.exec("SAVEPOINT reading");
    try {
      const novel = this.db.prepare("SELECT * FROM novels WHERE id=?").get(id);
      if (!novel) throw new AppError("この本は見つかりません。", 404);
      const own = this.db
        .prepare(
          "SELECT result FROM posts WHERE novel_id=? AND participant_id=? AND sequence>? ORDER BY sequence DESC LIMIT 1",
        )
        .get(id, participant, after ?? -1);
      return {
        ...novel,
        after,
        posts: this.db
          .prepare(
            "SELECT sequence,published,count FROM posts WHERE novel_id=? AND sequence>? ORDER BY sequence",
          )
          .all(id, after ?? -1),
        ...(own
          ? { own: JSON.parse(own.result) }
          : after === null
            ? { own: null }
            : {}),
      };
    } finally {
      this.db.exec("RELEASE reading");
    }
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
    const input = inspectInput(text);
    if (!input.valid) throw new AppError(input.error);
    text = normalize(text);
    this.db.exec(nested ? "SAVEPOINT posting" : "BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO participants VALUES (?)")
        .run(participant);
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
