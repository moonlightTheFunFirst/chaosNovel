import test from "node:test";
import assert from "node:assert/strict";
import { creationAccess } from "../public/creation-permission.js";
import { openCreation } from "../public/creation.js";
const cooldown = { canCreate: false, nextCreationAt: "2026-10-25T07:27:00Z" };
test("creation gate blocks cooldown and capacity limits but preserves receipt recovery", () => {
  for (const p of [
    cooldown,
    { canCreate: false, activeLimitReached: true },
    null,
  ]) {
    assert.equal(creationAccess(p).canEdit, false);
    assert.equal(creationAccess(p).canRetry, false);
    assert.equal(creationAccess(p, true).canRetry, true);
    assert.ok(creationAccess(p).reason);
  }
  assert.match(creationAccess(cooldown).reason, /2026/);
  assert.equal(creationAccess({ canCreate: true }).canEdit, true);
  assert.equal(creationAccess({ canCreate: true }).reason, "");
});
test("blocked creation renders only reason and back link without opening editor or changing saved draft", async () => {
  const old = globalThis.document;
  try {
    for (const permission of [
      cooldown,
      { canCreate: false, activeLimitReached: true },
      null,
    ]) {
      const nodes = [];
      const app = {
        innerHTML: "",
        append: (n) => nodes.push(n),
        contains: (n) => nodes.includes(n),
      };
      globalThis.document = { querySelector: () => app };
      let calls = 0;
      await openCreation({
        api: async (path) => {
          calls++;
          assert.equal(path, "/session");
          if (!permission) throw Error();
          return { creation: permission };
        },
        el: (tag, text) => ({ textContent: text, setAttribute() {} }),
        savedJSON: (key) =>
          key === "new-book-draft"
            ? { title: "保存", text: "原稿", capacity: 4000 }
            : null,
        storageSet() {
          assert.fail("must preserve storage");
        },
        storageRemove() {
          assert.fail("must preserve storage");
        },
      });
      assert.equal(calls, 1);
      assert.match(app.innerHTML, /本棚へ/);
      assert.doesNotMatch(app.innerHTML, /<form/);
      assert.equal(nodes[0].textContent, creationAccess(permission).reason);
    }
  } finally {
    globalThis.document = old;
  }
});
