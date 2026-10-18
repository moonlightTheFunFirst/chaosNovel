import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
export function workerIdentity(
  store,
  secret,
  { password, now = Date.now } = {},
) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error("COOKIE_SECRETは32文字以上を設定してください。");
  const sign = (value, key = secret) =>
    createHmac("sha256", key).update(value).digest("base64url");
  const adminKey = password
    ? sign("admin-epoch:" + createHash("sha256").update(password).digest("hex"))
    : null;
  const seal = (value, key = secret) => value + "." + sign(value, key);
  const epoch = async (id) =>
    (
      await store
        .sql("SELECT epoch FROM admin_epochs WHERE participant_id=?", id)
        .first()
    )?.epoch ?? 0;
  function unseal(token, key = secret) {
    if (typeof token !== "string" || token.length > 300 || !key) return null;
    const i = token.lastIndexOf("."),
      value = token.slice(0, i),
      signature = token.slice(i + 1),
      expected = sign(value, key);
    return i > 0 &&
      /^[A-Za-z0-9_-]+$/.test(signature) &&
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ? value
      : null;
  }
  return {
    participant(token) {
      const value = unseal(token);
      if (value?.startsWith("p:")) return { id: value.slice(2), token };
      const id = randomUUID();
      return { id, token: seal("p:" + id) };
    },
    async admin(id, token) {
      const [kind, owner, expires, version] = (
        unseal(token, adminKey) || ""
      ).split(":");
      return (
        kind === "a" &&
        owner === id &&
        Number(expires) > now() &&
        version === String(await epoch(id))
      );
    },
    async adminToken(id) {
      if (!adminKey) throw new Error("管理者ログインは無効です。");
      return seal(
        "a:" + id + ":" + (now() + 43200000) + ":" + (await epoch(id)),
        adminKey,
      );
    },
    async revokeAdmin(id) {
      await store
        .sql(
          "INSERT INTO admin_epochs VALUES (?,1) ON CONFLICT(participant_id) DO UPDATE SET epoch=epoch+1",
          id,
        )
        .run();
    },
  };
}
