import { showRules } from "./rules.js";
import { openCreation } from "./creation.js";
import { formatDate, sortBooks } from "./book-meta.js";
import { openReadingRoom } from "./reading-room.js";
const app = document.querySelector("#app");
const labels = { 4000: "短編", 12000: "中編", 40000: "長編" };
let isAdmin = false;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
async function api(path, body, method = body ? "POST" : "GET") {
  const response = await fetch("/api" + path, {
    signal: AbortSignal.timeout(15000),
    method,
    headers: method !== "GET" ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    error.creation = data.creation;
    throw error;
  }
  return data;
}
const button = (text, fn, cls) => {
  const b = el("button", text, cls);
  b.type = "button";
  b.onclick = fn;
  return b;
};
const message = el("p", "", "message");
message.setAttribute("role", "status");
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
function savedJSON(key) {
  try {
    return JSON.parse(storageGet(key));
  } catch {
    return null;
  }
}
function deleteBook(book) {
  const dialog = el("dialog");
  dialog.append(
    el("h2", "この本を削除しますか。"),
    el("p", book.title),
    el(
      "p",
      "本文と投稿履歴をすべて削除します。この操作は取り消せません。",
      "note",
    ),
  );
  const error = el("p", "", "message");
  const confirm = button(
    "この本を削除する",
    async () => {
      confirm.disabled = true;
      try {
        await api("/novels/" + book.id, undefined, "DELETE");
        storageRemove("draft:" + book.id);
        storageRemove("pending:" + book.id);
        location.href = "/";
      } catch (e) {
        error.textContent = e.message;
        confirm.disabled = false;
      }
    },
    "danger",
  );
  const actions = el("div", undefined, "actions");
  actions.append(
    button("キャンセル", () => dialog.close()),
    confirm,
  );
  dialog.append(actions, error);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
async function shelf() {
  app.innerHTML =
    '<section class="hero"><div><div class="eyebrow">A STORY WITHOUT A PLAN</div><h1>一度きりの一節を。<br>予想できない一冊に。</h1><p>知らない誰かの続きに、あなたの言葉を。<br>結末も、つながりも、気にしなくていい。</p></div><div class="hero-mark">見た目は小説。<br>中身は、カオス。</div></section><div class="toolbar"><h2>みんなの本棚</h2><div class="actions" id="shelf-actions"></div></div><div class="shelf" id="shelf"></div>';
  showRules(app, el, isAdmin);
  const actions = document.querySelector("#shelf-actions");
  const filter = el("select");
  filter.setAttribute("aria-label", "本の状態");
  for (const [value, label] of [
    ["all", "すべての本"],
    ["writing", "執筆中"],
    ["complete", "完結"],
  ]) {
    const option = el("option", label);
    option.value = value;
    filter.append(option);
  }
  const sort = el("select");
  sort.setAttribute("aria-label", "本の並び順");
  for (const [value, label] of [
    ["created_at:desc", "作成日時：新しい順"],
    ["created_at:asc", "作成日時：古い順"],
    ["updated_at:desc", "更新日時：新しい順"],
    ["updated_at:asc", "更新日時：古い順"],
    ["title:asc", "本の名前：昇順"],
    ["title:desc", "本の名前：降順"],
  ]) {
    const option = el("option", label);
    option.value = value;
    sort.append(option);
  }
  sort.value = storageGet("shelf-sort") || "created_at:desc";
  if (!sort.value) sort.value = "created_at:desc";
  sort.onchange = () => {
    storageSet("shelf-sort", sort.value);
    render();
  };
  actions.append(
    filter,
    sort,
    button("＋ 新しい本をつくる", createForm, "primary"),
  );
  app.append(message);
  const books = await api("/novels");
  function render() {
    const list = document.querySelector("#shelf");
    list.replaceChildren();
    for (const book of sortBooks(books, sort.value).filter(
      (b) =>
        filter.value === "all" ||
        (b.count === b.capacity ? "complete" : "writing") === filter.value,
    )) {
      const a = el("a", undefined, "book");
      a.href = "/novels/" + book.id;
      a.append(
        el(
          "span",
          `${labels[book.capacity]}　・　${book.count === book.capacity ? "完結" : "執筆中"}`,
          "badge",
        ),
        el("h2", book.title),
      );
      const bottom = el("div");
      const progress = el("progress");
      progress.max = book.capacity;
      progress.value = book.count;
      progress.setAttribute("aria-label", "本文の文字数");
      const track = el("div", undefined, "progress");
      track.append(progress);
      bottom.append(
        track,
        el(
          "div",
          `${book.count.toLocaleString()} / ${book.capacity.toLocaleString()} 字`,
          "meta",
        ),
      );
      bottom.append(
        el("div", "作成 " + formatDate(book.created_at), "meta"),
        el("div", "更新 " + formatDate(book.updated_at), "meta"),
      );
      a.append(bottom);
      const card = el("div", undefined, "book-card");
      card.append(a);
      if (isAdmin)
        card.append(
          button("この本を削除", () => deleteBook(book), "delete-book"),
        );
      list.append(card);
    }
    if (!list.children.length)
      list.append(
        el("p", "まだ本がありません。最初の一冊をつくりませんか。", "empty"),
      );
  }
  filter.onchange = render;
  render();
}
function createForm() {
  openCreation({ api, el, button, storageSet, storageRemove, savedJSON });
}
function read(id) {
  return openReadingRoom(id, {
    api,
    el,
    button,
    isAdmin,
    deleteBook,
    storageGet,
    storageSet,
    storageRemove,
    savedJSON,
  });
}
const match = location.pathname.match(/^\/novels\/([\w-]+)$/);
async function start() {
  ({ isAdmin } = await api("/session"));
  if (isAdmin) {
    document
      .querySelector("header")
      .append(el("span", "管理者モード", "admin-badge"));
    document.querySelector("footer").textContent =
      "管理者モード — 本の作成・繰り返し投稿・削除ができます。";
  }
  return match ? read(match[1]) : shelf();
}
start().catch((error) => {
  app.append(message);
  message.textContent = error.message;
});
