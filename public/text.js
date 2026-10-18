import GraphemerModule from "graphemer";
const Graphemer = GraphemerModule.default ?? GraphemerModule;
const splitter = new Graphemer();
export const normalize = (text) => text.replace(/\r\n?/g, "\n");
export const TITLE_KEY_VERSION = "2";
export const titleKey = (text) =>
  normalize(text)
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[\s\u2800]/gu, "")
    .toLowerCase();
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
  text = normalize(text);
  if (!text.isWellFormed())
    return {
      count: null,
      valid: false,
      error: "使用できない文字（対になっていないサロゲート）が含まれています。",
    };
  if (
    /\p{Cc}/u.test(title ? text : text.replace(/[\n\t]/g, "")) ||
    /[\u202A-\u202E\u2066-\u2069]/u.test(text)
  )
    return {
      count: null,
      valid: false,
      error: "使用できない制御文字が含まれています。",
    };
  if (title && !titleKey(text))
    return { count: null, valid: false, error: "本の名前を入力してください。" };
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
