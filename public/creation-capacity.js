import { capacityNames } from "../capacities.js";
export function restoreCapacity(draft, pending, capacities) {
  const source = pending || draft || {};
  const capacity = source.capacity || capacities[0];
  if (capacities.includes(capacity))
    return { draft: { ...source, capacity }, pending, message: "" };
  const { key, ...saved } = source;
  return {
    draft: { ...saved, capacity: capacities[0] },
    pending: null,
    message:
      (capacityNames[capacity] || "この長さの本") +
      "は現在つくれないため、長さを" +
      capacityNames[capacities[0]] +
      "に変更しました。タイトルと原稿は保存されています。",
  };
}
