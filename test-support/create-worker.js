import { parentPort, workerData } from "node:worker_threads";
import { Store } from "../store.js";
const s = new Store(workerData.path);
let result;
try {
  result = s.publish("同時", 4000, workerData.p, workerData.key, "あ");
} catch (e) {
  result = { status: e.status, error: e.message };
} finally {
  s.close();
}
parentPort.postMessage(result);
