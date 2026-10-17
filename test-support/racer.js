import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { Store } from "../store.js";
const store = new Store(workerData.path);
const flag = new Int32Array(workerData.gate);
parentPort.postMessage({ ready: true });
// Parent releases all workers after both/all connections are ready.
while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0);
try {
  parentPort.postMessage({
    ok: true,
    result: store.post(workerData.id, workerData.p, randomUUID(), "あ"),
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
} finally {
  store.close();
}
