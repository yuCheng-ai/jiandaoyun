// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import { createField } from "../src/domain/form";
import { generateWebhookCredential } from "../src/domain/webhookSecurity";
import { WORKSPACE_KEY } from "../src/repositories/workspaceRepository";
import { readMigrationResources } from "../src/repositories/migrationResources";
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => vi.unstubAllGlobals());
it("selects the complete application raw resources and omits independent credentials and other application records", async () => {
  const data = seedWorkspace(),
    form = newForm("oa", "迁移表单"),
    other = newForm("product", "其他应用表单");
  form.schema.fields = [createField("text", { id: "old_field" })];
  const definition = {
    version: 1,
    title: form.title,
    schema: structuredClone(form.schema),
    workflow: structuredClone(form.workflow),
    publishedAt: "2025-01-01T00:00:00Z",
  };
  form.versions = [definition];
  form.published = structuredClone(definition);
  form.archived = true;
  (form as any).legacyNote = { exact: "保留原始附加内容" };
  form.schema.fields = [createField("number", { id: "new_field" })];
  data.forms = [form, other];
  data.entries = [
    {
      id: "old_record",
      formId: form.id,
      definitionVersion: 1,
      createdBy: "zhang",
      createdAt: "2025-01-01T00:00:00Z",
      deletedAt: "2025-01-02T00:00:00Z",
      status: "approved",
      history: [],
      values: { old_field: "原值" },
    },
    {
      id: "other_record",
      formId: other.id,
      definitionVersion: 1,
      createdAt: "2025-01-01T00:00:00Z",
      status: "draft",
      history: [],
      values: { secret: "其他应用内容" },
    },
  ];
  data.formAccess = {};
  data.recordViews = {};
  data.organization.roles = [];
  data.webhookCredentials = [generateWebhookCredential()];
  const raw = JSON.stringify(data);
  localStorage.setItem(WORKSPACE_KEY, raw);
  const payload = await readMigrationResources("oa");
  expect(payload.forms).toEqual([JSON.parse(raw).forms[0]]);
  expect(payload.entries).toEqual([data.entries[0]]);
  expect(payload.forms[0].legacyNote).toEqual({ exact: "保留原始附加内容" });
  expect(JSON.stringify(payload)).not.toContain(
    data.webhookCredentials[0].secret,
  );
  expect(JSON.stringify(payload)).not.toContain("其他应用内容");
  expect(payload).not.toHaveProperty("organization");
  expect(localStorage.getItem(WORKSPACE_KEY)).toBe(raw);
});
it("does not archive a compatibility projection after resources would be filtered", async () => {
  const data = seedWorkspace();
  data.entries.push({
    id: "broken",
    formId: data.forms[0].id,
    status: "unknown",
  } as never);
  const raw = JSON.stringify(data);
  localStorage.setItem(WORKSPACE_KEY, raw);
  await expect(readMigrationResources("oa")).rejects.toThrow("entries");
  expect(localStorage.getItem(WORKSPACE_KEY)).toBe(raw);
});
it("keeps the independent member import action in the raw migration source", async () => {
  const data = seedWorkspace(),
    id = data.forms.find((f) => f.appId === "oa")!.id;
  data.formAccess = {};
  data.formAccess![id] = {
    membersEnabled: true,
    publicEnabled: false,
    allowMerged: false,
    filling: {
      enabled: true,
      startsAt: "",
      endsAt: "",
      limit: 0,
      allowRepeat: true,
    },
    groups: [
      {
        id: "import",
        name: "导入",
        enabled: true,
        archived: false,
        identities: ["zhang"],
        actions: ["view", "import"],
        scope: "self",
        filters: [],
        fields: {},
      },
    ],
  };
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
  const payload = await readMigrationResources("oa");
  expect((payload.access[id] as any).groups[0].actions).toEqual([
    "view",
    "import",
  ]);
});
