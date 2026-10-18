import {
  enabledCapacities,
  checkCreationCapacity,
  creationCapacities,
} from "../capacities.js";
import { activeNovelLimit, activeLimitMessage } from "../active-novels.js";
import { Buffer } from "node:buffer";
import { AppError } from "../app-error.js";
import { normalize, split, inspectInput, titleKey } from "../public/text.js";
const duplicate = () =>
  new AppError("この名前の本は既にあります。別の名前を入力してください。");
const collision = (e) =>
  /cas_ok|UNIQUE constraint failed/.test(
    String(e.message) + String(e.cause?.message),
  );
function manuscript(key, text) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(key))
    throw new AppError("投稿形式が正しくありません。");
  const input = inspectInput(text);
  if (!input.valid) throw new AppError(input.error);
  return normalize(text);
}
export class D1Store {
  constructor(db, { now = Date.now, maxActiveNovels = 30, capacities } = {}) {
    this.db = db;
    this.now = now;
    this.capacities = enabledCapacities(capacities);
    this.maxActiveNovels = activeNovelLimit(maxActiveNovels);
  }
  sql(query, ...args) {
    return this.db.prepare(query).bind(...args);
  }
  async creationStatus(p, admin = false) {
    const row = await this.sql(
      "SELECT next_allowed_at FROM creation_limits WHERE participant_id=?",
      p,
    ).first();
    const time = this.now(),
      next = row?.next_allowed_at;
    const activeCount = (
      await this.sql(
        "SELECT count(*) AS n FROM novels WHERE count<capacity AND id NOT IN (SELECT novel_id FROM novel_closures)",
      ).first()
    ).n;
    const activeLimitReached = activeCount >= this.maxActiveNovels;
    return {
      capacities: creationCapacities(this.capacities, admin),
      activeCount,
      maxActiveNovels: this.maxActiveNovels,
      activeLimitReached,
      canCreate: !activeLimitReached && (admin || !next || time >= next),
      nextCreationAt: admin || !next ? null : new Date(next).toISOString(),
      serverTime: time,
    };
  }
  async titleAvailability(title) {
    const input = inspectInput(title, true);
    if (!input.valid) throw new AppError(input.error);
    return {
      available: !(await this.sql(
        "SELECT 1 FROM novels WHERE title_key_v2=?",
        titleKey(title),
      ).first()),
    };
  }
  async get(id, p, after = null) {
    if (after !== null && (!Number.isSafeInteger(after) || after < 0))
      throw new AppError("不正なrevisionです。");
    const [book, posts, own] = await this.db.batch([
      this.sql(
        "SELECT *, EXISTS(SELECT 1 FROM novel_closures WHERE novel_id=novels.id) AS closed FROM novels WHERE id=?",
        id,
      ),
      this.sql(
        "SELECT sequence,published,count FROM posts WHERE novel_id=? AND sequence>? ORDER BY sequence",
        id,
        after ?? -1,
      ),
      this.sql(
        "SELECT result FROM posts WHERE novel_id=? AND participant_id=? AND sequence>? ORDER BY sequence DESC LIMIT 1",
        id,
        p,
        after ?? -1,
      ),
    ]);
    if (!book.results[0]) throw new AppError("この本は見つかりません。", 404);
    return {
      ...book.results[0],
      after,
      posts: posts.results,
      ...(own.results[0]
        ? { own: JSON.parse(own.results[0].result) }
        : after === null
          ? { own: null }
          : {}),
    };
  }
  async post(id, p, key, text, admin = false) {
    text = manuscript(key, text);
    const parts = split(text);
    for (let attempt = 0; attempt < 3; attempt++) {
      const [books, previous, own] = await this.db.batch([
        this.sql(
          "SELECT *, EXISTS(SELECT 1 FROM novel_closures WHERE novel_id=novels.id) AS closed FROM novels WHERE id=?",
          id,
        ),
        this.sql(
          "SELECT original,result FROM posts WHERE novel_id=? AND participant_id=? AND request_key=?",
          id,
          p,
          key,
        ),
        this.sql(
          "SELECT 1 FROM posts WHERE novel_id=? AND participant_id=? LIMIT 1",
          id,
          p,
        ),
      ]);
      const prior = previous.results[0],
        book = books.results[0];
      if (prior) {
        if (prior.original !== text)
          throw new AppError("同じ送信キーで原稿を変更できません。", 409);
        return JSON.parse(prior.result);
      }
      if (!book) throw new AppError("この本は見つかりません。", 404);
      if (!admin && own.results.length)
        throw new AppError("この本にはすでに投稿しています。", 409);
      if (book.closed || book.count === book.capacity)
        throw new AppError(
          "この本は完結しました。原稿はコピーして残せます。",
          409,
        );
      const n = Math.min(parts.length, book.capacity - book.count);
      const result = {
        original: text,
        published: parts.slice(0, n).join(""),
        unpublished: parts.slice(n).join(""),
        publishedCount: n,
        sequence: book.revision + 1,
        requestKey: key,
        total: book.count + n,
        complete: book.count + n === book.capacity,
      };
      const guard = crypto.randomUUID();
      try {
        await this.db.batch([
          this.sql(
            "INSERT INTO batch_guard VALUES (?, EXISTS(SELECT 1 FROM novels WHERE id=? AND revision=? AND id NOT IN (SELECT novel_id FROM novel_closures)))",
            guard,
            id,
            book.revision,
          ),
          this.sql("INSERT OR IGNORE INTO participants VALUES (?)", p),
          this.sql(
            "INSERT INTO posts VALUES (?,?,?,?,?,?,?,?,?)",
            id,
            p,
            result.sequence,
            key,
            text,
            result.published,
            n,
            JSON.stringify(result),
            admin ? 1 : 0,
          ),
          this.sql(
            "UPDATE novels SET count=?,revision=?,updated_at=? WHERE id=?",
            result.total,
            result.sequence,
            new Date(this.now()).toISOString(),
            id,
          ),
          this.sql("DELETE FROM batch_guard WHERE id=?", guard),
        ]);
        return result;
      } catch (e) {
        if (!collision(e)) throw e;
      }
    }
    throw new AppError(
      "投稿が集中しています。原稿を残したまま同じ内容を再送してください。",
      503,
    );
  }
  async publish(title, capacity, p, key, text, admin = false) {
    text = manuscript(key, text);
    const input = inspectInput(title, true);
    if (!input.valid) throw new AppError(input.error);
    if (![4000, 12000, 40000].includes(capacity))
      throw new AppError("長さは指定の区分を選んでください。");
    const payload = JSON.stringify([title, capacity, text]),
      tk = titleKey(title),
      n = split(text).length;
    for (let attempt = 0; attempt < 3; attempt++) {
      const [priorRows, titles] = await this.db.batch([
        this.sql(
          "SELECT c.*,n.id AS existing FROM creations c LEFT JOIN novels n ON n.id=c.novel_id WHERE participant_id=? AND request_key=?",
          p,
          key,
        ),
        this.sql("SELECT id FROM novels WHERE title_key_v2=?", tk),
      ]);
      const prior = priorRows.results[0];
      if (prior) {
        if (prior.payload !== payload)
          throw new AppError("同じ送信キーで公開内容を変更できません。", 409);
        if (!prior.existing)
          throw new AppError("この本は削除されました。", 404);
        return { id: prior.novel_id };
      }
      checkCreationCapacity(capacity, this.capacities, admin);
      const permission = await this.creationStatus(p, admin);
      if (!permission.canCreate) {
        const e = new AppError(
          permission.activeLimitReached
            ? activeLimitMessage
            : "新しい本は7日間に一冊まで公開できます。下書きは保存されています。",
          permission.activeLimitReached ? 409 : 429,
        );
        e.creation = permission;
        throw e;
      }
      if (titles.results.length) throw duplicate();
      const id = crypto.randomUUID(),
        time = this.now(),
        date = new Date(time).toISOString(),
        guard = crypto.randomUUID();
      const result = {
        original: text,
        published: text,
        unpublished: "",
        publishedCount: n,
        sequence: 1,
        requestKey: key,
        total: n,
        complete: false,
      };
      const statements = [
        this.sql(
          "INSERT INTO batch_guard VALUES (?, (SELECT count(*) FROM novels WHERE count<capacity AND id NOT IN (SELECT novel_id FROM novel_closures)) < ?)",
          guard + "-active",
          this.maxActiveNovels,
        ),
        this.sql(
          "INSERT INTO batch_guard VALUES (?, ? OR NOT EXISTS(SELECT 1 FROM creation_limits WHERE participant_id=? AND next_allowed_at>?))",
          guard,
          admin ? 1 : 0,
          p,
          time,
        ),
        this.sql("INSERT OR IGNORE INTO participants VALUES (?)", p),
        this.sql(
          "INSERT INTO novels(id,title,capacity,count,revision,created_at,updated_at,title_key,title_key_v2) VALUES (?,?,?,?,1,?,?,?,?)",
          id,
          normalize(title),
          capacity,
          n,
          date,
          date,
          id,
          tk,
        ),
        this.sql(
          "INSERT INTO posts VALUES (?,?,1,?,?,?,?,?,?)",
          id,
          p,
          key,
          text,
          text,
          n,
          JSON.stringify(result),
          admin ? 1 : 0,
        ),
        this.sql("INSERT INTO creations VALUES (?,?,?,?)", p, key, payload, id),
      ];
      if (!admin)
        statements.push(
          this.sql(
            "INSERT INTO creation_limits VALUES (?,?) ON CONFLICT(participant_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at",
            p,
            time + 604800000,
          ),
        );
      statements.push(
        this.sql(
          "DELETE FROM batch_guard WHERE id IN (?,?)",
          guard,
          guard + "-active",
        ),
      );
      try {
        await this.db.batch(statements);
        return { id };
      } catch (e) {
        if (!collision(e)) throw e;
      }
    }
    throw new AppError(
      "公開が集中しています。同じ内容を再送してください。",
      503,
    );
  }
  async finish(id, admin = false) {
    if (!admin) throw new AppError("執筆終了は管理者のみ利用できます。", 403);
    const results = await this.db.batch([
      this.sql(
        "INSERT OR IGNORE INTO novel_closures SELECT id,? FROM novels WHERE id=? AND count<capacity",
        new Date(this.now()).toISOString(),
        id,
      ),
      this.sql(
        "UPDATE novels SET updated_at=(SELECT closed_at FROM novel_closures WHERE novel_id=?) WHERE id=? AND EXISTS(SELECT 1 FROM novel_closures WHERE novel_id=?)",
        id,
        id,
        id,
      ),
      this.sql("SELECT id FROM novels WHERE id=?", id),
    ]);
    if (!results[2].results.length)
      throw new AppError("この本は見つかりません。", 404);
    return { finished: true };
  }
  async delete(id, admin = false) {
    if (!admin) throw new AppError("本の削除は管理者のみ利用できます。", 403);
    const result = await this.db.batch([
      this.sql("DELETE FROM posts WHERE novel_id=?", id),
      this.sql("DELETE FROM novels WHERE id=? RETURNING id", id),
    ]);
    if (!result[1].results.length)
      throw new AppError("この本は見つかりません。", 404);
    return { deleted: true };
  }
  async listPage({
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
        filter === "writing"
          ? "(count<capacity AND id NOT IN (SELECT novel_id FROM novel_closures))"
          : "(count=capacity OR id IN (SELECT novel_id FROM novel_closures))",
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
    const page = await this.db
      .prepare(
        "SELECT *, EXISTS(SELECT 1 FROM novel_closures WHERE novel_id=novels.id) AS closed FROM novels" +
          where +
          " ORDER BY " +
          field +
          " " +
          direction +
          ", id ASC LIMIT ?",
      )
      .bind(...params, limit + 1)
      .all();
    const rows = page.results;
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
}
