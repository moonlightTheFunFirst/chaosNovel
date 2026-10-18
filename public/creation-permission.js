import { formatDate } from "./book-meta.js";
export function creationBlockReason(p) {
  if (!p)
    return "作成条件を確認できません。本棚に戻って再読み込みしてください。";
  if (p.activeLimitReached)
    return "これ以上本を作成できません。先に他の本の執筆を完了させてください。";
  if (!p.canCreate)
    return p.nextCreationAt
      ? "現在は新しい本を作成できません。次に作成できる日時：" +
          formatDate(p.nextCreationAt) +
          "（日本時間）。"
      : "現在は新しい本を作成できません。";
  return "";
}
export function creationAccess(p, pending = false) {
  return {
    canEdit: !!p?.canCreate,
    canRetry: !!pending,
    reason: creationBlockReason(p),
  };
}
