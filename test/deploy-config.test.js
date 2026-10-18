import test from "node:test";
import assert from "node:assert/strict";
import { validateDeployConfig } from "../scripts/deploy-config.js";
const good = () => ({
  name: "chaos-novel",
  vars: {
    PUBLIC_ORIGIN: "https://chaos-novel.example.workers.dev",
    COOKIE_SECURE: "1",
    ENABLED_CAPACITIES: "4000,12000",
    MAX_ACTIVE_NOVELS: "20",
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "chaos-novel-db",
      database_id: "12345678-1234-1234-1234-123456789abc",
      migrations_dir: "workers/migrations",
    },
  ],
});
test("deploy preflight accepts production configuration", () =>
  assert.doesNotThrow(() => validateDeployConfig(good())));
test("deploy preflight rejects placeholders, local mode and plaintext secrets", () => {
  for (const vars of [
    { PUBLIC_ORIGIN: "https://replace-before-publishing.invalid" },
    { PUBLIC_ORIGIN: "http://localhost:8787" },
    { PUBLIC_ORIGIN: "https://chaos-novel.example.workers.dev/" },
    { PUBLIC_ORIGIN: "https://other.example.workers.dev" },
    { COOKIE_SECURE: "0" },
    { LOCAL_DEV: "1" },
    { COOKIE_SECRET: "secret" },
    { ADMIN_PASSWORD: "secret" },
    { ENABLED_CAPACITIES: "" },
    { MAX_ACTIVE_NOVELS: "0" },
  ]) {
    const config = good();
    Object.assign(config.vars, vars);
    assert.throws(() => validateDeployConfig(config));
  }
  for (const database_id of [
    "00000000-0000-0000-0000-000000000000",
    "invalid",
  ]) {
    const config = good();
    config.d1_databases[0].database_id = database_id;
    assert.throws(() => validateDeployConfig(config));
  }
});
