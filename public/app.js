import { isFinished, bookStatus, finishReason } from "./book-state.js";
import { retryAfterMs } from "./sync.js";
import { showRules } from "./rules.js";
import { openCreation } from "./creation.js";
import { formatDate } from "./book-meta.js";
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
  const data = await response
    .json()
    .catch(() => ({ error: "通信に失敗しました。" }));
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    error.retryAfterMs = retryAfterMs(response.headers.get("Retry-After"));
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
function finishBook(book, onFinished = () => location.reload()) {
  const dialog = el("dialog"),
    error = el("p", "", "message");
  const confirm = button(
    "執筆を終了する",
    async () => {
      confirm.disabled = true;
      try {
        await api("/novels/" + book.id + "/finish", {});
        dialog.close();
        onFinished();
      } catch (e) {
        error.textContent = e.message;
        confirm.disabled = false;
      }
    },
    "danger",
  );
  dialog.append(
    el("h2", "この本の執筆を終了しますか。"),
    el("p", book.title),
    el(
      "p",
      "本文と文字数を残して投稿受付を終了します。管理者も追加投稿できなくなります。元には戻せません。",
      "note",
    ),
    button("キャンセル", () => dialog.close()),
    confirm,
    error,
  );
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
async function shelf() {
  app.innerHTML =
    '<section class="hero"><div><div class="eyebrow">A STORY WITHOUT A PLAN</div><h1><span>一度きりの</span><span>一節を。</span><br><span>予想できない</span><span>一冊に。</span></h1><p>知らない誰かの続きに、あなたの言葉を。<br>結末も、つながりも、気にしなくていい。</p></div><div class="hero-mark">見た目は小説。<br>中身は、カオス。</div></section><div class="toolbar"><h2>みんなの本棚</h2><div class="actions" id="shelf-actions"></div></div><div class="shelf" id="shelf"></div>';
  showRules(app, el, isAdmin, api);
  const capacityNote = el("p", "執筆中の冊数を確認しています…", "note");
  document.querySelector(".toolbar").after(capacityNote);
  const actions = document.querySelector("#shelf-actions");
  const filter = el("select");
  filter.setAttribute("aria-label", "本の状態");
  for (const [value, label] of [
    ["all", "すべての本"],
    ["writing", "執筆中"],
    ["complete", "執筆終了"],
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
    ["title:asc", "本の名前：コードポイント昇順"],
    ["title:desc", "本の名前：コードポイント降順"],
  ]) {
    const option = el("option", label);
    option.value = value;
    sort.append(option);
  }
  sort.value = storageGet("shelf-sort") || "created_at:desc";
  if (!sort.value) sort.value = "created_at:desc";
  sort.onchange = () => {
    storageSet("shelf-sort", sort.value);
    load(true);
  };
  const createButton = button(
    "＋ 新しい本をつくる",
    () => {
      if (!createButton.disabled) createForm();
    },
    "primary",
  );
  const createControl = el("span", undefined, "create-book-control");
  const createTooltip = el("span", "", "create-book-tooltip");
  createTooltip.id = "create-book-tooltip";
  createTooltip.setAttribute("role", "tooltip");
  createButton.setAttribute("aria-describedby", createTooltip.id);
  createControl.setAttribute("aria-describedby", createTooltip.id);
  createControl.append(createButton, createTooltip);
  function creationAvailability(reason = "") {
    createButton.disabled = !!reason;
    createControl.tabIndex = reason ? 0 : -1;
    createControl.setAttribute(
      "aria-label",
      reason ? "新しい本をつくる（現在利用できません）" : "新しい本をつくる",
    );
    createTooltip.textContent = reason;
    createTooltip.hidden = !reason;
  }
  creationAvailability("執筆中の冊数を確認しています。");
  actions.append(filter, sort, createControl);
  app.append(message);
  let books = [],
    generation = 0,
    cursor = null;
  const more = button("さらに読み込む", () => load(false));
  app.append(more);
  async function load(reset) {
    const ticket = ++generation;
    if (reset) {
      books = [];
      cursor = null;
    }
    more.disabled = true;
    let capacityChecked = false;
    try {
      const session = await api("/session");
      if (ticket !== generation || !app.contains(more)) return;
      capacityChecked = true;
      const c = session.creation;
      creationAvailability(
        c.activeLimitReached
          ? "これ以上本を作成できません。先に他の本の執筆を完了させてください。"
          : "",
      );
      capacityNote.textContent =
        `執筆中の本：${c.activeCount}／${c.maxActiveNovels}冊` +
        (c.activeLimitReached
          ? "。新しい本を公開するには、いずれかの本を完結させてください。下書きは書けます。"
          : "");
      const batch = await api(
        "/novels?" +
          new URLSearchParams({
            limit: 30,
            ...(cursor ? { cursor } : {}),
            sort: sort.value,
            filter: filter.value,
          }),
      );
      if (ticket !== generation || !app.contains(more)) return;
      const seen = new Set(books.map((b) => b.id));
      books.push(...batch.books.filter((b) => !seen.has(b.id)));
      cursor = batch.nextCursor;
      more.hidden = !cursor;
      render();
    } catch (e) {
      if (ticket !== generation || !app.contains(more)) return;
      if (!capacityChecked)
        creationAvailability(
          "冊数を確認できません。本棚を再読み込みしてください。",
        );
      message.textContent = e.message;
    } finally {
      if (ticket === generation) more.disabled = false;
    }
  }
  function render() {
    const list = document.querySelector("#shelf");
    list.replaceChildren();
    for (const book of books) {
      const finished = isFinished(book);
      const a = el("a", undefined, finished ? "book book-finished" : "book");
      a.href = "/novels/" + book.id;
      a.append(
        el("span", labels[book.capacity], "book-length"),
        el("strong", bookStatus(book), "book-status"),
        el("h2", book.title),
      );
      const bottom = el("div");
      if (finished) {
        bottom.append(
          el("p", finishReason(book), "book-finish-reason"),
          el("p", `全${book.count.toLocaleString()}字`, "book-total"),
        );
      } else {
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
          el(
            "p",
            `残り${(book.capacity - book.count).toLocaleString()}字`,
            "book-remaining",
          ),
        );
      }
      bottom.append(
        el(
          "span",
          finished ? "この本を読む →" : "続きを読む・書く →",
          "book-open",
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
      if (isAdmin && !isFinished(book))
        card.append(
          button(
            "執筆を終了",
            () => finishBook(book, () => load(true)),
            "delete-book",
          ),
        );
      list.append(card);
    }
    if (!list.children.length)
      list.append(
        el("p", "まだ本がありません。最初の一冊をつくりませんか。", "empty"),
      );
  }
  filter.onchange = () => load(true);
  await load(true);
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
    finishBook,
    storageGet,
    storageSet,
    storageRemove,
    savedJSON,
  });
}
const match = location.pathname.match(/^\/novels\/([\w-]+)$/);
function adminDialog() {
  const dialog = el("dialog"),
    form = el("form");
  const input = el("input");
  input.type = "password";
  input.autocomplete = "current-password";
  input.id = "admin-password";
  const label = el("label", "管理者パスワード");
  label.htmlFor = input.id;
  const error = el("p", "", "message");
  error.setAttribute("role", "status");
  const submit = el("button", "管理者になる", "primary");
  submit.type = "submit";
  form.append(
    el("h2", "管理者ログイン"),
    label,
    input,
    submit,
    button("閉じる", () => dialog.close()),
    error,
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api("/admin", { password: input.value });
      location.reload();
    } catch (e) {
      error.textContent = e.message;
      submit.disabled = false;
    }
  };
  dialog.append(form);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}
async function start() {
  ({ isAdmin } = await api("/session"));
  const adminControl = button(
    isAdmin ? "ゲストに戻る" : "管理者",
    isAdmin
      ? async () => {
          await api("/admin", {}, "DELETE");
          location.reload();
        }
      : adminDialog,
    "admin-control",
  );
  const adminStatus = el("div", undefined, "admin-status");
  if (isAdmin) adminStatus.append(el("span", "管理者モード", "admin-badge"));
  adminStatus.append(adminControl);
  document.querySelector(".header-side").append(adminStatus);
  if (isAdmin) {
    document.querySelector("footer").textContent =
      "管理者モード — 本の作成・繰り返し投稿・削除ができます。";
  }
  await (match ? read(match[1]) : shelf());
  if (match) document.querySelector("#book-menu-items").append(adminControl);
}
start().catch((error) => {
  app.append(message);
  message.textContent = error.message;
});
