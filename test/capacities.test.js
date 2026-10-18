import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { D1Store } from "../workers/store.js";
import { enabledCapacities, checkCreationCapacity } from "../capacities.js";
import { restoreCapacity } from "../public/creation-capacity.js";
import { capacityCases } from "../test-support/capacities.js";
import { createApp } from "../server.js";
import { randomUUID } from "node:crypto";

test("capacity configuration defaults, whitespace and invalid startup values", () => {
  assert.deepEqual(enabledCapacities(), [4000, 12000]);
  assert.deepEqual(enabledCapacities(" 40000, 4000 "), [4000, 40000]);
  for (const value of [
    "",
    " ",
    "4000,5000",
    "4000,4000",
    "abc",
    "4000,",
    ",4000",
  ]) {
    assert.throws(() => enabledCapacities(value), /ENABLED_CAPACITIES/);
    assert.throws(
      () => new Store(":memory:", { capacities: value }),
      /ENABLED_CAPACITIES/,
    );
    assert.throws(
      () => new D1Store(null, { capacities: value }),
      /ENABLED_CAPACITIES/,
    );
  }
  assert.throws(
    () => checkCreationCapacity(5000, [4000], true),
    (e) => e.status === 400,
  );
  assert.throws(() => checkCreationCapacity(40000, [12000]), /中編を選んで/);
});
test("Node capacity policy preserves retries and existing long books", async (t) => {
  const s = new Store(":memory:");
  t.after(() => s.close());
  await capacityCases(
    (value) => {
      if (value === undefined) return s;
      // A second policy instance sharing the same persisted database connection.
      const other = Object.create(s);
      other.capacities = enabledCapacities(value);
      return other;
    },
    (table) => s.db.prepare("SELECT count(*) n FROM " + table).get().n,
    (id) => s.db.prepare("UPDATE novels SET count=39999 WHERE id=?").run(id),
  );
});
test("unavailable draft and pending retain text and title, reset selection and pending", () => {
  const draft = { title: "原稿", text: "残す", capacity: 40000 },
    pending = { ...draft, key: "request-key" };
  for (const wait of [null, pending]) {
    const result = restoreCapacity(draft, wait, [4000, 12000]);
    assert.deepEqual(result.draft, { ...draft, capacity: 4000 });
    assert.equal(result.pending, null);
    assert.match(result.message, /短編に変更/);
  }
  assert.equal(
    restoreCapacity(draft, pending, [4000, 12000, 40000]).pending,
    pending,
  );
  assert.equal(restoreCapacity({}, null, [12000]).draft.capacity, 12000);
});
test("Node session and publish use actual admin cookie for capacity exemption", async (t) => {
  const s = new Store(":memory:"),
    server = createApp(s, {
      adminPassword: "test-password-long",
      cookieSecret: "s".repeat(40),
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    s.close();
  });
  const origin = "http://127.0.0.1:" + server.address().port,
    jar = new Map();
  async function call(path, body) {
    const r = await fetch(origin + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of r.headers.getSetCookie()) {
      const [k, v] = c.split(";")[0].split("=");
      jar.set(k, v);
    }
    return r;
  }
  assert.deepEqual(
    (await (await call("/session")).json()).creation.capacities,
    [4000, 12000],
  );
  const body = {
    title: "長編",
    capacity: 40000,
    text: "あ",
    key: randomUUID(),
  };
  assert.equal((await call("/novels", body)).status, 400);
  assert.equal(
    (await call("/admin", { password: "test-password-long" })).status,
    200,
  );
  assert.deepEqual(
    (await (await call("/session")).json()).creation.capacities,
    [4000, 12000, 40000],
  );
  assert.equal((await call("/novels", body)).status, 200);
});
