import { AppError } from "./app-error.js";
export const capacityNames = { 4000: "短編", 12000: "中編", 40000: "長編" };
export function enabledCapacities(value = "4000,12000") {
  const parts = String(value)
    .split(",")
    .map((x) => x.trim());
  if (
    parts.some((x) => !["4000", "12000", "40000"].includes(x)) ||
    new Set(parts).size !== parts.length
  )
    throw new Error(
      "ENABLED_CAPACITIESは4000/12000/40000を重複なくカンマ区切りで設定してください。",
    );
  return Object.freeze(parts.map(Number).sort((a, b) => a - b));
}
export function creationCapacities(allowed, admin = false) {
  return admin ? [4000, 12000, 40000] : [...allowed];
}
export function checkCreationCapacity(capacity, allowed, admin = false) {
  if (!Object.hasOwn(capacityNames, capacity) || typeof capacity !== "number")
    throw new AppError("長さは指定の区分を選んでください。");
  if (!creationCapacities(allowed, admin).includes(capacity))
    throw new AppError(
      "この長さの本は現在つくれません。" +
        allowed.map((c) => capacityNames[c]).join("か") +
        "を選んでください。",
    );
}
