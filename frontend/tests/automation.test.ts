import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { makeNode, makeEdge } from "../src/domain/workflow";
import { createField, copy, type FormValues } from "../src/domain/form";
import {
  newAutomation,
  newAutomationStep,
  parseAutomations,
  automationIssues,
  prepareAutomation,
  type AutomationConfig,
} from "../src/domain/automation";
import {
  fieldExtensionImpacts,
  parseExtensions,
} from "../src/domain/extensions";
import {
  LocalWorkspaceRepository,
  parseWorkspace,
} from "../src/repositories/workspaceRepository";
import { useWorkspaceStore } from "../src/stores/workspace";

beforeEach(() => {
  vi.restoreAllMocks();
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((k) => memory.get(k) || null),
    setItem: vi.fn((k, v) => memory.set(k, v)),
  });
  setActivePinia(createPinia());
});
async function setup(
  options: {
    unique?: boolean;
    workflow?: boolean;
    sourceWorkflow?: boolean;
  } = {},
) {
  const store = useWorkspaceStore();
  const destination = (await store.createForm(
    "oa",
    "目标台账",
    options.workflow ? "workflow" : "form",
  ))!;
  const target = store.openForm(destination.id)!;
  target.schema.fields = [
    createField("text", {
      id: "name",
      label: "名称",
      required: true,
      unique: !!options.unique,
    }),
    createField("number", { id: "quantity", label: "数量", min: 0 }),
    createField("select", {
      id: "state",
      label: "状态",
      options: [
        { id: "targetOpen", label: "待处理" },
        { id: "targetDone", label: "已完成" },
      ],
    }),
    createField("member", { id: "owner", label: "负责人" }),
  ];
  expect(await store.publishForm(target.id)).toBe(true);
  const source = store.openForm(
    (await store.createForm(
      "oa",
      "来源申请",
      options.sourceWorkflow ? "workflow" : "form",
    ))!.id,
  )!;
  source.schema.fields = [
    createField("text", { id: "code", label: "申请名称" }),
    createField("number", { id: "qty", label: "申请数量" }),
    createField("select", {
      id: "category",
      label: "申请状态",
      options: [{ id: "sourceOpen", label: "待处理" }],
    }),
    createField("member", { id: "applicant", label: "申请人" }),
  ];
  const c = newAutomation();
  c.name = "建立台账";
  c.events = ["data_create", "data_update", "data_remove", "data_recover"];
  Object.assign(c.steps[0]!, {
    targetFormId: target.id,
    targetVersion: 1,
    mappings: [
      { targetId: "name", source: "field", fieldId: "code", value: "" },
      { targetId: "quantity", source: "field", fieldId: "qty", value: "" },
      { targetId: "state", source: "field", fieldId: "category", value: "" },
    ],
  });
  expect(await store.saveAutomation(source.id, c)).toBe(true);
  expect(await store.publishForm(source.id)).toBe(true);
  const values: FormValues = {
    code: "申请 A",
    qty: 3,
    category: "sourceOpen",
    applicant: "li",
  };
  const trial = (config = c, input = values) =>
    prepareAutomation(config, source.schema, input, "data_create", store.data, {
      formId: source.id,
      trial: true,
    });
  return { store, source, target, c, values, trial };
}
describe("local automation transactions", () => {
  it("migrates optional settings, rejects duplicate IDs and round-trips configuration and logs", async () => {
    expect(parseExtensions(undefined)).toEqual({ webhooks: [] });
    const { store, source, c, trial } = await setup();
    expect(() => parseAutomations([c, c])).toThrow("重复");
    expect(() =>
      parseAutomations([{ ...c, steps: [c.steps[0], c.steps[0]] }]),
    ).toThrow("重复");
    await store.recordExtensionRun(trial().run, source.id);
    const restored = parseWorkspace(JSON.stringify(store.data));
    expect(
      restored.forms.find((f) => f.id === source.id)!.published!.extensions!
        .automations,
    ).toEqual([c]);
    expect(restored.extensionRuns![0]!.kind).toBe("automation");
  });
  it("previews typed mappings and choice-label conversion without mutating records", async () => {
    const { store, trial } = await setup(),
      before = copy(store.data.entries),
      result = trial();
    expect(result.run.status).toBe("success");
    expect(result.entries[0]!.values).toMatchObject({
      name: "申请 A",
      quantity: 3,
      state: "targetOpen",
    });
    expect(result.run.output.committed).toBe(false);
    expect(store.data.entries).toEqual(before);
    expect(result.changes[0]!.fields.find((f) => f.id === "state")!.after).toBe(
      "待处理",
    );
  });
  it("honors event, condition and disabled-state gates", async () => {
    const { store, source, c, values, trial } = await setup();
    c.events = ["data_update"];
    expect(trial().run.status).toBe("skipped");
    c.events = ["data_create"];
    c.filters = [
      {
        id: "filter",
        sourceFieldId: "qty",
        operator: "greater",
        source: "constant",
        value: "10",
      },
    ];
    expect(trial().entries).toEqual([]);
    c.filters = [];
    c.enabled = false;
    expect(
      prepareAutomation(c, source.schema, values, "data_create", store.data).run
        .status,
    ).toBe("skipped");
    expect(trial().run.status).toBe("success");
  });
  it("writes published actions on source events and retains triggering actor identity", async () => {
    const { store, source, target, values } = await setup();
    const sourceEntry = (await store.submitEntry(
      source.id,
      values,
      "submitted",
      undefined,
      "li",
    ))!;
    const created = store.data.entries.find((e) => e.formId === target.id)!;
    expect(created.values.quantity).toBe(3);
    expect(created.createdBy).toBe("li");
    expect(store.data.extensionRuns![0]).toMatchObject({
      kind: "automation",
      origin: "record",
      entryId: sourceEntry.id,
      status: "success",
      output: { committed: true, affected: 1 },
    });
  });
  it("makes earlier step creations available to later updates while preserving source bindings", async () => {
    const { c, target, trial } = await setup();
    const second = newAutomationStep();
    Object.assign(second, {
      action: "update",
      targetFormId: target.id,
      targetVersion: 1,
      filters: [
        {
          id: "match",
          sourceFieldId: "name",
          operator: "equals",
          source: "field",
          value: "code",
        },
      ],
      mappings: [
        { targetId: "quantity", source: "constant", fieldId: "", value: 9 },
      ],
    });
    c.steps.push(second);
    const result = trial();
    expect(result.run.status).toBe("success");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.values.quantity).toBe(9);
    expect(result.changes.map((c) => c.action)).toEqual(["create", "update"]);
  });
  it("supports conditional upsert and excludes recycled and draft rows from matching", async () => {
    const { store, c, target, values, trial } = await setup();
    Object.assign(c.steps[0]!, {
      action: "upsert",
      filters: [
        {
          id: "match",
          sourceFieldId: "name",
          operator: "equals",
          source: "field",
          value: "code",
        },
      ],
    });
    expect(trial().changes[0]!.action).toBe("create");
    const row = (await store.submitEntry(target.id, {
      name: values.code,
      quantity: 1,
    }))!;
    expect(trial().changes[0]!.action).toBe("update");
    await store.recycleEntries([row.id], true);
    await store.submitEntry(target.id, { name: values.code }, "draft");
    expect(trial().changes[0]!.action).toBe("create");
  });
  it("updates all matching rows, supports no-match policy and requires explicit whole-table scope", async () => {
    const { store, c, target, trial } = await setup();
    await store.submitEntry(target.id, { name: "A", quantity: 1 });
    await store.submitEntry(target.id, { name: "B", quantity: 2 });
    const s = c.steps[0]!;
    s.action = "update";
    s.mappings = [
      { targetId: "quantity", source: "constant", fieldId: "", value: 7 },
    ];
    expect(trial().run.error!.message).toContain("筛选条件");
    s.allowAll = true;
    expect(trial().entries).toHaveLength(2);
    s.filters = [
      {
        id: "x",
        sourceFieldId: "quantity",
        operator: "greater",
        source: "constant",
        value: "10",
      },
    ];
    expect(trial().run.steps.some((s) => s.status === "skipped")).toBe(true);
    s.onNoMatch = "fail";
    expect(trial().run.status).toBe("failed");
  });
  it("rejects missing required values, incompatible choices and invalid organization IDs", async () => {
    const { c, values, trial } = await setup();
    expect(trial(c, { ...values, code: "" }).run.status).toBe("failed");
    expect(trial(c, { ...values, category: "missing" }).run.status).toBe(
      "failed",
    );
    c.steps[0]!.mappings.push({
      targetId: "owner",
      source: "constant",
      fieldId: "",
      value: "nonexistent",
    });
    expect(trial().run.status).toBe("failed");
  });
  it("rolls back the whole assistant when a later step violates uniqueness", async () => {
    const { store, source, target, c, values, trial } = await setup({
      unique: true,
    });
    c.steps.push({ ...copy(c.steps[0]!), id: "second" });
    const result = trial();
    expect(result.run.status).toBe("failed");
    expect(result.run.output.rolledBack).toBe(1);
    expect(result.entries).toEqual([]);
    await store.saveAutomation(source.id, c);
    await store.publishForm(source.id);
    expect(await store.submitEntry(source.id, values)).toBeTruthy();
    expect(
      store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(0);
    expect(store.data.extensionRuns![0]!.status).toBe("failed");
  });
  it("keeps target versions pinned and rejects incompatible historical update fields", async () => {
    const { store, target, c, trial } = await setup();
    const old = (await store.submitEntry(target.id, {
      name: "existing",
      quantity: 2,
    }))!;
    target.schema.fields[1] = createField("text", {
      id: "quantity",
      label: "新版数量",
    });
    target.schema.fields.push(
      createField("text", { id: "new", label: "新版必填", required: true }),
    );
    await store.publishForm(target.id);
    expect(trial().entries[0]!.definitionVersion).toBe(1);
    Object.assign(c.steps[0]!, {
      action: "update",
      targetVersion: 2,
      allowAll: true,
    });
    expect(trial().run.error!.message).toContain("不兼容");
    expect(old.values.quantity).toBe(2);
  });
  it("uses immutable source configurations and gives copied assistants new IDs", async () => {
    const { store, source, target, c, values } = await setup();
    const old = (await store.submitEntry(source.id, values))!;
    await store.saveAutomation(source.id, { ...c, enabled: false });
    await store.publishForm(source.id);
    await store.updateEntry(old.id, { ...values, code: "old update" });
    expect(
      store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(2);
    await store.submitEntry(source.id, { ...values, code: "new version" });
    expect(
      store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(2);
    const duplicate = (await store.duplicateForm(source.id))!;
    expect(duplicate.extensions!.automations![0]!.id).not.toBe(c.id);
    expect(duplicate.extensions!.automations![0]!.steps[0]!.id).not.toBe(
      c.steps[0]!.id,
    );
    expect(duplicate.extensions!.automations![0]!.enabled).toBe(false);
  });
  it("reports source field deletion and archived target failures without replacing saved configuration", async () => {
    const { store, source, target, c, trial } = await setup();
    expect(fieldExtensionImpacts(source, ["code"])).toContain(
      "智能助手「建立台账」的触发条件或来源映射",
    );
    expect(
      automationIssues({ ...c, steps: [] }, source.schema, store.data),
    ).not.toEqual([]);
    expect(await store.saveAutomation(source.id, { ...c, steps: [] })).toBe(
      false,
    );
    expect(source.extensions!.automations![0]).toEqual(c);
    await store.archiveForm(target.id);
    expect(trial().run.status).toBe("failed");
  });
  it("restores source, derived entries and logs together when storage fails on create/update/delete/restore", async () => {
    const { store, source, values } = await setup();
    const submitted = (await store.submitEntry(source.id, values))!;
    const entry = store.data.entries.find((e) => e.id === submitted.id)!;
    for (const operation of [
      async () =>
        await store.submitEntry(source.id, { ...values, code: "new" }),
      async () =>
        await store.updateEntry(entry.id, { ...values, code: "changed" }),
      async () => await store.recycleEntries([entry.id], true),
    ]) {
      const before = copy(store.data.entries),
        runs = copy(store.data.extensionRuns);
      const spy = vi
        .spyOn(LocalWorkspaceRepository.prototype, "save")
        .mockImplementation(() => {
          throw Error("full");
        });
      expect(await operation()).toBeFalsy();
      spy.mockRestore();
      expect(store.data.entries).toEqual(before);
      expect(store.data.extensionRuns).toEqual(runs);
      expect(store.data.entries.find((e) => e.id === entry.id)).toBe(entry);
    }
    await store.recycleEntries([entry.id], true);
    const before = copy(store.data.entries),
      runs = copy(store.data.extensionRuns);
    vi.spyOn(LocalWorkspaceRepository.prototype, "save").mockImplementation(
      () => {
        throw Error("full");
      },
    );
    expect(await store.recycleEntries([entry.id], false)).toBe(false);
    expect(store.data.entries).toEqual(before);
    expect(store.data.extensionRuns).toEqual(runs);
  });
  it("does not recursively invoke automation on derived records and retry is preview-only", async () => {
    const { store, source, target, c, values } = await setup();
    const targetAssistant: AutomationConfig = {
      ...copy(c),
      id: "loop",
      steps: [
        {
          ...copy(c.steps[0]!),
          mappings: [
            {
              targetId: "name",
              source: "constant",
              fieldId: "",
              value: "recursive",
            },
          ],
        },
      ],
    };
    expect(await store.saveAutomation(target.id, targetAssistant)).toBe(true);
    await store.publishForm(target.id);
    // Explicitly select V2 so derived records have an enabled assistant of their own.
    c.steps[0]!.targetVersion = 2;
    await store.saveAutomation(source.id, c);
    await store.publishForm(source.id);
    await store.submitEntry(source.id, values);
    expect(
      store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(1);
    const log = store.data.extensionRuns![0]!,
      before = copy(store.data.entries);
    const rerun = prepareAutomation(
      log.snapshot.config as AutomationConfig,
      log.snapshot.schema,
      log.snapshot.values,
      log.event!,
      store.data,
      { trial: true },
    );
    expect(rerun.run.status).toBe("success");
    expect(store.data.entries).toEqual(before);
  });
  it("starts a target workflow but does not emit update automation for unchanged approval navigation", async () => {
    const { store, source, target, values } = await setup({
      workflow: true,
      sourceWorkflow: true,
    });
    const entry = (await store.submitEntry(source.id, values))!;
    const targetEntry = store.data.entries.find((e) => e.formId === target.id)!;
    expect(targetEntry.status).toBe("submitted");
    expect(targetEntry.currentNodeId).toBeTruthy();
    const before = store.data.extensionRuns!.filter(
      (r) => r.kind === "automation",
    ).length;
    expect(await store.processEntry(entry.id, "approved")).toBe(true);
    expect(
      store.data.extensionRuns!.filter((r) => r.kind === "automation"),
    ).toHaveLength(before);
  });
  it("uses the triggering member for current-user conditions rather than the preview administrator", async () => {
    const { store, source, target, c, values } = await setup();
    c.filters = [
      {
        id: "mine",
        sourceFieldId: "applicant",
        operator: "equals",
        source: "currentUser",
        value: "",
      },
    ];
    await store.saveAutomation(source.id, c);
    await store.publishForm(source.id);
    await store.submitEntry(source.id, values, "submitted", undefined, "li");
    expect(
      store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(1);
  });
  it("does not execute assistants for drafts or unchanged edits", async () => {
    const { store, source, target, values } = await setup();
    await store.submitEntry(source.id, values, "draft");
    expect(
      store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(0);
    const entry = (await store.submitEntry(source.id, values))!;
    await store.updateEntry(entry.id, copy(values));
    expect(
      store.data.entries.filter((e) => e.formId === target.id),
    ).toHaveLength(1);
  });
  it("restores existing target updates as well as the source when persistence fails", async () => {
    const { store, source, target, c, values } = await setup();
    const entry = (await store.submitEntry(source.id, values))!;
    Object.assign(c.steps[0]!, {
      action: "update",
      allowAll: true,
      mappings: [
        { targetId: "quantity", source: "field", fieldId: "qty", value: "" },
      ],
    });
    await store.saveAutomation(source.id, c);
    await store.publishForm(source.id);
    // New source uses V2 while preserving the pre-existing target record.
    const latest = (await store.submitEntry(source.id, {
      ...values,
      code: "v2",
    }))!;
    const before = copy(store.data.entries),
      runs = copy(store.data.extensionRuns);
    vi.spyOn(LocalWorkspaceRepository.prototype, "save").mockImplementation(
      () => {
        throw Error("full");
      },
    );
    expect(
      await store.updateEntry(latest.id, {
        ...latest.values,
        code: "changed",
        qty: 99,
      }),
    ).toBe(false);
    expect(store.data.entries).toEqual(before);
    expect(store.data.extensionRuns).toEqual(runs);
    expect(store.data.entries.some((e) => e.id === entry.id)).toBe(true);
  });
  it("preserves the original trigger snapshot when an action updates its own source", async () => {
    const { store, source, target, c, values } = await setup();
    const self = newAutomationStep();
    Object.assign(self, {
      action: "update",
      targetFormId: source.id,
      targetVersion: 1,
      allowAll: true,
      mappings: [
        { targetId: "code", source: "constant", fieldId: "", value: "after" },
      ],
    });
    c.steps.unshift(self);
    await store.saveAutomation(source.id, c);
    await store.publishForm(source.id);
    const entry = (await store.submitEntry(source.id, values))!;
    expect(entry.values.code).toBe("after");
    expect(
      store.data.entries.find((e) => e.formId === target.id)!.values.name,
    ).toBe("申请 A");
    expect(store.data.extensionRuns![0]!.snapshot.values.code).toBe("申请 A");
  });
  it("reports target workflow plugin failure and never commits a partially started record", async () => {
    const { store, target, c, trial } = await setup({ workflow: true });
    const start = makeNode("s", "start", 0, 0),
      plugin = makeNode("p", "plugin", 0, 150),
      end = makeNode("e", "end", 0, 300);
    plugin.data.plugin = "multiply";
    plugin.data.pluginConfig = {
      actionId: "multiply",
      inputs: {
        quantity: { source: "field", value: "quantity" },
        price: { source: "constant", value: "1e308" },
      },
      outputs: [{ outputKey: "amount", fieldId: "quantity" }],
    };
    target.workflow.nodes = [start, plugin, end];
    target.workflow.edges = [makeEdge("s", "p"), makeEdge("p", "e")];
    expect(await store.publishForm(target.id)).toBe(true);
    c.steps[0]!.targetVersion = 2;
    expect(trial().run.error!.message).toContain(
      "目标流程无法启动：计算结果超出有效数字范围",
    );
    expect(trial().entries).toEqual([]);
  });
});
