import { count } from "./text.js";
export function openCreation({
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
  app.innerHTML =
    '<a class="back" href="/">← 本棚へ</a><section class="book-heading"><h1>物語に、名前と最初の一節を。</h1><p>公開するまで、本棚には追加されません。</p></section><form id="new-book-form"><label for="title">本のタイトル（1〜100字）</label><input id="title" required autocomplete="off"><label for="length">一冊の長さ</label><select id="length"><option value="4000">短編 — 4,000字</option><option value="12000">中編 — 12,000字</option><option value="40000">長編 — 40,000字</option></select><p>タイトルと長さは公開後に変更できません。</p><button class="primary">最初の一節を書く</button></form>';
  const form = app.querySelector("form"),
    title = app.querySelector("#title"),
    length = app.querySelector("#length");
  title.value = saved.title || "";
  length.value = String(saved.capacity || 4000);
  let text = saved.text || "",
    composing = false,
    sending = false;
  const status = el("p", "", "message");
  status.setAttribute("role", "status");
  app.append(status);
  const snapshot = () => ({
    title: title.value,
    capacity: Number(length.value),
    text,
  });
  function save() {
    if (!storageSet("new-book-draft", JSON.stringify(snapshot())))
      status.textContent =
        "端末への下書き保存ができません。画面を閉じる前に原稿をコピーしてください。";
  }
  title.oninput = length.onchange = save;
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
  const counter = el("p");
  const controls = el("div", undefined, "actions");
  const back = button("タイトルと長さに戻る", () => {
    editor.hidden = true;
    document.body.classList.remove("creation-writing");
    form.hidden = false;
  });
  const check = button("掲載内容を確認", preview, "primary");
  const retry = button("送信結果を確認・再送", () => send(pending));
  controls.append(back, check, retry);
  editor.append(
    counter,
    controls,
    el("p", "一回1〜400字。空白・改行も1字。Enterは改行です。", "note"),
  );
  app.append(editor);
  function update() {
    counter.textContent = count(text) + " / 400 字";
    check.disabled =
      composing || sending || !!pending || count(text) < 1 || count(text) > 400;
    retry.hidden = !pending;
    retry.disabled = sending;
    title.disabled = length.disabled = draft.readOnly = !!pending || sending;
    back.disabled = sending;
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
    if (!title.value.trim() || count(title.value) > 100) {
      status.textContent = "タイトルは1〜100字で入力してください。";
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
  function preview() {
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
      if (error.status && error.status < 500 && error.status !== 409) {
        pending = null;
        storageRemove("new-book-pending");
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
  update();
}
