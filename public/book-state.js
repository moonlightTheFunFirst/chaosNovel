export const isFinished = (book) =>
  !!book.closed || book.count >= book.capacity;
export const bookStatus = (book) => (isFinished(book) ? "執筆終了" : "執筆中");
export const finishReason = (book) =>
  !isFinished(book) ? "" : book.closed ? "管理者による終了" : "文字数到達";
// Closure changes metadata only, never the manuscript or displayed post snapshot.
export function applyClosure(book, latest) {
  if (!latest.closed || book.closed) return false;
  book.closed = latest.closed;
  book.updated_at = latest.updated_at;
  return true;
}
