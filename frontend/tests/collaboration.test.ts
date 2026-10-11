import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createField, copy } from "../src/domain/form";
import {
  defaultCollaboration,
  parseCollaboration,
  collaborationIssues,
  renderDataTitle,
  entryTitle,
  inlineEditField,
  prepareInlineEdit,
} from "../src/domain/collaboration";
import {
  parseExtensions,
  fieldExtensionImpacts,
  newWebhook,
} from "../src/domain/extensions";
import { defaultRecordView, filterAndSortRecords } from "../src/domain/records";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  parseWorkspace,
} from "../src/repositories/workspaceRepository";
beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((k) => memory.get(k) || null),
    setItem: vi.fn((k, v) => memory.set(k, v)),
  });
  setActivePinia(createPinia());
});
async function setup() {
  const store = useWorkspaceStore(),
    form = store.openForm((await store.createForm("oa", "合同", "form"))!.id)!;
  form.schema.fields = [
    createField("text", {
      id: "name",
      label: "名称",
      required: true,
      unique: true,
    }),
    createField("number", { id: "amount", label: "金额", min: 0 }),
    createField("member", { id: "owner", label: "负责人" }),
    createField("department", { id: "dept", label: "部门" }),
    createField("calculated", {
      id: "total",
      label: "双倍金额",
      expression: "{{amount}}*2",
    }),
  ];
  const config = {
    ...defaultCollaboration(),
    inlineEdit: true,
    titleMode: "custom" as const,
    titleParts: [
      { id: "p1", kind: "text" as const, value: "合同 · " },
      { id: "p2", kind: "field" as const, value: "name" },
      { id: "p3", kind: "text" as const, value: " / " },
      { id: "p4", kind: "field" as const, value: "owner" },
    ],
  };
  expect(await store.saveCollaboration(form.id, config)).toBe(true);
  expect(await store.publishForm(form.id)).toBe(true);
  const entry = (await store.submitEntry(form.id, {
    name: "A",
    amount: 2,
    owner: "zhang",
    dept: "product",
    total: 4,
  }))!;
  return { store, form, entry, config };
}
describe("data titles and inline editing", () => {
  it("round trips settings without introducing configuration into old extensions", async () => {
    const { store, form, config } = await setup();
    expect(parseCollaboration(config)).toEqual(config);
    expect(parseExtensions(undefined)).toEqual({ webhooks: [] });
    expect(
      parseWorkspace(JSON.stringify(store.data)).forms.find(
        (f) => f.id === form.id,
      )!.extensions!.collaboration,
    ).toEqual(config);
    expect(() =>
      parseCollaboration({
        ...config,
        titleParts: [config.titleParts[0], config.titleParts[0]],
      }),
    ).toThrow();
  });
  it("renders ordered field labels, preserves numeric zero and falls back for empty titles", async () => {
    const { store, form, config, entry } = await setup();
    expect(entryTitle(entry, store.data)).toBe("合同 · A / 张三");
    expect(
      renderDataTitle(
        defaultCollaboration(),
        form.schema,
        { amount: 0 },
        store.data,
        "fallback",
      ),
    ).toBe("0");
    expect(
      renderDataTitle(
        { ...config, titleParts: [] },
        form.schema,
        {},
        store.data,
        "fallback",
      ),
    ).toBe("fallback");
  });
  it("omits conditionally hidden fields and fields inside hidden tabs", async () => {
    const { store, form, config } = await setup();
    form.schema.settings.rules = [
      {
        id: "r",
        sourceId: "amount",
        operator: "greater",
        value: "5",
        targetIds: ["owner"],
      },
    ];
    expect(
      renderDataTitle(
        config,
        form.schema,
        { name: "A", owner: "zhang", amount: 2 },
        store.data,
        "fallback",
      ),
    ).toBe("合同 · A /");
    form.schema.fields = [
      createField("tabs", { visible: false, children: form.schema.fields }),
    ];
    expect(
      renderDataTitle(
        defaultCollaboration(),
        form.schema,
        { name: "private" },
        store.data,
        "fallback",
      ),
    ).toBe("fallback");
  });
  it("checks missing title references and preserves the title definition used by existing records", async () => {
    const { store, form, entry, config } = await setup();
    expect(fieldExtensionImpacts(form, ["name"])).toContain(
      "数据标题的字段内容",
    );
    config.titleParts[0]!.value = "新版 · ";
    await store.saveCollaboration(form.id, config);
    await store.publishForm(form.id);
    expect(entryTitle(entry, store.data)).toBe("合同 · A / 张三");
    form.schema.fields = form.schema.fields.filter((f) => f.id !== "owner");
    expect(collaborationIssues(config, form.schema).length).toBeGreaterThan(0);
    expect(await store.publishForm(form.id)).toBe(false);
  });
  it("finds records using custom fixed title text", async () => {
    const { store, form, entry } = await setup();
    expect(
      filterAndSortRecords([entry], form.schema, store.data, {
        query: "合同 ·",
        filters: [],
        view: defaultRecordView(form.schema),
      }),
    ).toHaveLength(1);
  });
  it("requires an enabled historical version and rejects drafts, deleted records and non-editable fields", async () => {
    const { store, form, entry, config } = await setup();
    expect(inlineEditField(entry, "amount", store.data)?.type).toBe("number");
    expect(inlineEditField(entry, "total", store.data)).toBeUndefined();
    expect(
      inlineEditField({ ...entry, status: "draft" }, "amount", store.data),
    ).toBeUndefined();
    expect(
      inlineEditField({ ...entry, deletedAt: "now" }, "amount", store.data),
    ).toBeUndefined();
    await store.saveCollaboration(form.id, { ...config, inlineEdit: false });
    await store.publishForm(form.id);
    const latest = (await store.submitEntry(form.id, {
      name: "B",
      amount: 2,
    }))!;
    expect(inlineEditField(latest, "amount", store.data)).toBeUndefined();
    expect(inlineEditField(entry, "amount", store.data)).toBeDefined();
  });
  it("blocks fields hidden by rules or made read-only through a container", async () => {
    const { store, entry } = await setup();
    const version = store.data.forms.find((f) => f.id === entry.formId)!
      .versions[0]!;
    version.schema.settings.rules = [
      {
        id: "r",
        sourceId: "amount",
        operator: "greater",
        value: "100",
        targetIds: ["owner"],
      },
    ];
    expect(inlineEditField(entry, "owner", store.data)).toBeUndefined();
    version.schema.fields = [
      createField("tabs", { editable: false, children: version.schema.fields }),
    ];
    expect(inlineEditField(entry, "amount", store.data)).toBeUndefined();
  });
  it("previews all dependent changes and persists calculated values with modification history", async () => {
    const { store, entry } = await setup();
    const result = prepareInlineEdit(entry, "amount", 5, store.data);
    expect(result.errors).toEqual([]);
    expect(result.changes.map((c) => c.id)).toEqual(["amount", "total"]);
    expect(entry.values.amount).toBe(2);
    const node = entry.currentNodeId,
      version = entry.definitionVersion;
    expect(
      await store.updateEntryField(entry.id, "amount", 5, copy(entry.values)),
    ).toBe(true);
    expect(entry.values.total).toBe(10);
    expect(entry.currentNodeId).toBe(node);
    expect(entry.definitionVersion).toBe(version);
    expect(entry.history.at(-1)!.label).toBe("表格快捷编辑");
  });
  it("validates unique values, number ranges and dynamic selections without partial writes", async () => {
    const { store, form, entry } = await setup();
    await store.submitEntry(form.id, { name: "B" });
    const before = copy(entry);
    for (const [id, value] of [
      ["name", "B"],
      ["name", ""],
      ["amount", -1],
      ["owner", "missing"],
    ])
      expect(
        await store.updateEntryField(
          entry.id,
          String(id),
          value,
          copy(entry.values),
        ),
      ).toBe(false);
    expect(entry).toEqual(before);
  });
  it("clears a member when a new department makes the member out of scope and shows both changes", async () => {
    const { store, entry } = await setup();
    const schema = store.data.forms.find((f) => f.id === entry.formId)!
      .versions[0]!.schema;
    schema.fields.find((f) => f.id === "owner")!.organization.scope.mode =
      "fieldDepartment";
    schema.fields.find((f) => f.id === "owner")!.organization.scope.fieldId =
      "dept";
    const result = prepareInlineEdit(entry, "dept", "finance", store.data);
    expect(result.values.owner).toBe("");
    expect(result.changes.map((c) => c.id)).toContain("owner");
    expect(result.errors).toEqual([]);
  });
  it("rejects a stale editing snapshot and avoids redundant history for unchanged values", async () => {
    const { store, entry } = await setup();
    const before = copy(entry.values);
    await store.updateEntryField(entry.id, "amount", 8, before);
    const current = copy(entry);
    expect(
      await store.updateEntryField(entry.id, "name", "stale", before),
    ).toBe(false);
    expect(entry).toEqual(current);
    expect(
      await store.updateEntryField(entry.id, "amount", 8, copy(entry.values)),
    ).toBe(true);
    expect(entry).toEqual(current);
  });
  it("rolls back the value, history and event log when persistence fails", async () => {
    const { store, form, config } = await setup();
    const c = newWebhook(),
      credential = (await store.createWebhookCredential())!;
    Object.assign(c, {
      enabled: true,
      name: "更新",
      url: "https://example.com/hooks",
      credentialRef: credential.id,
      fieldIds: ["name"],
      events: ["data_update"],
    });
    await store.saveWebhook(form.id, c);
    await store.publishForm(form.id);
    const entry = (await store.submitEntry(form.id, {
      name: "C",
      amount: 2,
      total: 4,
    }))!;
    expect(
      await store.updateEntryField(entry.id, "amount", 3, copy(entry.values)),
    ).toBe(true);
    const before = copy(entry),
      runs = copy(store.data.extensionRuns);
    const spy = vi
      .spyOn(LocalWorkspaceRepository.prototype, "save")
      .mockImplementation(() => {
        throw Error("full");
      });
    expect(
      await store.updateEntryField(entry.id, "amount", 5, copy(entry.values)),
    ).toBe(false);
    expect(entry).toEqual(before);
    expect(store.data.extensionRuns).toEqual(runs);
    const extensions = copy(form.extensions);
    expect(
      await store.saveCollaboration(form.id, { ...config, inlineEdit: false }),
    ).toBe(false);
    expect(form.extensions).toEqual(extensions);
    spy.mockRestore();
  });
});
