import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../app-error.js";
const hash = (v) => createHash("sha256").update(v).digest();
const windowMs = 300000;
function denied(until, time) {
  const e = new AppError(
    "ログイン試行が多すぎます。しばらく待って再試行してください。",
    429,
  );
  e.retryAfter = Math.max(1, Math.ceil((until - time) / 1000));
  throw e;
}
// Shared D1 state, independent of Worker instance lifetime. No raw IP is stored.
export async function login(
  store,
  password,
  supplied,
  ip,
  secret,
  { delay = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  if (!password)
    throw new AppError("管理者ログインは設定されていません。", 503);
  const time = store.now(),
    id = createHmac("sha256", secret).update(ip).digest("hex");
  const correct =
    typeof supplied === "string" &&
    timingSafeEqual(hash(supplied), hash(password));
  const statements = [
    store.sql(
      "DELETE FROM login_limits WHERE start<=? AND blocked_until<=?",
      time - windowMs,
      time,
    ),
  ];
  if (correct) {
    // Atomic with the following read: a locked record is never deleted.
    statements.push(
      store.sql(
        "DELETE FROM login_limits WHERE id=? AND blocked_until<=?",
        id,
        time,
      ),
    );
  } else {
    statements.push(
      store.sql(
        `INSERT INTO login_limits VALUES (?,1,?,0)
      ON CONFLICT(id) DO UPDATE SET
        count=CASE WHEN blocked_until>? THEN count ELSE count+1 END,
        blocked_until=CASE WHEN blocked_until>? THEN blocked_until WHEN count+1>=5 THEN ? ELSE 0 END`,
        id,
        time,
        time,
        time,
        time + windowMs,
      ),
    );
    statements.push(
      store.sql(
        "INSERT INTO login_limits VALUES ('global',1,?,0) ON CONFLICT(id) DO UPDATE SET count=count+1",
        time,
      ),
    );
  }
  statements.push(
    store.sql("SELECT * FROM login_limits WHERE id=? OR id=?", id, "global"),
  );
  const readIndex = statements.length - 1;
  statements.push(
    store.sql(
      "DELETE FROM login_limits WHERE id IN (SELECT id FROM login_limits WHERE id!='global' ORDER BY start DESC,id DESC LIMIT -1 OFFSET 10000)",
    ),
  );
  const results = await store.db.batch(statements);
  const rows = results[readIndex].results,
    state = rows.find((r) => r.id === id),
    global = rows.find((r) => r.id === "global");
  if (state?.blocked_until > time) denied(state.blocked_until, time);
  const ms = Math.min(3000, Math.floor((global?.count ?? 0) / 20) * 500);
  if (ms) await delay(ms);
  if (!correct) throw new AppError("パスワードが違います。", 403);
}
