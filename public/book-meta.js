export function formatDate(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
export function sortBooks(books, order) {
  const [field, direction] = order.split(":");
  const sign = direction === "asc" ? 1 : -1;
  return [...books].sort(
    (a, b) =>
      sign *
        (field === "title"
          ? a.title.localeCompare(b.title, "ja", { numeric: true })
          : String(a[field]).localeCompare(String(b[field]))) ||
      a.id.localeCompare(b.id),
  );
}
