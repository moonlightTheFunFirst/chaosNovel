import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
export async function capacityCases(make, rows, nearEnd) {
  const s = make();
  const p = randomUUID();
  for (const table of [
    "novels",
    "posts",
    "creations",
    "creation_limits",
    "participants",
  ])
    assert.equal(await rows(table), 0);
  await assert.rejects(
    async () => s.publish("拒否", 40000, p, randomUUID(), "あ"),
    (e) => e.status === 400,
  );
  for (const table of [
    "novels",
    "posts",
    "creations",
    "creation_limits",
    "participants",
  ])
    assert.equal(await rows(table), 0);
  assert.equal((await s.creationStatus(p)).canCreate, true);
  assert.deepEqual((await s.creationStatus(p)).capacities, [4000, 12000]);
  assert.deepEqual(
    (await s.creationStatus(p, true)).capacities,
    [4000, 12000, 40000],
  );
  for (const capacity of [4000, 12000])
    assert.ok(
      (
        await s.publish(
          "区分" + capacity,
          capacity,
          randomUUID(),
          randomUUID(),
          "あ",
        )
      ).id,
    );
  assert.ok(
    (await s.publish("管理者長編", 40000, p, randomUUID(), "あ", true)).id,
  );
  const open = make("4000,12000,40000"),
    key = randomUUID();
  const result = await open.publish("解放長編", 40000, p, key, "あ");
  assert.deepEqual(await s.publish("解放長編", 40000, p, key, "あ"), result);
  await s.post(result.id, randomUUID(), randomUUID(), "続");
  assert.equal((await s.get(result.id, p)).count, 2);
  await nearEnd(result.id);
  const end = await s.post(result.id, randomUUID(), randomUUID(), "終わり");
  assert.equal(end.complete, true);
  assert.equal((await s.get(result.id, p)).count, 40000);
}
