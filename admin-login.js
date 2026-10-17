import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { AppError } from "./store.js";
export function adminLogin({
  password,
  production = false,
  now = Date.now,
  warn = console.warn,
  delay = sleep,
}) {
  if (password && [...password].length < 12) {
    if (production)
      throw new Error("ADMIN_PASSWORDは12文字以上を設定してください。");
    warn(
      "開発用のADMIN_PASSWORDが12文字未満です。公開時は長いランダムな値に変更してください。",
    );
  }
  const hash = (value) => createHash("sha256").update(value).digest();
  const expected = password ? hash(password) : null;
  const windowMs = 300000,
    clients = new Map();
  let global = { count: 0, start: now() };
  function denied(until) {
    const error = new AppError(
      "ログイン試行が多すぎます。しばらく待って再試行してください。",
      429,
    );
    error.retryAfter = Math.max(1, Math.ceil((until - now()) / 1000));
    throw error;
  }
  return async (ip, supplied) => {
    if (!expected)
      throw new AppError("管理者ログインは設定されていません。", 503);
    const time = now();

    if (time - global.start >= windowMs) global = { count: 0, start: time };
    for (const [key, v] of clients)
      if (v.blockedUntil <= time && time - v.start >= windowMs)
        clients.delete(key);
    const state = clients.get(ip) || { count: 0, start: time, blockedUntil: 0 };
    if (state.blockedUntil > time) denied(state.blockedUntil);
    if (
      typeof supplied === "string" &&
      timingSafeEqual(hash(supplied), expected)
    ) {
      clients.delete(ip);
      const ms = Math.min(3000, Math.floor(global.count / 20) * 500);
      if (ms) await delay(ms);
      return;
    }
    state.count++;
    global.count++;
    if (state.count >= 5) state.blockedUntil = time + windowMs;

    if (!clients.has(ip) && clients.size >= 10000)
      clients.delete(clients.keys().next().value);
    clients.set(ip, state);
    const ms = Math.min(3000, Math.floor(global.count / 20) * 500);
    if (ms) await delay(ms);

    if (state.blockedUntil > time) denied(state.blockedUntil);
    throw new AppError("パスワードが違います。", 403);
  };
}

// XFF excludes the direct peer: one trusted hop selects its rightmost address.
export function clientAddressResolver(trustProxy, hops = 1) {
  if (!trustProxy) return (req) => req.socket.remoteAddress;
  if (
    !/^\d+$/.test(String(hops)) ||
    !Number.isSafeInteger(Number(hops)) ||
    Number(hops) < 1
  )
    throw new Error("TRUST_PROXY_HOPSは1以上の整数にしてください。");
  return (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    const addresses =
      typeof forwarded === "string"
        ? forwarded.split(",").map((v) => v.trim())
        : [];
    const ip = addresses.at(-Number(hops));
    return ip && isIP(ip) ? ip : req.socket.remoteAddress;
  };
}
