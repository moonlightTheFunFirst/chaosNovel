import test from "node:test";
import assert from "node:assert/strict";
import {
  ReadingGate,
  clampPage,
  pageCountForWidth,
} from "../public/pagination.js";

test("pages respect physical column width and tiny layout rounding", () => {
  assert.equal(pageCountForWidth(0, 640), 1);
  assert.equal(pageCountForWidth(640, 640), 1);
  assert.equal(pageCountForWidth(641, 640), 1);
  assert.equal(pageCountForWidth(680, 640), 2);
  assert.equal(pageCountForWidth(640 * 100, 640), 100);
  assert.equal(clampPage(-1, 5), 0);
  assert.equal(clampPage(5, 5), 4);
});
test("writing unlocks at last page, including a direct skip, and survives new text", () => {
  const gate = new ReadingGate();
  assert.equal(gate.visit(0, 4), false);
  assert.equal(gate.visit(2, 4), false);
  assert.equal(gate.visit(3, 4), true);
  assert.equal(gate.visit(0, 4), true);
  assert.equal(gate.visit(3, 5), true);
  assert.equal(new ReadingGate().unlocked, false);
});
test("blank and one-page books allow writing as soon as that page is shown", () => {
  assert.equal(new ReadingGate().visit(0, 1), true);
});
