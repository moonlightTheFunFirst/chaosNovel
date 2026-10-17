import test from "node:test";
import assert from "node:assert/strict";
import { titleValidation } from "../public/title-validation.js";
import { Store } from "../store.js";
import { createApp } from "../server.js";
function fixture(check) {
  const attrs = {},
    input = { value: "", setAttribute: (k, v) => (attrs[k] = v) },
    message = {},
    next = {};
  let job;
  const controller = titleValidation({
    input,
    message,
    next,
    check,
    schedule: (fn) => (job = fn),
    cancel: () => {
      job = null;
    },
  });
  return { input, message, next, attrs, ...controller, run: () => job() };
}
test("empty/whitespace and invalid titles show inline errors and disable next without requesting", () => {
  const f = fixture(() => assert.fail("must not request"));
  for (const value of ["", "　 ", "あ".repeat(101)]) {
    f.input.value = value;
    f.validate();
    assert.equal(f.next.disabled, true);
    assert.equal(f.attrs["aria-invalid"], "true");
    assert.ok(f.message.textContent);
  }
});
test("duplicate title blocks next; correcting it enables next; failures remain blocked", async () => {
  const f = fixture(async (title) => {
    if (title === "通信失敗") throw Error();
    return { available: title !== "重複" };
  });
  f.input.value = "重複";
  f.validate();
  assert.equal(f.next.disabled, true);
  await f.run();
  assert.match(f.message.textContent, /既に存在/);
  assert.equal(f.next.disabled, true);
  f.input.value = "新しい本";
  f.validate();
  await f.run();
  assert.equal(f.next.disabled, false);
  assert.equal(f.message.textContent, "");
  f.input.value = "通信失敗";
  f.validate();
  await f.run();
  assert.equal(f.next.disabled, true);
  assert.match(f.message.textContent, /再確認/);
});
test("out-of-order results and IME conversion cannot enable next for stale input", async () => {
  const waits = [];
  const f = fixture(() => new Promise((resolve) => waits.push(resolve)));
  f.input.value = "旧";
  f.validate();
  const first = f.run();
  f.input.value = "新";
  f.validate();
  const second = f.run();
  waits[1]({ available: false });
  await second;
  waits[0]({ available: true });
  await first;
  assert.equal(f.next.disabled, true);
  assert.match(f.message.textContent, /既に存在/);
  f.input.oncompositionstart();
  assert.equal(f.next.disabled, true);
  f.input.value = "変換済";
  f.input.oncompositionend();
  const third = f.run();
  f.input.value = "";
  f.validate();
  waits[2]({ available: true });
  await third;
  assert.equal(f.next.disabled, true);
  assert.match(f.message.textContent, /入力してください/);
});
test("availability API shares trimmed title rule, validates input, and writes no book or participant", async (t) => {
  const s = new Store(":memory:");
  s.create("　既存 ", 4000);
  const server = createApp(s);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    s.close();
  });
  const base = "http://127.0.0.1:" + server.address().port;
  for (const [title, available] of [
    ["既存", false],
    [" 既存　", false],
    ["新しい本", true],
  ]) {
    const r = await fetch(base + "/api/title-availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { available });
  }
  for (const title of ["", " ", "あ".repeat(101)]) {
    const r = await fetch(base + "/api/title-availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    assert.equal(r.status, 400);
  }
  assert.equal(s.list().length, 1);
  assert.equal(s.db.prepare("SELECT count(*) n FROM participants").get().n, 0);
});
