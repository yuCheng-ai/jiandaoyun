import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { INestApplication } from "@nestjs/common";

export const field = (id: string, type = "text", extra: Record<string, unknown> = {}) => ({ id, type, label: id, visible: true, editable: true, required: false, unique: false, masked: false, defaultValue: "", precision: 2, maxLength: 200, children: [], ...extra });
export const schema = (...fields: ReturnType<typeof field>[]) => ({ version: 1, fields, settings: { rules: [] } });
export function harness() {
  process.env.DATABASE_SCHEMA = `platform_test_${randomUUID().replaceAll("-", "")}`;
  const { createApp } = require("../src/app") as typeof import("../src/app");
  const { config } = require("../src/config") as typeof import("../src/config");
  const { Database } = require("../src/database") as typeof import("../src/database");
  let app: INestApplication, base = "";
  const cookies: Record<string, string> = {};
  const request = async (path: string, method = "GET", body?: unknown, user = "admin", expected: number | number[] = 200, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { Origin: config.origin, "Content-Type": "application/json", Cookie: cookies[user] || "", ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json() as any;
    if (Array.isArray(expected)) assert.ok(expected.includes(response.status), `${method} ${path} (${response.status}): ${JSON.stringify(value)}`);
    else assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const login = async (username: string, password: string, alias = username) => {
    const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: config.origin, "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    cookies[alias] = cookie.split(";")[0]!;
  };
  const start = async () => {
    assert.ok(/^platform_test_[a-f0-9]+$/.test(config.schema) && config.schema === process.env.DATABASE_SCHEMA, "Tests must resolve their isolated schema before loading application modules");
    app = await createApp(); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
    for (const username of ["admin", "editor", "reviewer"]) {
      await login(username, process.env[`PLATFORM_${username.toUpperCase()}_PASSWORD`]!);
    }
  };
  return {
    start, request, login, get db() { return app.get(Database); },
    async restart() { await app.close(); await start(); },
    async close() {
      await app?.close(); const cleanup = new Pool({ connectionString: config.databaseUrl });
      if (!/^platform_test_[a-f0-9]+$/.test(config.schema)) throw new Error("Unsafe cleanup schema");
      await cleanup.query(`DROP SCHEMA "${config.schema}" CASCADE`); await cleanup.end();
    },
    async definition(title: string, definitionSchema: ReturnType<typeof schema>) {
      const def = await request("/definitions", "POST", { title, schema: definitionSchema }, "admin", 201);
      await request(`/definitions/${def.id}/publish`, "POST", { expectedRevision: 1 }, "admin", 201);
      return { ...def, revision: 2, latestVersion: 1 };
    },
    async grant(definitionId: string, policy: { userId: string; [key: string]: unknown }) {
      const current = (await request(`/definitions/${definitionId}/grants`)).find((grant: any) => grant.userId === policy.userId);
      return request(`/definitions/${definitionId}/grants`, "PUT", { ...policy, expectedRevision: current?.revision ?? 0 });
    },
    async record(definitionId: string, values: unknown, user = "admin", version = 1) {
      return request(`/definitions/${definitionId}/records`, "POST", { requestId: randomUUID(), version, values }, user, 201);
    },
    async relation(spec: unknown) {
      const relation = await request("/relations", "POST", { spec }, "admin", 201);
      return request(`/relations/${relation.id}/publish`, "POST", { expectedRevision: relation.revision }, "admin", 201);
    },
  };
}
