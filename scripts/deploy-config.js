import { enabledCapacities } from "../capacities.js";
import { activeNovelLimit } from "../active-novels.js";
export function validateDeployConfig(config) {
  const vars = config.vars || {};
  let url;
  try {
    url = new URL(vars.PUBLIC_ORIGIN);
  } catch {
    throw Error("PUBLIC_ORIGINに本番のhttps URLを設定してください。");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== vars.PUBLIC_ORIGIN ||
    url.hostname.endsWith(".invalid") ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw Error(
      "PUBLIC_ORIGINを本番のhttps URL（末尾スラッシュなし）に変更してください。",
    );
  if (
    url.hostname.endsWith(".workers.dev") &&
    url.hostname.split(".")[0] !== config.name
  )
    throw Error("PUBLIC_ORIGINのWorker名とnameが一致しません。");
  if (vars.COOKIE_SECURE !== "1" || vars.LOCAL_DEV !== undefined)
    throw Error("本番はCOOKIE_SECURE=1とし、LOCAL_DEVを設定しないでください。");
  const db = config.d1_databases?.find((d) => d.binding === "DB");
  if (
    !db ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      db.database_id || "",
    ) ||
    db.database_id.startsWith("00000000-")
  )
    throw Error(
      "DBのdatabase_idをCloudflareで作成したD1のIDに変更してください。",
    );
  if (
    db.database_name !== "chaos-novel-db" ||
    db.migrations_dir !== "workers/migrations"
  )
    throw Error(
      "D1名・migrations_dirを公開手順とタイトルキー初期化スクリプトに合わせてください。",
    );
  if (
    Object.hasOwn(vars, "COOKIE_SECRET") ||
    Object.hasOwn(vars, "ADMIN_PASSWORD")
  )
    throw Error("秘密情報はvarsに入れずWrangler secretsで登録してください。");
  enabledCapacities(vars.ENABLED_CAPACITIES);
  activeNovelLimit(vars.MAX_ACTIVE_NOVELS);
}
