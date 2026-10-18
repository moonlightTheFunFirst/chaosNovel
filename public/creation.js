import { creationAccess } from "./creation-permission.js";
import { capacityNames } from "../capacities.js";
import { restoreCapacity } from "./creation-capacity.js";
import { formatDate } from "./book-meta.js";
import { titleValidation } from "./title-validation.js";
import { inspectInput } from "./text.js";
export async function openCreation({
  api,
  el,
  button,
  storageSet,
  storageRemove,
  savedJSON,
}) {
  const app = document.querySelector("#app");
  let saved = savedJSON("new-book-draft") || {};
  let pending = savedJSON("new-book-pending");
  if (pending) saved = pending;
  app.innerHTML = '<a class="back" href="/">← 本棚へ</a>';
  const gate = el("p", "作成できるか確認しています…", "message");
  gate.setAttribute("role", "status");
  app.append(gate);
  let initialSession;
  try {
    initialSession = await api("/session");
  } catch {}
  if (!app.contains(gate)) return;
  const access = creationAccess(initialSession?.creation, pending);
  if (!initialSession || (!access.canEdit && !access.canRetry)) {
    gate.textContent = access.reason;
    return;
  }
  app.innerHTML =
    '<a class="back" href="/">← 本棚へ</a><section class="book-heading"><h1>物語に、名前と最初の一節を。</h1><p>公開するまで、本棚には追加されません。</p></section><form id="new-book-form"><label for="title">本のタイトル（1〜100字）</label><input id="title" required autocomplete="off" aria-describedby="title-error"><p id="title-error" class="title-error" role="status" aria-live="polite"></p><label for="length">一冊の長さ</label><select id="length"></select><p id="capacity-note" class="note" role="status"></p><p>既にある本と同じ名前は使えません（空白・英字の大小・全角半角・一部の不可視文字は区別しません）。タイトルと長さは公開後に変更できません。</p><button class="primary">最初の一節を書く</button></form>';
  const form = app.querySelector("form"),
    title = app.querySelector("#title"),
    length = app.querySelector("#length");
  title.value = saved.title || "";
  let capacitiesReady = false;
  const capacityNote = app.querySelector("#capacity-note");
  let text = saved.text || "",
    composing = false,
    sending = false;
  const status = el("p", "", "message");
  status.setAttribute("role", "status");
  app.append(status);
  const snapshot = () => ({
    title: title.value,
    capacity: capacitiesReady ? Number(length.value) : saved.capacity || 4000,
    text,
  });
  function save() {
    if (!storageSet("new-book-draft", JSON.stringify(snapshot())))
      status.textContent =
        "端末への下書き保存ができません。画面を閉じる前に原稿をコピーしてください。";
  }
  const next = form.querySelector("button.primary");
  const titleCheck = titleValidation({
    input: title,
    message: app.querySelector("#title-error"),
    next,
    check: (value) => api("/title-availability", { title: value }),
  });
  const recheck = button("名前を再確認", () => titleCheck.validate());
  app.querySelector("#title-error").after(recheck);
  title.oninput = () => {
    save();
    titleCheck.validate();
  };
  length.onchange = save;
  titleCheck.validate();
  const editor = el("section", undefined, "creation-editor");
  editor.hidden = true;
  const heading = el("h1", saved.title || "最初の一節", "creation-title");
  editor.append(heading);
  const sheet = el("article", undefined, "novel-sheet");
  const draft = el("textarea");
  draft.id = "manuscript";
  draft.value = text;
  draft.spellcheck = false;
  draft.setAttribute("aria-label", "最初の一節（縦書き・1〜400字）");
  sheet.append(draft);
  editor.append(sheet);
  const formLimit = el("p", "公開可能日時を確認しています…", "note");
  form.append(formLimit);
  const editorLimit = el("p", "", "note");
  let allowedAt = Infinity,
    permission = null;
  function applyPermission(value) {
    permission = value;
    if (value.capacities) {
      const restored = restoreCapacity(
        capacitiesReady ? snapshot() : saved,
        pending,
        value.capacities,
      );
      length.replaceChildren(
        ...value.capacities.map((c) => {
          const option = el(
            "option",
            capacityNames[c] + " — " + c.toLocaleString() + "字",
          );
          option.value = String(c);
          return option;
        }),
      );
      length.value = String(restored.draft.capacity);
      capacitiesReady = true;
      if (restored.message) {
        pending = restored.pending;
        storageRemove("new-book-pending");
        capacityNote.textContent = restored.message;
        form.hidden = false;
        editor.hidden = true;
        document.body.classList.remove("creation-writing");
        save();
      }
    }
    allowedAt =
      performance.now() +
      (!value.nextCreationAt
        ? 0
        : Math.max(0, Date.parse(value.nextCreationAt) - value.serverTime));
  }
  async function refreshPermission() {
    try {
      const session = await api("/session");
      applyPermission(session.creation);
      if (session.isAdmin) permission.admin = true;
    } catch {
      permission = null;
      status.textContent =
        "作成条件を取得できません。本棚に戻って再読み込みしてください。";
    }
    update();
  }
  const blocked = el("p", "", "message");
  blocked.setAttribute("role", "status");
  app.append(blocked);
  const counter = el("p");
  const controls = el("div", undefined, "actions");
  const back = button("タイトルと長さに戻る", () => {
    editor.hidden = true;
    document.body.classList.remove("creation-writing");
    form.hidden = false;
    titleCheck.validate();
  });
  const check = button("掲載内容を確認", preview, "primary");
  const retry = button("送信結果を確認・再送", () => send(pending));
  controls.append(back, check, retry);
  editor.append(
    counter,
    controls,
    editorLimit,
    el("p", "一回1〜400字。空白・改行も1字。Enterは改行です。", "note"),
  );
  app.append(editor);
  function update() {
    const access = creationAccess(permission, pending);
    blocked.textContent = access.reason;
    blocked.hidden = !access.reason;
    if (permission && !access.canEdit && !pending) {
      form.hidden = editor.hidden = true;
      document.body.classList.remove("creation-writing");
    }
    check.hidden = back.hidden = !!permission && !access.canEdit;
    const input = inspectInput(text);
    counter.textContent =
      input.count === null ? input.error : input.count + " / 400 字";
    check.disabled =
      !access.canEdit ||
      !capacitiesReady ||
      composing ||
      sending ||
      !!pending ||
      performance.now() < allowedAt ||
      !!permission?.activeLimitReached ||
      !input.valid;
    retry.hidden = !pending;
    retry.disabled = sending || !capacitiesReady;
    title.disabled =
      length.disabled =
      draft.readOnly =
        !access.canEdit || !!pending || sending;
    back.disabled = sending;
    if (permission)
      formLimit.textContent = editorLimit.textContent =
        permission.activeLimitReached
          ? `執筆中の本：${permission.activeCount}／${permission.maxActiveNovels}冊。新しい本を公開するには、いずれかの本を完結させてください。`
          : permission.admin
            ? "管理者モード：7日間の制限はありません（全体の執筆中冊数の上限は適用）。"
            : performance.now() >= allowedAt
              ? "新しい本を公開できます。公開後7日間は次の本を公開できません。"
              : "次に公開できる日時：" +
                formatDate(permission.nextCreationAt) +
                "（日本時間）。";
  }
  draft.oncompositionstart = () => {
    composing = true;
    update();
  };
  draft.oncompositionend = () => {
    composing = false;
    text = draft.value;
    save();
    update();
  };
  draft.oninput = () => {
    text = draft.value;
    save();
    update();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    if (
      !creationAccess(permission).canEdit ||
      !capacitiesReady ||
      !titleCheck.isValid() ||
      next.disabled
    )
      return;
    if (!inspectInput(title.value, true).valid) {
      status.textContent = inspectInput(title.value, true).error;
      return;
    }
    save();
    form.hidden = true;
    editor.hidden = false;
    heading.textContent = title.value;
    document.body.classList.add("creation-writing");
    update();
    draft.focus();
  };
  async function preview() {
    if (check.disabled) return;
    await refreshPermission();
    if (check.disabled) return;
    const dialog = el("dialog"),
      previewText = el("p", text, "creation-preview");
    dialog.append(
      el("h2", "この一節で本を公開しますか。"),
      el("p", title.value),
      el("p", length.selectedOptions[0].textContent),
      previewText,
    );
    dialog.append(
      button("原稿に戻る", () => dialog.close()),
      button(
        "この一節で本を公開する",
        () => {
          pending = { ...snapshot(), key: crypto.randomUUID() };
          if (!storageSet("new-book-pending", JSON.stringify(pending))) {
            pending = null;
            status.textContent =
              "再送用データを保存できません。ブラウザの保存設定を確認してください。";
            dialog.close();
            return;
          }
          dialog.close();
          send(pending);
        },
        "primary",
      ),
    );
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
  }
  async function send(payload) {
    if (sending || !payload) return;
    sending = true;
    update();
    status.textContent = "公開しています…";
    try {
      const result = await api("/novels", payload);
      storageRemove("new-book-pending");
      storageRemove("new-book-draft");
      location.href = "/novels/" + result.id;
    } catch (error) {
      status.textContent = error.message;
      if (error.creation) applyPermission(error.creation);
      if (
        error.creation ||
        (error.status && error.status < 500 && error.status !== 409)
      ) {
        pending = null;
        storageRemove("new-book-pending");
        save();
        await refreshPermission();
      }
    } finally {
      sending = false;
      update();
    }
  }
  if (pending) {
    document.body.classList.add("creation-writing");
    form.hidden = true;
    editor.hidden = false;
    status.textContent =
      "前回の公開結果を確認するため、同じ内容を再送できます。";
  }
  applyPermission(initialSession.creation);
  if (initialSession.isAdmin) permission.admin = true;
  const tick = setInterval(() => {
    if (!app.contains(editor)) {
      clearInterval(tick);
      return;
    }
    update();
  }, 1000);
  update();
}
