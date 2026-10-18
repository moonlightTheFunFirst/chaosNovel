import test from "node:test";
import assert from "node:assert/strict";
import { visiblePolling, POLL_IDLE_MS, retryAfterMs } from "../public/sync.js";
function harness(poll = async () => ({ updated: false }), opts = {}) {
  const doc = new EventTarget();
  doc.hidden = false;
  let time = 0,
    task = null,
    calls = 0;
  const pauses = [];
  const stop = visiblePolling(
    doc,
    async () => {
      calls++;
      return poll();
    },
    {
      setTimeout: (fn, ms) => {
        task = { fn, at: time + ms };
        return 1;
      },
      clearTimeout: () => {
        task = null;
      },
    },
    { now: () => time, onPause: (p) => pauses.push(p), ...opts },
  );
  return {
    doc,
    stop,
    pauses,
    get calls() {
      return calls;
    },
    get wait() {
      return task ? task.at - time : null;
    },
    async tick() {
      assert.ok(task);
      const next = task;
      time = next.at;
      task = null;
      await next.fn();
    },
    async event(name) {
      doc.dispatchEvent(new Event(name));
      await new Promise((r) => setImmediate(r));
    },
    async advance(ms) {
      const target = time + ms;
      while (task && task.at <= target) {
        await this.tick();
      }
      time = target;
    },
  };
}
test("polling backs off 3/6/12/30 seconds and resets on updates and input", async () => {
  let updated = false;
  const h = harness(async () => ({ updated }));
  assert.equal(h.wait, 3000);
  await h.tick();
  assert.equal(h.wait, 6000);
  await h.tick();
  assert.equal(h.wait, 12000);
  await h.tick();
  assert.equal(h.wait, 30000);
  await h.tick();
  assert.equal(h.wait, 30000);
  updated = true;
  await h.tick();
  assert.equal(h.wait, 3000);
  updated = false;
  await h.tick();
  assert.equal(h.wait, 6000);
  await h.event("input");
  assert.equal(h.wait, 3000);
  h.stop();
  assert.equal(h.wait, null);
});
test("polling stops at ten idle minutes, resumes on operation or explicit refresh", async () => {
  const h = harness();
  await h.advance(POLL_IDLE_MS);
  assert.equal(h.wait, null);
  assert.deepEqual(h.pauses, [true]);
  assert.equal(h.calls, 22);
  await h.event("pointerdown");
  assert.equal(h.calls, 23);
  assert.equal(h.wait, 3000);
  assert.deepEqual(h.pauses, [true, false]);
  await h.advance(POLL_IDLE_MS);
  h.stop.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.wait, 3000);
  h.stop();
});
test("hidden polling sends nothing; visible polling fetches immediately", async () => {
  const h = harness();
  h.doc.hidden = true;
  await h.event("visibilitychange");
  await h.advance(60000);
  assert.equal(h.calls, 0);
  h.doc.hidden = false;
  await h.event("visibilitychange");
  assert.equal(h.calls, 1);
  h.stop();
});
test("network errors back off, Retry-After survives input and visibility; 404 stops", async () => {
  let failure = { status: 503, retryAfterMs: 90000 };
  const h = harness(async () => {
    throw failure;
  });
  await h.tick();
  assert.equal(h.wait, 90000);
  await h.event("input");
  assert.equal(h.wait, 90000);
  await h.event("visibilitychange");
  assert.equal(h.calls, 1);
  await h.tick();
  assert.equal(h.calls, 2);
  failure = {};
  await h.tick();
  assert.equal(h.wait, 12000);
  failure = { status: 404 };
  await h.tick();
  assert.equal(h.wait, null);
  await h.event("input");
  assert.equal(h.wait, null);
  assert.equal(retryAfterMs("120"), 120000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 0), 60000);
  assert.equal(retryAfterMs("bad", 0), 0);
  h.stop();
});
test("completed books do not poll unless a pending submission needs recovery", async () => {
  let pending = false;
  const h = harness(async () => ({ updated: false }), {
    eligible: () => pending,
  });
  assert.equal(h.wait, null);
  await h.event("input");
  assert.equal(h.calls, 0);
  pending = true;
  h.stop.activity();
  await h.tick();
  assert.equal(h.calls, 1);
  pending = false;
  h.stop.reconcile();
  assert.equal(h.wait, null);
  h.stop();
});
test("activity during in-flight poll resets next interval without overlap", async () => {
  let finish;
  const h = harness(() => new Promise((r) => (finish = r)));
  const tick = h.tick();
  await h.event("input");
  h.stop.refresh();
  assert.equal(h.calls, 1);
  finish({ updated: false });
  await tick;
  assert.equal(h.wait, 3000);
  h.stop();
});
