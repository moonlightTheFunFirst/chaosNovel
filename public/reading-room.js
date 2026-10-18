import { mergeDelta, visiblePolling, refreshAfterSuccess } from "./sync.js";
import { formatDate } from "./book-meta.js";
import { count, split, normalize, inspectInput } from "./text.js";
import {
  PagedText,
  ReadingGate,
  clampPage,
  pageCountForWidth,
} from "./pagination.js";

export async function openReadingRoom(id, helpers) {
  const {
    api,
    el,
    button,
    isAdmin,
    deleteBook,
    storageGet,
    storageSet,
    storageRemove,
    savedJSON,
  } = helpers;
  let book = await api("/novels/" + id);
  let stopPolling;
  let newer = null,
    writing = false,
    composing = false,
    sending = false,
    deleted = false;
  let needsLayout = false,
    draftPage = 0,
    selection = null;
  const draftKey = "draft:" + id,
    pendingKey = "pending:" + id;
  let pending = savedJSON(pendingKey);
  const gate = new ReadingGate();
  const app = document.querySelector("#app");
  document.body.classList.add("reading-room");
  document.title = book.title + " — カオス小説";
  app.innerHTML = `<section class="reading-shell" aria-label="小説の閲覧と執筆">
    <div class="reading-top"><a href="/" class="back">本棚へ</a><h1 id="reading-title"></h1><details class="book-menu"><summary aria-label="本のメニュー">メニュー</summary><div id="book-menu-items"><p id="book-meta" class="meta"></p></div></details></div>
    <div class="reading-announcement"><span id="reading-notice" aria-live="polite"></span><span id="reading-message" role="status"></span></div>
    <div class="reading-stage"><button class="page-turn turn-next" aria-label="次のページ">〈</button><article class="novel-sheet"><span id="mode-label" class="sheet-label">本文</span><div id="page-viewport" tabindex="0" aria-label="小説の本文"><div id="page-flow"></div></div><textarea id="manuscript" aria-label="原稿（縦書き・1〜400字）" aria-describedby="writing-rules" placeholder="ここから、あなたの一節を。" spellcheck="false" hidden></textarea><span id="sheet-number" class="sheet-number"></span></article><button class="page-turn turn-previous" aria-label="前のページ">〉</button></div>
    <div class="reading-controls"><div class="page-navigation"><span>末尾</span><input id="page-slider" type="range" min="1" max="1" value="1" step="1" dir="rtl" aria-label="ページを移動"><span>先頭</span><output id="page-position" aria-live="polite"></output></div><div class="reading-actions"><span id="reading-hint"></span><div id="mode-actions" class="actions"></div></div><p id="writing-rules" aria-hidden="true">一回1〜400字。空白・改行も1字。残り文字数を超える部分は掲載されません。Enterは改行です。</p></div>
  </section>`;
  document.querySelector("#reading-title").textContent = book.title;
  const viewport = document.querySelector("#page-viewport"),
    flow = document.querySelector("#page-flow"),
    draft = document.querySelector("#manuscript");
  const stage = document.querySelector(".reading-stage"),
    slider = document.querySelector("#page-slider");
  const notice = document.querySelector("#reading-notice"),
    message = document.querySelector("#reading-message");
  const next = document.querySelector(".turn-next"),
    previous = document.querySelector(".turn-previous");
  const menu = document.querySelector("#book-menu-items");
  const dates = el("p", "", "meta");
  menu.append(dates);
  const pollingStatus = el("span", "", "meta");
  const refreshButton = button("更新を確認", () => stopPolling?.refresh());
  document
    .querySelector(".reading-announcement")
    .append(pollingStatus, refreshButton);
  if (isAdmin) {
    menu.append(
      el("p", "管理者モード", "badge"),
      button("この本を削除", () => deleteBook(book), "danger"),
    );
  }
  draft.value = storageGet(draftKey) ?? pending?.text ?? "";
  const pager = new PagedText(viewport, flow);
  const writeButton = button("次の一節を綴る", () => setMode(true), "primary");
  const returnButton = button("閲覧に戻る", () => setMode(false));
  const submitButton = button("掲載内容を確認", preview, "primary");
  const retryButton = button("送信結果を確認・再送", () => send(pending));
  const copyButton = button("原稿をコピー", async () => {
    try {
      await navigator.clipboard.writeText(draft.value);
      message.textContent = "原稿をコピーしました。";
    } catch {
      setMode(true, true);
      draft.focus();
      draft.select();
      message.textContent = "原稿を選択しました。コピーしてください。";
    }
  });
  const savedButton = button("保存した原稿", () => setMode(true, true));
  const receiptButton = button("掲載結果", showReceipt);
  document
    .querySelector("#mode-actions")
    .append(
      writeButton,
      savedButton,
      receiptButton,
      returnButton,
      copyButton,
      retryButton,
      submitButton,
    );
  const canPost = () =>
    !deleted && book.count < book.capacity && (isAdmin || !book.own);

  function renderText(anchor = 0) {
    flow.textContent = book.posts.map((p) => p.published).join("");
    flow.classList.toggle("blank-page", !flow.textContent);
    layout(anchor);
  }
  function layout(anchor = pager.anchor()) {
    if (composing) {
      needsLayout = true;
      return;
    }
    const rect = stage.getBoundingClientRect();
    const small = rect.width < 620;
    const font = small ? 18 : 20,
      line = font * 2;
    const padding = small ? 22 : 38;
    const columns = Math.min(
      16,
      Math.max(
        1,
        Math.floor((rect.width - (small ? 56 : 144) - padding * 2) / line),
      ),
    );
    const rows = Math.min(
      40,
      Math.max(3, Math.floor((rect.height - 70) / (font * 1.04))),
    );
    const width = columns * line,
      height = Math.floor(rows * font * 1.04);
    app.style.setProperty("--novel-font", font + "px");
    app.style.setProperty("--novel-line", line + "px");
    app.style.setProperty("--sheet-padding", padding + "px");
    draft.style.width = width + "px";
    draft.style.height = height + "px";
    // The hidden reader remains measurable while the editor is showing.
    pager.layout(width, height, anchor);
    if (!writing) gate.visit(pager.page, pager.count);
    update();
  }
  function draftPages() {
    return pageCountForWidth(
      draft.scrollWidth,
      draft.clientWidth || pager.width,
    );
  }
  function move(page) {
    if (writing) {
      draftPage = clampPage(page, draftPages());
      draft.scrollLeft = -draftPage * pager.width;
    } else {
      pager.go(page);
      gate.visit(pager.page, pager.count);
    }
    updateNavigation();
    updateActions();
  }
  function updateNavigation() {
    const total = writing ? draftPages() : pager.count;
    const current = writing ? draftPage : pager.page;
    slider.max = total;
    slider.value = current + 1;
    slider.disabled = total === 1;
    slider.setAttribute("aria-valuetext", `${current + 1} / ${total} ページ`);
    document.querySelector("#page-position").textContent =
      `${current + 1} / ${total}`;
    document.querySelector("#sheet-number").textContent = writing
      ? `原稿 ${current + 1}`
      : String(current + 1);
    next.disabled = current >= total - 1;
    previous.disabled = current <= 0;
  }
  function updateActions() {
    const input = inspectInput(draft.value);
    const n = input.count;
    writeButton.hidden = writing;
    writeButton.disabled = !gate.unlocked || !canPost();
    writeButton.title = !gate.unlocked
      ? "最後のページまで進むと執筆できます。"
      : "";
    returnButton.hidden = !writing;
    copyButton.hidden = !writing;
    savedButton.hidden =
      writing || !draft.value || (!gate.unlocked && canPost());
    receiptButton.hidden = !book.own;
    retryButton.hidden = !writing || !pending;
    retryButton.disabled = sending;
    submitButton.hidden = !writing;
    submitButton.disabled =
      !gate.unlocked ||
      !canPost() ||
      sending ||
      !!pending ||
      composing ||
      !input.valid;
    if (!composing)
      draft.readOnly = sending || !!pending || !canPost() || !gate.unlocked;
    document.querySelector("#reading-hint").textContent = writing
      ? input.count === null
        ? input.error
        : `原稿 ${n} / 400字　残り ${book.capacity - book.count}字`
      : deleted
        ? "この本は削除されました。"
        : book.count === book.capacity
          ? "完結した物語です。"
          : !canPost()
            ? "この本には投稿済みです。"
            : gate.unlocked
              ? "この先に、あなたの一節を。"
              : "最後のページまで進むと、執筆できます。";
  }
  function update() {
    dates.textContent =
      "作成 " +
      formatDate(book.created_at) +
      " ／ 更新 " +
      formatDate(book.updated_at);
    document.querySelector("#book-meta").textContent =
      `${book.count.toLocaleString()} / ${book.capacity.toLocaleString()}字 ・ ${book.count === book.capacity ? "完結" : "執筆中"}`;
    updateNavigation();
    updateActions();
  }
  function setMode(edit, inspect = false) {
    if (edit && !inspect && (!gate.unlocked || !canPost())) return;
    if (!edit)
      selection = {
        start: draft.selectionStart,
        end: draft.selectionEnd,
        left: draft.scrollLeft,
      };
    if (edit) stopPolling?.activity();
    writing = edit;
    draft.hidden = !edit;
    // Visibility, instead of display:none, lets resize measure the reading flow.
    viewport.classList.toggle("reader-obscured", edit);
    viewport.setAttribute("aria-hidden", String(edit));
    viewport.tabIndex = edit ? -1 : 0;
    document.querySelector("#mode-label").textContent = edit
      ? "あなたの一節"
      : "本文";
    document
      .querySelector("#writing-rules")
      .setAttribute("aria-hidden", String(!edit));
    app.classList.toggle("is-writing", edit);
    update();
    if (edit) {
      draft.focus({ preventScroll: true });
      if (selection) {
        draft.setSelectionRange(selection.start, selection.end);
        draft.scrollLeft = selection.left;
      }
    } else viewport.focus({ preventScroll: true });
  }
  next.onclick = () => move((writing ? draftPage : pager.page) + 1);
  previous.onclick = () => move((writing ? draftPage : pager.page) - 1);
  slider.addEventListener("input", () => move(Number(slider.value) - 1));
  slider.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      move(
        (writing ? draftPage : pager.page) +
          (event.key === "ArrowLeft" ? 1 : -1),
      );
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      writing ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      document.querySelector("dialog[open]") ||
      event.target.closest(
        'input,textarea,select,[contenteditable="true"],.book-menu',
      )
    )
      return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      move(pager.page + (event.key === "ArrowLeft" ? 1 : -1));
    }
  });
  draft.addEventListener("input", () => {
    if (!storageSet(draftKey, draft.value))
      message.textContent =
        "この端末に保存できません。原稿をコピーしてください。";
    updateActions();
    updateNavigation();
  });
  draft.addEventListener("scroll", () => {
    draftPage = clampPage(
      Math.abs(draft.scrollLeft) + draft.clientWidth >= draft.scrollWidth - 1
        ? draftPages() - 1
        : Math.floor(Math.abs(draft.scrollLeft) / pager.width),
      draftPages(),
    );
    updateNavigation();
  });
  draft.addEventListener("compositionstart", () => {
    composing = true;
    updateActions();
  });
  draft.addEventListener("compositionend", () => {
    composing = false;
    storageSet(draftKey, draft.value);
    if (needsLayout) {
      needsLayout = false;
      layout();
    }
    update();
  });
  function preview() {
    if (composing || submitButton.disabled) return;
    const parts = split(draft.value),
      remaining = book.capacity - book.count;
    const dialog = el("dialog");
    dialog.append(
      el("h2", "この一節を綴りますか。"),
      el(
        "p",
        `掲載予定は${Math.min(parts.length, remaining)}字。確定後は編集できません。`,
        "note",
      ),
    );
    const paper = el("div", undefined, "preview");
    paper.append(el("div", parts.slice(0, remaining).join(""), "vertical"));
    dialog.append(paper);
    dialog.append(
      el(
        "p",
        "残り文字数は予約されません。超える部分は掲載されません。",
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
  function showReceipt() {
    if (!book.own) return;
    const result = book.own,
      dialog = el("dialog", undefined, "receipt-dialog");
    dialog.append(el("h2", `${result.publishedCount}字を掲載しました。`));
    if (result.unpublished)
      dialog.append(
        el("p", "掲載されなかった部分："),
        el("pre", result.unpublished),
      );
    dialog.append(
      el("p", "投稿時の原稿（選択・コピーできます）：", "note"),
      el("pre", result.original),
      button("閉じる", () => dialog.close()),
    );
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
  }
  async function send(request) {
    if (!request || sending) return;
    let sendError;
    pending = request;
    storageSet(pendingKey, JSON.stringify(request));
    sending = true;
    updateActions();
    message.textContent = "投稿を確認しています…";
    try {
      const result = await api("/novels/" + id + "/posts", request);
      pending = null;
      storageRemove(pendingKey);
      book.own = result;
      // Preserve the posted original in the server receipt; start a fresh draft only
      // after success, and keep it on partial publication or a completion race.
      if (!result.unpublished) {
        draft.value = "";
        draftPage = 0;
        storageSet(draftKey, "");
        selection = null;
      }
      message.textContent = `${result.publishedCount}字を掲載しました。元の原稿は「掲載結果」で確認できます。`;
      const refreshed = await refreshAfterSuccess(() => api("/novels/" + id));
      if (refreshed.refreshError) {
        sendError = refreshed.refreshError;
        message.textContent +=
          " 本文の再取得に失敗しました。更新を待つか再読込してください。";
        return;
      }
      book = refreshed.book;
      newer = null;
      notice.replaceChildren();
      setMode(false);
      renderText();
      move(pager.count - 1);
      if (result.unpublished) showReceipt();
    } catch (error) {
      sendError = error;
      if (error.status && error.status < 500) {
        pending = null;
        storageRemove(pendingKey);
      }
      message.textContent =
        error.message +
        (pending ? " 原稿を保持しています。同じ投稿を再送できます。" : "");
    } finally {
      sending = false;
      stopPolling?.activity();
      if (sendError) stopPolling?.defer(sendError);
      stopPolling?.reconcile();
      update();
    }
  }
  renderText();
  let resizeFrame;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => layout());
  }).observe(stage);
  async function poll() {
    try {
      const base = newer || book;
      const delta = await api("/novels/" + id + "?after=" + base.revision);
      // A successful send may have replaced the snapshot while this request was in flight.
      if ((newer || book).revision !== base.revision) return;
      let latest;
      try {
        latest = mergeDelta(base, delta);
      } catch {
        latest = await api("/novels/" + id);
      }
      if (latest.revision < book.revision) return;
      if (latest.own && latest.own.sequence >= (book.own?.sequence ?? 0)) {
        book.own = latest.own;
        if (pending && latest.own.requestKey === pending.key) {
          pending = null;
          storageRemove(pendingKey);
          message.textContent =
            "投稿は掲載済みです。「掲載結果」で確認できます。";
        }
      }
      if (latest.revision > Math.max(book.revision, newer?.revision ?? 0)) {
        newer = latest;
        book.count = latest.count;
        notice.replaceChildren(
          el(
            "span",
            latest.count === latest.capacity
              ? "完結しました。 "
              : "新しい一節が届きました。 ",
          ),
          button("本文に反映", () => {
            const anchor = pager.anchor();
            book = newer;
            newer = null;
            notice.replaceChildren();
            renderText(anchor);
          }),
        );
      }
      if (!composing) update();
      return { updated: latest.revision > base.revision };
    } catch (error) {
      if (error.status === 404) {
        deleted = true;
        message.textContent =
          "この本は削除されました。保存した原稿はコピーできます。";
        updateActions();
      } else
        message.textContent = "更新を確認できません。原稿は保持しています。";
      throw error;
    }
  }
  stopPolling = visiblePolling(document, poll, undefined, {
    eligible: () => !deleted && (book.count < book.capacity || !!pending),
    onPause: (paused) => {
      pollingStatus.textContent = paused ? "更新の確認を止めています" : "";
    },
  });
  window.addEventListener("pagehide", stopPolling, { once: true });
}
