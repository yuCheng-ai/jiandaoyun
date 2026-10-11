import { generateWebhookCredential } from "../src/domain/webhookSecurity";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  createField,
  emptySchema,
  copy,
  type FormSchema,
} from "../src/domain/form";
import {
  newForm,
  seedWorkspace,
  advanceEntry,
  type FormEntry,
} from "../src/domain/workspace";
import {
  newWebhook,
  parseExtensions,
  newInvocation,
  parseInvocation,
  validateWebhook,
  validateInvocation,
  runWebhook,
  runPlugin,
  fieldExtensionImpacts,
  sampleValues,
} from "../src/domain/extensions";
import { makeNode, makeEdge, parseDocument } from "../src/domain/workflow";
import {
  parseWorkspace,
  LocalWorkspaceRepository,
} from "../src/repositories/workspaceRepository";
import { useWorkspaceStore } from "../src/stores/workspace";
let memory: Map<string, string>,
  storage: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
  };
beforeEach(() => {
  memory = new Map();
  storage = {
    getItem: vi.fn((k) => memory.get(k) || null),
    setItem: vi.fn((k, v) => memory.set(k, v)),
  };
  vi.stubGlobal("localStorage", storage);
  setActivePinia(createPinia());
});
function fixture() {
  const data = seedWorkspace(),
    form = newForm("oa", "订单", "workflow");
  form.schema.fields = [
    createField("number", { id: "quantity", label: "数量" }),
    createField("number", { id: "price", label: "单价" }),
    createField("number", { id: "amount", label: "金额" }),
    createField("text", { id: "title", label: "订单名" }),
  ];
  data.forms.push(form);
  const config = newWebhook();
  const credential = generateWebhookCredential();
  data.webhookCredentials = [credential];
  config.credentialRef = credential.id;
  Object.assign(config, {
    name: "订单同步",
    url: "https://example.com/orders",
    fieldIds: ["title", "amount"],
    enabled: true,
  });
  const plugin = newInvocation("multiply");
  plugin.inputs = {
    quantity: { source: "field", value: "quantity" },
    price: { source: "field", value: "price" },
  };
  plugin.outputs = [{ outputKey: "amount", fieldId: "amount" }];
  return {
    data,
    form,
    config,
    plugin,
    values: { quantity: 3, price: 12.34, title: "订单A", amount: 0 },
  };
}
describe("extension configuration and execution", () => {
  it("migrates legacy forms and parses plugin bindings without touching field IDs", () => {
    const { data, form, plugin } = fixture();
    const node = makeNode("p", "plugin", 0, 0);
    node.data.plugin = "multiply";
    node.data.pluginConfig = plugin;
    form.workflow.nodes.push(node);
    delete form.extensions;
    const parsed = parseWorkspace(JSON.stringify(data));
    expect(parsed.forms.at(-1)!.extensions).toEqual({ webhooks: [] });
    expect(
      parsed.forms.at(-1)!.workflow.nodes.at(-1)!.data.pluginConfig,
    ).toEqual(plugin);
    expect(parseInvocation(undefined, "webhook").actionId).toBe("webhook");
    expect(() =>
      parseExtensions({ webhooks: [{ id: "a" }, { id: "a" }] }),
    ).toThrow();
  });
  it("reports invalid endpoints and stale payload references at precise steps", () => {
    const { form, config } = fixture();
    config.url = "javascript:alert(1)";
    config.fieldIds.push("deleted");
    expect(validateWebhook(config, form.schema).map((e) => e.step)).toEqual([
      1, 2,
    ]);
    config.url = "https://user:password@example.com";
    expect(validateWebhook(config, form.schema)[0]?.target).toBe("push-url");
  });
  it("filters events and data, produces stable-ID payload, and keeps input records immutable", () => {
    const { data, form, config, values } = fixture();
    config.filters = [
      {
        id: "f",
        sourceFieldId: "amount",
        operator: "greater",
        source: "constant",
        value: "100",
      },
    ];
    expect(
      runWebhook(config, form.schema, values, "data_create", data).status,
    ).toBe("skipped");
    const run = runWebhook(
      config,
      form.schema,
      { ...values, amount: 200 },
      "data_create",
      data,
    );
    expect(run.input.body).toMatchObject({
      op: "data_create",
      data: { title: "订单A", amount: 200 },
    });
    expect(run.status).toBe("success");
    expect(values.amount).toBe(0);
    expect(
      runWebhook(config, form.schema, values, "data_update", data).status,
    ).toBe("skipped");
  });
  it("deletion pushes never expose deleted field contents", () => {
    const { data, form, config, values } = fixture();
    config.events = ["data_remove"];
    const run = runWebhook(
      config,
      form.schema,
      values,
      "data_remove",
      data,
      false,
      "record1",
    );
    expect(run.input.body).toMatchObject({ data: { _id: "record1" } });
    expect(Object.keys((run.input.body as any).data)).toEqual(["_id"]);
  });
  it("records failure without output and a successful retry uses an independent snapshot", () => {
    const { data, form, config, values } = fixture();
    const failed = runWebhook(
      config,
      form.schema,
      values,
      "data_create",
      data,
      true,
    );
    expect(failed.status).toBe("failed");
    expect(failed.output).toEqual({});
    config.url = "https://changed.example";
    values.title = "Changed";
    expect(failed.snapshot.config).toMatchObject({
      url: "https://example.com/orders",
    });
    expect(failed.snapshot.values.title).toBe("订单A");
  });
  it("computes typed results, maps them atomically, and never changes trial inputs", () => {
    const { data, form, plugin, values } = fixture();
    const run = runPlugin(plugin, form.schema, values, data);
    expect(run.status).toBe("success");
    expect(run.mode).toBe("local");
    expect(run.mappedValues.amount).toBe(37.02);
    expect(values.amount).toBe(0);
    const failed = runPlugin(plugin, form.schema, values, data, true);
    expect(failed.mappedValues).toEqual({});
  });
  it("rejects incompatible or duplicated output targets and missing input values", () => {
    const { data, form, plugin, values } = fixture();
    plugin.outputs = [{ outputKey: "amount", fieldId: "title" }];
    expect(validateInvocation(plugin, form.schema)[0]?.step).toBe(2);
    plugin.outputs = [
      { outputKey: "amount", fieldId: "amount" },
      { outputKey: "amount", fieldId: "amount" },
    ];
    expect(
      validateInvocation(plugin, form.schema).some((i) =>
        i.message.includes("多个返回值"),
      ),
    ).toBe(true);
    plugin.outputs = [{ outputKey: "amount", fieldId: "amount" }];
    expect(
      runPlugin(plugin, form.schema, { ...values, quantity: "" }, data).status,
    ).toBe("failed");
    expect(
      runPlugin(plugin, form.schema, { ...values, quantity: "   " }, data)
        .status,
    ).toBe("failed");
  });
  it("rejects malformed JSON and resolves combined text without evaluating code", () => {
    const { form, data, values } = fixture();
    const config = newInvocation("webhook");
    config.inputs.url = { source: "constant", value: "https://example.com" };
    config.inputs.body = { source: "constant", value: "{invalid}" };
    expect(validateInvocation(config, form.schema)[0]?.target).toBe(
      "input-body",
    );
    const text = newInvocation("update");
    text.inputs.text = {
      source: "template",
      value: "单据 {{title}} · {{quantity}}",
    };
    text.outputs = [{ outputKey: "value", fieldId: "title" }];
    expect(runPlugin(text, form.schema, values, data).mappedValues.title).toBe(
      "单据 订单A · 3",
    );
    text.inputs.text.value = "{{missing}}";
    expect(validateInvocation(text, form.schema)[0]?.message).toContain(
      "不存在",
    );
  });
  it("resolves notification recipients from active members and excludes inactive people", () => {
    const { form, data, values } = fixture();
    const plugin = newInvocation("notification");
    plugin.inputs.recipients = {
      source: "constant",
      value: data.organization.currentUserId,
    };
    plugin.inputs.message = { source: "constant", value: "测试" };
    expect(runPlugin(plugin, form.schema, values, data).output.count).toBe(1);
    data.organization.employees.find(
      (e) => e.id === data.organization.currentUserId,
    )!.status = "inactive";
    expect(runPlugin(plugin, form.schema, values, data).status).toBe("failed");
  });
  it("identifies impacts before field deletion and preserves references after rename", () => {
    const { form, config, plugin } = fixture();
    form.extensions = { webhooks: [config] };
    const node = makeNode("p", "plugin", 0, 0);
    node.data.plugin = "multiply";
    node.data.pluginConfig = plugin;
    form.workflow.nodes.push(node);
    expect(fieldExtensionImpacts(form, ["amount"])).toHaveLength(2);
    form.schema.fields[2]!.label = "结算金额";
    expect(validateInvocation(plugin, form.schema)).toEqual([]);
    form.schema.fields = form.schema.fields.filter((f) => f.id !== "amount");
    expect(validateInvocation(plugin, form.schema)[0]?.step).toBe(2);
  });
  it("applies plugin output before choosing the next conditional branch", () => {
    const { form, plugin, data, values } = fixture();
    const flow = form.workflow;
    const p = makeNode("p", "plugin", 0, 0);
    p.data.plugin = "multiply";
    p.data.pluginConfig = plugin;
    const cond = makeNode("c", "condition", 0, 0);
    cond.data.condition = "申请金额 > 20";
    cond.data.conditionFieldId = "amount";
    const yes = makeNode("yes", "approval", 0, 0),
      no = makeNode("no", "approval", 0, 0);
    flow.nodes = [
      makeNode("start", "start", 0, 0),
      p,
      cond,
      yes,
      no,
      makeNode("end", "end", 0, 0),
    ];
    flow.edges = [
      makeEdge("start", "p"),
      makeEdge("p", "c"),
      makeEdge("c", "yes"),
      makeEdge("c", "no"),
      makeEdge("yes", "end"),
      makeEdge("no", "end"),
    ];
    const entry: FormEntry = {
      id: "e",
      formId: form.id,
      definitionVersion: 1,
      createdAt: "",
      status: "submitted",
      history: [],
      values,
    };
    advanceEntry(entry, flow, "start", (node, v) =>
      runPlugin(node.data.pluginConfig!, form.schema, v, data),
    );
    expect(entry.currentNodeId).toBe("yes");
    expect(entry.values.amount).toBe(37.02);
  });
  it("stops at failed plugin and retries without repeating prior approval", () => {
    const { form, plugin, data, values } = fixture();
    const flow = form.workflow;
    const p = makeNode("p", "plugin", 0, 0);
    p.data.plugin = "multiply";
    p.data.pluginConfig = plugin;
    flow.nodes = [
      makeNode("start", "start", 0, 0),
      p,
      makeNode("end", "end", 0, 0),
    ];
    flow.edges = [makeEdge("start", "p"), makeEdge("p", "end")];
    const entry: FormEntry = {
      id: "e",
      formId: form.id,
      definitionVersion: 1,
      createdAt: "",
      status: "submitted",
      history: [],
      values,
    };
    advanceEntry(entry, flow, "start", (node, v) =>
      runPlugin(node.data.pluginConfig!, form.schema, v, data, true),
    );
    expect(entry.currentNodeId).toBe("p");
    expect(entry.pluginError).toBeTruthy();
    expect(entry.status).toBe("submitted");
    advanceEntry(entry, flow, "retry", (node, v) =>
      runPlugin(node.data.pluginConfig!, form.schema, v, data),
    );
    expect(entry.status).toBe("approved");
    expect(entry.pluginError).toBeUndefined();
    expect(entry.values.amount).toBe(37.02);
  });
});
describe("extension persistence integration", () => {
  it("rolls back a newly introduced plugin error when saving an approval fails", async () => {
    const store = useWorkspaceStore();
    const { form, plugin, values } = fixture();
    const approval = makeNode("approval", "approval", 0, 0);
    approval.data.ownerMode = "initiator";
    const node = makeNode("plugin", "plugin", 0, 0);
    node.data.plugin = "multiply";
    node.data.pluginConfig = plugin;
    form.workflow.nodes = [
      makeNode("start", "start", 0, 0),
      approval,
      node,
      makeNode("end", "end", 0, 0),
    ];
    form.workflow.edges = [
      makeEdge("start", "approval"),
      makeEdge("approval", "plugin"),
      makeEdge("plugin", "end"),
    ];
    store.data.forms.push(form);
    expect(await store.publishForm(form.id)).toBe(true);
    const entry = (await store.submitEntry(form.id, {
      ...values,
      quantity: "",
    }))!;
    const before = copy(entry);
    storage.setItem.mockImplementation(() => {
      throw Error("quota");
    });
    expect(await store.processEntry(entry.id, "approved")).toBe(false);
    const restored = store.data.entries.find((item) => item.id === entry.id)!;
    expect(restored).toStrictEqual(before);
    expect(restored.pluginError).toBeUndefined();
    expect(store.data.extensionRuns || []).toHaveLength(0);
  });
  it("keeps published configurations immutable and emits logs only for published non-draft submissions", async () => {
    const store = useWorkspaceStore(),
      form = store.openForm("employee")!;
    const config = newWebhook();
    config.credentialRef = (await store.createWebhookCredential())!.id;
    Object.assign(config, {
      name: "test",
      url: "https://example.com",
      fieldIds: [form.schema.fields[0]!.id],
      enabled: true,
    });
    await store.saveWebhook(form.id, config);
    expect(await store.publishForm(form.id)).toBe(true);
    config.url = "https://changed.example";
    await store.saveWebhook(form.id, config);
    expect(form.published!.extensions!.webhooks[0]!.url).toBe(
      "https://example.com",
    );
    await store.submitEntry(form.id, {}, "draft");
    expect(store.data.extensionRuns || []).toHaveLength(0);
    await store.submitEntry(form.id, {
      [form.schema.fields[0]!.id]: "张三",
      [form.schema.fields[1]!.id]: "13900000001",
    });
    expect(store.data.extensionRuns).toHaveLength(1);
    expect(store.data.extensionRuns![0]!.input.url).toBe("https://example.com");
    expect(
      new LocalWorkspaceRepository(storage as any).load()!.extensionRuns,
    ).toHaveLength(1);
  });
  it("rolls back settings and execution logs when the local write fails", async () => {
    const store = useWorkspaceStore(),
      form = store.openForm("employee")!;
    const config = newWebhook();
    config.credentialRef = (await store.createWebhookCredential())!.id;
    Object.assign(config, {
      name: "test",
      url: "https://example.com",
      fieldIds: [form.schema.fields[0]!.id],
      enabled: true,
    });
    await store.saveWebhook(form.id, config);
    await store.publishForm(form.id);
    const before = copy(form.extensions);
    storage.setItem.mockImplementation(() => {
      throw Error("quota");
    });
    config.name = "unsaved";
    expect(await store.saveWebhook(form.id, config)).toBe(false);
    expect(form.extensions).toEqual(before);
    expect(await store.submitEntry(form.id, { name: "test" })).toBeUndefined();
    expect(store.data.extensionRuns || []).toHaveLength(0);
    expect(store.data.entries).toHaveLength(0);
  });
  it("disables copied pushes and does not copy publication history", async () => {
    const store = useWorkspaceStore(),
      form = store.openForm("employee")!;
    const config = newWebhook();
    config.credentialRef = (await store.createWebhookCredential())!.id;
    Object.assign(config, {
      name: "test",
      url: "https://example.com",
      fieldIds: [form.schema.fields[0]!.id],
      enabled: true,
    });
    await store.saveWebhook(form.id, config);
    const duplicate = (await store.duplicateForm(form.id))!;
    expect(duplicate.extensions!.webhooks[0]!.enabled).toBe(false);
    expect(duplicate.extensions!.webhooks[0]!.id).not.toBe(config.id);
  });
});
