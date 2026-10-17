import { inspectInput } from "./text.js";

export function titleValidation({
  input,
  message,
  next,
  check,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let revision = 0,
    timer,
    composing = false,
    valid = false;
  function show(text, invalid = false) {
    message.textContent = text;
    input.setAttribute("aria-invalid", String(invalid));
    next.disabled = !valid;
  }
  function validate() {
    const ticket = ++revision;
    cancel(timer);
    valid = false;
    if (composing) {
      show("入力を確定してください。");
      return;
    }
    const title = input.value;
    const inspected = inspectInput(title, true);
    if (!inspected.valid) {
      show(
        !title.trim() ? "本の名前を入力してください。" : inspected.error,
        true,
      );
      return;
    }
    show("本の名前を確認しています…");
    timer = schedule(async () => {
      try {
        const result = await check(title);
        if (ticket !== revision) return;
        valid = result.available === true;
        show(valid ? "" : "既に存在する本の名前なので追加できません。", !valid);
      } catch {
        if (ticket !== revision) return;
        show(
          "本の名前を確認できませんでした。「名前を再確認」を押してください。",
          true,
        );
      }
    }, 300);
  }
  input.oncompositionstart = () => {
    composing = true;
    validate();
  };
  input.oncompositionend = () => {
    composing = false;
    validate();
  };
  return { validate, isValid: () => valid };
}
