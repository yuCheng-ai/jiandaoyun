import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createField, copy, type FormValues } from "../src/domain/form";
import {
  newButton,
  parseButtons,
  buttonIssues,
  prepareButton,
  buttonTargets,
  type ButtonMapping,
} from "../src/domain/buttons";
import {
  parseExtensions,
  fieldExtensionImpacts,
  newWebhook,
} from "../src/domain/extensions";
import {
  LocalWorkspaceRepository,
  parseWorkspace,
} from "../src/repositories/workspaceRepository";
import { useWorkspaceStore } from "../src/stores/workspace";
beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((k) => memory.get(k) || null),
    setItem: vi.fn((k, v) => memory.set(k, v)),
  });
  setActivePinia(createPinia());
});
const constant = (targetId: string, value: unknown): ButtonMapping => ({
  targetId,
  value,
  source: "constant",
  fieldId: "",
});
const field = (targetId: string, fieldId: string): ButtonMapping => ({
  targetId,
  fieldId,
  source: "field",
  value: "",
});
async function setup() {
  const store = useWorkspaceStore(),
    form = store.openForm(
      (await store.createForm("oa", "操作测试", "form"))!.id,
    )!;
  form.schema.fields = [
    createField("text", { id: "name", required: true, unique: true }),
    createField("number", { id: "amount", min: 0 }),
    createField("select", {
      id: "state",
      options: [
        { id: "todo", label: "待处理" },
        { id: "done", label: "已处理" },
      ],
    }),
    createField("member", { id: "owner" }),
  ];
  const config = newButton();
  Object.assign(config, {
    name: "标记已处理",
    positions: ["fill", "detail", "row"],
    mappings: [constant("state", "done")],
  });
  return {
    store,
    form,
    config,
    values: {
      name: "A",
      amount: 2,
      state: "todo",
      owner: "zhang",
    } as FormValues,
  };
}
describe("custom buttons", () => {
  it("round trips typed constants and keeps legacy extensions unchanged", async () => {
    const { config } = await setup();
    config.mappings.push(constant("amount", 0));
    expect(parseButtons([config])).toEqual([config]);
    expect(parseExtensions(undefined)).toEqual({ webhooks: [] });
    expect(() => parseButtons([config, config])).toThrow();
  });
  it("rejects unsafe links and empty or repeated parameter names; encodes business values", async () => {
    const { store, form, config, values } = await setup();
    config.action = "link";
    for (const url of [
      "javascript:alert(1)",
      "https://user:pass@example.com",
      "/relative",
    ]) {
      config.url = url;
      expect(buttonIssues(config, form.schema)).not.toHaveLength(0);
    }
    config.url = "https://example.com/a?existing=1";
    config.params = [
      {
        name: "name",
        binding: { source: "field", fieldId: "name", value: "" },
      },
    ];
    const r = prepareButton(
      config,
      form.schema,
      { ...values, name: "订单 A&B/#" },
      store.data,
      "fill",
    );
    expect(r.status).toBe("ready");
    expect(new URL(r.url!).searchParams.get("name")).toBe("订单 A&B/#");
    expect(new URL(r.url!).searchParams.get("existing")).toBe("1");
    config.params.push(copy(config.params[0]!));
    expect(
      buttonIssues(config, form.schema).some((i) => i.target === "params"),
    ).toBe(true);
  });
  it("rechecks enabled state, placement and display filters without modifying input", async () => {
    const { store, form, config, values } = await setup();
    const before = copy(values);
    config.enabled = false;
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("hidden");
    expect(
      prepareButton(config, form.schema, values, store.data, "fill", true)
        .status,
    ).toBe("ready");
    config.enabled = true;
    config.positions = ["row"];
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("hidden");
    config.filters = [
      {
        id: "f",
        sourceFieldId: "amount",
        source: "constant",
        operator: "greater",
        value: "5",
      },
    ];
    expect(
      prepareButton(config, form.schema, values, store.data, "row").status,
    ).toBe("hidden");
    expect(values).toEqual(before);
  });
  it("applies zero values and simultaneous source mappings and validates invalid numeric input", async () => {
    const { store, form, config, values } = await setup();
    config.mappings = [constant("amount", 0), field("name", "amount")];
    const result = prepareButton(
      config,
      form.schema,
      values,
      store.data,
      "fill",
    );
    expect(result.values?.amount).toBe(0);
    expect(result.values?.name).toBe("2");
    config.mappings = [constant("amount", -1)];
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("error");
    config.mappings = [constant("amount", {})];
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("error");
  });
  it("blocks read-only and conditionally hidden fields including hidden containers", async () => {
    const { store, form, config, values } = await setup();
    form.schema.fields[2]!.editable = false;
    expect(
      buttonIssues(config, form.schema).some((i) => i.target === "mappings"),
    ).toBe(true);
    form.schema.fields[2]!.editable = true;
    form.schema.settings.rules = [
      {
        id: "visibility",
        sourceId: "amount",
        targetIds: ["state"],
        operator: "greater",
        value: "10",
      },
    ];
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("error");
    form.schema.fields = [
      createField("tabs", { visible: false, children: form.schema.fields }),
    ];
    expect(buttonTargets(form.schema)).toEqual([]);
  });
  it("requires published destinations and maps choices by unique label into target option IDs", async () => {
    const { store, form, config, values } = await setup();
    const target = store.openForm(
      (await store.createForm("oa", "目标", "form"))!.id,
    )!;
    target.schema.fields = [
      createField("select", {
        id: "targetState",
        options: [{ id: "targetTodo", label: "待处理" }],
      }),
      createField("text", { id: "required", required: true }),
    ];
    config.action = "openForm";
    config.targetFormId = target.id;
    config.mappings = [field("targetState", "state")];
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("error");
    expect(await store.publishForm(target.id)).toBe(true);
    const r = prepareButton(config, form.schema, values, store.data, "fill");
    expect(r.status).toBe("ready");
    expect(r.values?.targetState).toBe("targetTodo");
    expect(r.version).toBe(1);
    expect(store.data.entries).toHaveLength(0);
    const published = store.data.forms.find(
      (f) => f.id === target.id,
    )!.published!;
    published.schema.fields[0]!.options.push({
      id: "duplicate",
      label: "待处理",
    });
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("error");
  });
  it("rejects multiple values for a single member and invalid organization selections", async () => {
    const { store, form, config, values } = await setup();
    config.mappings = [constant("owner", ["zhang", "li"])];
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("error");
    config.mappings = [constant("owner", "no-such-person")];
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("error");
  });
  it("does not silently drop mapped values when dependent scopes reject them", async () => {
    const { store, form, config, values } = await setup();
    form.schema.fields.push(createField("department", { id: "dept" }));
    form.schema.fields[3]!.organization.scope.mode = "fieldDepartment";
    form.schema.fields[3]!.organization.scope.fieldId = "dept";
    config.mappings = [constant("dept", "finance"), constant("owner", "zhang")];
    expect(
      prepareButton(config, form.schema, values, store.data, "fill").status,
    ).toBe("error");
  });
  it("retains immutable published button definitions and tracks deleted field references", async () => {
    const { store, form, config } = await setup();
    expect(await store.saveButton(form.id, config)).toBe(true);
    expect(await store.publishForm(form.id)).toBe(true);
    const published = copy(form.published);
    config.mappings = [constant("amount", 0)];
    await store.saveButton(form.id, config);
    expect(form.published).toEqual(published);
    expect(fieldExtensionImpacts(form, ["amount"])[0]).toContain("按钮");
    const reloaded = parseWorkspace(JSON.stringify(store.data));
    expect(
      reloaded.forms.find((f) => f.id === form.id)!.extensions!.buttons![0]!
        .mappings[0]!.value,
    ).toBe(0);
    form.schema.fields = form.schema.fields.filter((f) => f.id !== "amount");
    expect(await store.publishForm(form.id)).toBe(false);
  });
  it("consumes a prefill once, binds its target/version and keeps its data out of persistent workspace", async () => {
    const { store, form, values } = await setup();
    const token = store.queuePrefill(form.id, 1, values);
    expect(JSON.stringify(store.data)).not.toContain(token);
    expect(store.consumePrefill(token, form.id, 1)).toEqual(values);
    expect(store.consumePrefill(token, form.id, 1)).toBeUndefined();
    expect(
      store.consumePrefill(store.queuePrefill(form.id, 1, values), form.id, 2),
    ).toBeUndefined();
  });
  it("updates the existing record through validation and events, records the button name, and rolls back a failed write", async () => {
    const { store, form, config, values } = await setup();
    const credential = (await store.createWebhookCredential())!,
      webhook = newWebhook();
    Object.assign(webhook, {
      enabled: true,
      name: "更新通知",
      url: "https://example.com/hooks",
      credentialRef: credential.id,
      events: ["data_update"],
      fieldIds: ["name"],
    });
    await store.saveWebhook(form.id, webhook);
    await store.saveButton(form.id, config);
    await store.publishForm(form.id);
    const entry = (await store.submitEntry(form.id, values))!;
    const prepared = prepareButton(
      config,
      form.published!.schema,
      entry.values,
      store.data,
      "row",
    );
    expect(
      await store.updateEntry(entry.id, prepared.values!, config.name),
    ).toBe(true);
    expect(entry.values.state).toBe("done");
    expect(entry.history.at(-1)!.label).toBe("按钮「标记已处理」");
    expect(store.data.extensionRuns?.at(0)?.event).toBe("data_update");
    const before = copy(entry),
      runs = copy(store.data.extensionRuns);
    expect(
      await store.updateEntry(
        entry.id,
        { ...entry.values, name: "" },
        config.name,
      ),
    ).toBe(false);
    const spy = vi
      .spyOn(LocalWorkspaceRepository.prototype, "save")
      .mockImplementation(() => {
        throw Error("full");
      });
    expect(
      await store.updateEntry(
        entry.id,
        { ...entry.values, amount: 8 },
        config.name,
      ),
    ).toBe(false);
    expect(entry).toEqual(before);
    expect(store.data.extensionRuns).toEqual(runs);
    spy.mockRestore();
  });
  it("rolls back configuration changes on persistence failure", async () => {
    const { store, form, config } = await setup();
    const before = copy(form.extensions);
    const spy = vi
      .spyOn(LocalWorkspaceRepository.prototype, "save")
      .mockImplementation(() => {
        throw Error("full");
      });
    expect(await store.saveButton(form.id, config)).toBe(false);
    expect(form.extensions).toEqual(before);
    spy.mockRestore();
  });
});
