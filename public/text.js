import GraphemerModule from "graphemer";
const Graphemer = GraphemerModule.default ?? GraphemerModule;
const splitter = new Graphemer();
export const normalize = (text) => text.replace(/\r\n?/g, "\n");
export const split = (text) => splitter.splitGraphemes(normalize(text));
export const count = (text) => split(text).length;
export const POST_UNITS = 16000;
export const TITLE_UNITS = 4000;
export const CLUSTER_POINTS = 32;
export function inspectInput(text, title = false) {
  const limit = title ? TITLE_UNITS : POST_UNITS;
  if (typeof text !== "string" || text.length > limit)
    return {
      count: null,
      valid: false,
      error: `入力データが大きすぎます（UTF-16長${limit.toLocaleString()}まで）。`,
    };
  const parts = split(text);
  if (parts.some((part) => [...part].length > CLUSTER_POINTS))
    return {
      count: null,
      valid: false,
      error: `1文字を構成するコードポイントは${CLUSTER_POINTS}個までです。`,
    };
  const n = parts.length;
  const valid = n >= 1 && n <= (title ? 100 : 400) && (!title || !!text.trim());
  return {
    count: n,
    valid,
    error: valid
      ? null
      : title
        ? "タイトルは1〜100字で入力してください。"
        : "原稿は1〜400字で投稿してください。",
  };
}
