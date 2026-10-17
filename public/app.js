import { count, split, normalize } from "./text.js";
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
  actions.append(filter, button("＋ 新しい本をつくる", createForm, "primary"));
  app.append(message);
  const books = await api("/novels");
  function render() {
    const list = document.querySelector("#shelf");
    list.replaceChildren();
    for (const book of books.filter(
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
  app.innerHTML =
    '<a class="back" href="/">← 本棚へ</a><section class="book-heading"><div class="eyebrow">A NEW BEGINNING</div><h1>物語に、名前を。</h1><p class="note">まずはタイトルだけ。最初の一節は、誰が書いてもかまいません。</p></section><form><label for="title">本のタイトル（1〜100字）</label><input id="title" required placeholder="俺とスイカと青春" autocomplete="off"><label for="length">一冊の長さ</label><select id="length"><option value="4000">短編 — 4,000字</option><option value="12000">中編 — 12,000字</option><option value="40000">長編 — 40,000字</option></select><p class="note">タイトルと長さは公開後に変更できません。</p><button class="primary" type="submit">この本を開く</button></form>';
  const form = app.querySelector("form");
  form.append(message);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = form.querySelector("button");
    b.disabled = true;
    try {
      const result = await api("/novels", {
        title: document.querySelector("#title").value,
        capacity: Number(document.querySelector("#length").value),
      });
      location.href = "/novels/" + result.id;
    } catch (error) {
      message.textContent = error.message;
      b.disabled = false;
    }
  };
}
async function read(id) {
  let book = await api("/novels/" + id),
    composing = false,
    sending = false,
    newer = null;
  const draftKey = "draft:" + id,
    pendingKey = "pending:" + id;
  let pending = savedJSON(pendingKey);
  let receiptState = null;
  app.innerHTML =
    '<a class="back" href="/">← 本棚へ</a><section class="book-heading"><div class="eyebrow">A COLLECTIVE NOVEL</div><h1 id="novel-title"></h1><div class="meta" id="book-meta"></div></section><div class="notice" id="notice" aria-live="polite"></div><section class="paper"><div class="reader" tabindex="0" aria-label="小説本文・横方向にスクロール"><div class="vertical" id="body"></div></div></section><section class="composer"><div class="toolbar"><h2>あなたの、一節。</h2><span class="meta" id="counter"></span></div><label for="draft" class="note">原稿（縦書き・1〜400字）</label><textarea id="draft" aria-describedby="rules" placeholder="ここから、物語の続きを。"></textarea><p id="rules" class="note">一人一冊、一度だけ。空白・改行も1字に数えます。<br>残り文字数を超える部分は掲載されません。確認中も他の人が投稿できます。<br>Enterは改行です。原稿はこの端末に保存されます。</p><div class="actions" id="actions"></div><div id="receipt"></div></section>';
  document.querySelector("#novel-title").textContent = book.title;
  document.title = book.title + " — カオス小説";
  if (isAdmin) {
    app
      .querySelector(".book-heading")
      .append(button("この本を削除", () => deleteBook(book), "delete-book"));
    document.querySelector("#rules").textContent =
      "管理者はこの本に何度でも投稿できます。一回1〜400字、空白・改行も1字です。残り文字数を超える部分は掲載されません。Enterは改行です。原稿はこの端末に保存されます。";
  }
  const draft = document.querySelector("#draft"),
    counter = document.querySelector("#counter"),
    notice = document.querySelector("#notice"),
    receipt = document.querySelector("#receipt");
  draft.value =
    storageGet(draftKey) ?? pending?.text ?? book.own?.original ?? "";
  const previewButton = button("掲載内容を確認する", preview, "primary");
  const retry = button("送信結果を確認・再送", () => send(pending));
  const next = button("次の一節を書く", () => {
    draft.value = "";
    save();
    draft.focus();
  });
  document.querySelector("#actions").append(
    previewButton,
    retry,
    next,
    button("原稿をコピー", async () => {
      try {
        await navigator.clipboard.writeText(draft.value);
        message.textContent = "原稿をコピーしました。";
      } catch {
        draft.focus();
        draft.select();
        message.textContent = "原稿を選択しました。コピーしてください。";
      }
    }),
  );
  app.querySelector(".composer").append(message);
  function renderBody() {
    const reader = document.querySelector(".reader"),
      left = reader.scrollLeft;
    document.querySelector("#body").textContent =
      book.posts.map((p) => p.published).join("") ||
      "まだ白紙の物語。最初の一節を、お待ちしています。";
    reader.scrollLeft = left;
  }
  function state() {
    const n = count(draft.value);
    counter.textContent = `原稿 ${n} / 400 字　・　残り ${book.capacity - book.count} 字`;
    document.querySelector("#book-meta").textContent =
      `${labels[book.capacity]}　${book.count.toLocaleString()} / ${book.capacity.toLocaleString()} 字　・　${book.count === book.capacity ? "完結" : "執筆中"}`;
    previewButton.disabled =
      (!!book.own && !isAdmin) ||
      book.count === book.capacity ||
      n < 1 ||
      n > 400 ||
      composing ||
      sending ||
      !!pending;
    retry.hidden = !pending;
    retry.disabled = sending;
    previewButton.hidden =
      (!!book.own && !isAdmin) || book.count === book.capacity;
    next.hidden = !isAdmin || !book.own || book.count === book.capacity;
    next.disabled = sending || !!pending || composing;
    // Do not replace the input node or its value when remote posts arrive.
    if (!composing)
      draft.readOnly = sending || !!pending || (!!book.own && !isAdmin);
    app.querySelector(".composer h2").textContent =
      book.own && !isAdmin ? "あなたが綴った、一節。" : "あなたの、一節。";
    const nextReceiptState = `${book.own?.sequence ?? 0}:${book.count === book.capacity}`;
    if (receiptState === nextReceiptState) return;
    receiptState = nextReceiptState;
    receipt.replaceChildren();
    if (book.own) {
      const r = el("div", undefined, "result");
      r.append(
        el(
          "p",
          `あなたの一節 ${book.own.publishedCount}字を掲載しました。${isAdmin ? (book.count === book.capacity ? "この本は完結しました。" : "管理者として続けて執筆できます。") : "この本への投稿は完了しています。"}`,
        ),
      );
      if (book.own.unpublished) {
        r.append(
          el("p", "掲載されなかった部分："),
          el("pre", book.own.unpublished),
        );
      }
      const original = el("details");
      original.append(
        el("summary", "投稿時の原稿を表示（選択・コピーできます）"),
        el("pre", book.own.original),
      );
      r.append(original);
      receipt.append(r);
    } else if (book.count === book.capacity) {
      receipt.append(
        el(
          "p",
          "この本は完結しました。未掲載の原稿はコピーして残せます。",
          "result",
        ),
      );
    }
  }
  draft.addEventListener("compositionstart", () => {
    composing = true;
    state();
  });
  draft.addEventListener("compositionend", () => {
    composing = false;
    save();
  });
  draft.addEventListener("input", save);
  function save() {
    if (!storageSet(draftKey, draft.value))
      message.textContent =
        "端末への保存ができません。原稿をコピーして保管してください。";
    state();
  }
  function preview() {
    const parts = split(draft.value),
      remaining = book.capacity - book.count;
    const dialog = el("dialog");
    dialog.append(
      el("h2", "この一節を綴りますか。"),
      el(
        "p",
        `現時点での掲載予定：${Math.min(parts.length, remaining)}字。投稿の確定後は編集・削除できません。`,
        "note",
      ),
    );
    const paper = el("div", undefined, "preview");
    paper.append(el("div", parts.slice(0, remaining).join(""), "vertical"));
    dialog.append(paper);
    if (parts.length > remaining)
      dialog.append(
        el(
          "p",
          `末尾${parts.length - remaining}字は掲載されない見込みです。`,
          "message",
        ),
      );
    dialog.append(
      el(
        "p",
        "残り文字数は予約されません。確定時にさらに短くなる場合があります。",
        "note",
      ),
    );
    const actions = el("div", undefined, "actions");
    actions.append(
      button("戻って書く", () => dialog.close()),
      button(
        "この一節を綴る",
        () => {
          dialog.close();
          send({ key: crypto.randomUUID(), text: normalize(draft.value) });
        },
        "primary",
      ),
    );
    dialog.append(actions);
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
  }
  async function send(request) {
    if (!request || sending) return;
    pending = request;
    storageSet(pendingKey, JSON.stringify(pending));
    sending = true;
    state();
    message.textContent = "投稿を確認しています…";
    try {
      const result = await api("/novels/" + id + "/posts", request);
      pending = null;
      storageRemove(pendingKey);
      book.own = result;
      message.textContent = `${result.publishedCount}字を掲載しました。元の原稿はそのまま残しています。`;
      book = await api("/novels/" + id);
      newer = null;
      notice.replaceChildren();
      renderBody();
    } catch (error) {
      if (error.status && error.status < 500) {
        pending = null;
        storageRemove(pendingKey);
      }
      message.textContent =
        error.message +
        (pending
          ? " 原稿を保持しています。「送信結果を確認・再送」で同じ投稿を確認できます。"
          : "");
    } finally {
      sending = false;
      state();
    }
  }
  renderBody();
  state();
  async function poll() {
    try {
      const latest = await api("/novels/" + id);
      if (latest.own) {
        book.own = latest.own;
        if (
          pending &&
          (latest.own.requestKey === pending.key ||
            (!isAdmin &&
              !latest.own.requestKey &&
              normalize(pending.text) === latest.own.original))
        ) {
          pending = null;
          storageRemove(pendingKey);
        }
      }
      if (latest.revision > Math.max(book.revision, newer?.revision ?? 0)) {
        newer = latest;
        notice.replaceChildren(
          el(
            "span",
            latest.count === latest.capacity
              ? "この本が完結しました。 "
              : "新しい一節が届きました。 ",
          ),
          button("本文に反映", () => {
            book = newer;
            newer = null;
            renderBody();
            notice.replaceChildren();
            state();
          }),
        );
        book.count = latest.count;
      }
      if (!composing) state();
    } catch (error) {
      message.textContent =
        error.status === 404
          ? "この本は削除されました。原稿はこの端末に残っています。"
          : "更新を確認できません。原稿は保持しています。再接続を待っています。";
    } finally {
      setTimeout(poll, 3000);
    }
  }
  setTimeout(poll, 3000);
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
