import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
export function cookieIdentity(
  store,
  secret = process.env.COOKIE_SECRET || randomBytes(32).toString("hex"),
) {
  const sign = (value) =>
    createHmac("sha256", secret).update(value).digest("base64url");
  const seal = (value) => value + "." + sign(value);
  function unseal(token) {
    if (typeof token !== "string" || token.length > 300) return null;
    const i = token.lastIndexOf("."),
      value = token.slice(0, i),
      signature = token.slice(i + 1),
      expected = sign(value);
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
      // Only unsigned IDs already present before migration are accepted.
      const legacy =
        typeof token === "string" &&
        /^[a-f0-9-]{36}$/.test(token) &&
        store.db.prepare("SELECT id FROM participants WHERE id=?").get(token);
      const id = legacy ? token : randomUUID();
      return { id, token: seal("p:" + id) };
    },
    admin(id, token) {
      const value = unseal(token);
      const [kind, owner, expires] = (value || "").split(":");
      return kind === "a" && owner === id && Number(expires) > Date.now();
    },
    adminToken(id) {
      return seal("a:" + id + ":" + (Date.now() + 12 * 60 * 60 * 1000));
    },
  };
}
