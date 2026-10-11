import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import {
  defaultSerialSettings,
  formatSerialDate,
  parseSerialSettings,
  serialDateFormats,
  serialSettingsErrors,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  prepareSubmission,
  copy,
} from "../src/domain/form";
import {
  allocateSerialValues,
  parseSerialCounters,
  serialConfigurationErrors,
} from "../src/domain/serial";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import {
  newAutomation,
  newAutomationStep,
  prepareAutomation,
} from "../src/domain/automation";
import { seedWorkspace } from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import { defaultAccess, newAccessGroup } from "../src/domain/access";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";
let memory: Map<string, string>,
  failSave = false;
const tab = () => useWorkspaceStore(createPinia());
const saved = () => new LocalWorkspaceRepository().load()!;
beforeEach(() => {
  failSave = false;
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failSave) throw Error("磁盘已满");
      memory.set(key, value);
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function setup() {
  const store = tab(),
    form = (await store.createForm("oa", "流水号验收", "form"))!;
  const draft = store.openForm(form.id)!;
  draft.schema.fields = [
    createField("text", {
      id: "name",
      label: "名称",
      required: true,
      unique: true,
    }),
    createField("serial", { id: "serial" }),
  ];
  expect(await store.publishForm(form.id)).toBe(true);
  return { store, form, draft };
}

describe("serial rules and numbering", () => {
  it("preserves old definitions and generates nothing during new form preview/preparation", () => {
    const schema = emptySchema();
    schema.fields = [createField("serial", { id: "serial" })];
    expect(prepareSubmission(schema, {}).serial).toBe("");
    const legacy = copy(schema);
    delete legacy.fields[0]!.serial;
    expect(parseSchema(legacy).fields[0]!.serial).toBeUndefined();
    expect(prepareSubmission(parseSchema(legacy), {}).serial).toMatch(/^SN/);
    expect(
      prepareSubmission(parseSchema(legacy), { serial: "旧号" }).serial,
    ).toBe("旧号");
    expect(parseSchema(schema).fields[0]!.serial).toEqual(
      schema.fields[0]!.serial,
    );
  });
  it("combines all four ordered rules, choice labels, zero and post-generation calculations without mutating input", () => {
    const schema = emptySchema(),
      data = seedWorkspace(),
      serial = createField("serial", { id: "serial" });
    serial.serial!.rules = [
      { id: "text", type: "text", value: "JDY-" },
      { id: "date", type: "date", mode: "preset", format: "yyyyMMdd" },
      { id: "c", type: "counter" },
      { id: "f", type: "field", fieldId: "kind" },
      { id: "n", type: "field", fieldId: "zero" },
    ];
    schema.fields = [
      serial,
      createField("select", {
        id: "kind",
        options: [{ id: "a", label: "销售" }],
      }),
      createField("number", { id: "zero" }),
      createField("calculated", {
        id: "length",
        expression: "LEN({{serial}})",
      }),
    ];
    const values = { kind: "a", zero: 0 };
    const result = allocateSerialValues(
      schema,
      values,
      data,
      "f",
      new Date("2026-10-10T17:00:00Z"),
    );
    expect(result.values.serial).toBe("JDY-2026101100001销售0");
    expect(result.values.length).toBe(20);
    expect(data.serialCounters).toBeUndefined();
    expect(values).toEqual({ kind: "a", zero: 0 });
    expect(
      allocateSerialValues(
        schema,
        values,
        { ...data, serialCounters: result.counters },
        "f",
        new Date("2026-10-10T17:00:00Z"),
      ).values.serial,
    ).toContain("00002");
  });
  it("wraps to zero, honors nonfixed widths and Beijing day/month/year boundaries with independent cycle counters", () => {
    const schema = emptySchema(),
      serial = createField("serial", { id: "serial" }),
      data = seedWorkspace();
    schema.fields = [serial];
    Object.assign(serial.serial!, { digits: 2, initial: 99, fixed: false });
    const issue = (time: string) => {
      const result = allocateSerialValues(
        schema,
        {},
        data,
        "f",
        new Date(time),
      );
      data.serialCounters = result.counters;
      return result.values.serial;
    };
    expect(issue("2026-12-31T15:59:59Z")).toBe("99");
    expect(issue("2026-12-31T15:59:59Z")).toBe("0");
    for (const cycle of ["day", "month", "year"] as const) {
      serial.serial!.reset = cycle;
      serial.serial!.initial = 7;
      expect(issue("2026-12-31T15:59:59Z")).toBe("7");
      expect(issue("2026-12-31T15:59:59Z")).toBe("8");
      expect(issue("2026-12-31T16:00:00Z")).toBe("7");
    }
    serial.serial!.reset = "day";
    expect(issue("2026-12-31T16:00:00Z")).toBe("8");
    serial.serial!.reset = "none";
    expect(issue("2026-12-31T16:00:00Z")).toBe("1");
    expect(
      allocateSerialValues(
        schema,
        {},
        data,
        "anotherForm",
        new Date("2027-01-01"),
      ).values.serial,
    ).toBe("7");
  });
  it("supports the ten source date presets and custom formats", () => {
    const time = new Date("2015-01-01T00:00:00+08:00");
    expect(serialDateFormats.map((f) => formatSerialDate(f, time))).toEqual([
      "2015",
      "201501",
      "2015-01",
      "2015/01",
      "20150101",
      "2015-01-01",
      "2015/01/01",
      "0101",
      "01-01",
      "01/01",
    ]);
    expect(formatSerialDate("yy年M月d日", time)).toBe("15年1月1日");
  });
  it("rejects invalid rules, missing or child sources and circular field dependencies at publication", () => {
    const schema = emptySchema(),
      serial = createField("serial", { id: "serial" });
    schema.fields = [serial];
    expect(
      serialSettingsErrors({
        ...serial.serial!,
        digits: 1,
        initial: -1,
        rules: [],
      }),
    ).toHaveLength(3);
    serial.serial!.rules.push({ id: "f", type: "field", fieldId: "name" });
    expect(serialConfigurationErrors(serial, schema)).toContain(
      "流水号引用字段已删除或不支持，请重新选择",
    );
    schema.fields.push(
      createField("text", {
        id: "name",
        defaultFormula: true,
        expression: "{{serial}}",
      }),
    );
    expect(
      validateFieldConfiguration(schema, seedWorkspace()).join(" "),
    ).toMatch(/循环/);
    schema.fields = [
      createField("subform", {
        id: "rows",
        children: [serial, createField("text", { id: "name" })],
      }),
    ];
    expect(serialConfigurationErrors(serial, schema)).toContain(
      "流水号只能添加在主表中",
    );
    expect(() =>
      parseSerialSettings({
        ...serial.serial,
        rules: [
          { id: "x", type: "counter" },
          { id: "x", type: "counter" },
        ],
      }),
    ).toThrow();
  });
  it("does not silently restart corrupt persisted counters", () => {
    for (const raw of [
      [],
      null,
      { f: { s: { none: { period: "all", next: -1 } } } },
      { f: { s: { none: { period: "all", next: 1.5 } } } },
      { f: { s: { day: { period: "all", next: 2 } } } },
      { f: { s: { month: { period: "2026-13", next: 2 } } } },
      JSON.parse('{"__proto__":{}}'),
    ])
      expect(() => parseSerialCounters(raw)).toThrow();
  });
  it("preserves empty and zero historical numbers in their own subform rows", () => {
    const schema = emptySchema(),
      serial = createField("serial", { id: "serial" });
    delete serial.serial;
    schema.fields = [
      createField("subform", { id: "rows", children: [serial] }),
    ];
    expect(
      prepareSubmission(
        schema,
        { rows: [{ serial: "" }, { serial: 0 }] },
        { rows: [{ serial: "旧号一" }, { serial: "旧号二" }] },
      ),
    ).toEqual({ rows: [{ serial: "" }, { serial: 0 }] });
  });
});

describe("serial record transactions", () => {
  it("admin edits can replace or clear a number without changing the counter, and failed edits roll back", async () => {
    const { store, form } = await setup();
    const entry = (await store.submitEntry(form.id, { name: "原记录" }))!;
    const counters = copy(saved().serialCounters);
    expect(
      await store.updateEntry(entry.id, { ...entry.values, serial: "手工-0" }),
    ).toBe(true);
    expect(saved().entries.find((e) => e.id === entry.id)?.values.serial).toBe(
      "手工-0",
    );
    failSave = true;
    expect(
      await store.updateEntry(entry.id, { ...entry.values, serial: "失败值" }),
    ).toBe(false);
    expect(entry.values.serial).toBe("手工-0");
    failSave = false;
    expect(
      await store.updateEntry(entry.id, { ...entry.values, serial: "" }),
    ).toBe(true);
    expect(entry.values.serial).toBe("");
    expect(saved().serialCounters).toEqual(counters);
    expect(
      (await store.submitEntry(form.id, { name: "下一条" }))?.values.serial,
    ).toBe("00002");
    expect(
      saved()
        .forms.find((f) => f.id === form.id)
        ?.published?.schema.fields.find((f) => f.id === "serial")?.editable,
    ).toBe(false);
  });
  it("clearing a historical serial number during record editing does not generate a replacement", async () => {
    const { store, form, draft } = await setup();
    const field = draft.schema.fields.find((f) => f.id === "serial")!;
    delete field.serial;
    field.editable = true;
    expect(await store.publishForm(form.id)).toBe(true);
    const entry = (await store.submitEntry(form.id, { name: "旧规则" }))!;
    expect(String(entry.values.serial)).toMatch(/^SN/);
    expect(
      await store.updateEntry(entry.id, { ...entry.values, serial: "" }),
    ).toBe(true);
    expect(entry.values.serial).toBe("");
    expect(
      await store.updateEntry(entry.id, {
        ...entry.values,
        name: "清空后改名",
      }),
    ).toBe(true);
    expect(entry.values.serial).toBe("");
    expect(saved().serialCounters).toBeUndefined();
  });
  it("member editing grants cannot replace generated numbers, including historical editable serial definitions", async () => {
    const { store, form, draft } = await setup();
    for (const legacy of [false, true]) {
      const field = draft.schema.fields.find((f) => f.id === "serial")!;
      if (legacy) {
        delete field.serial;
        field.editable = true;
      }
      expect(await store.publishForm(form.id)).toBe(true);
      const entry = (await store.submitEntry(form.id, {
          name: `原记录${legacy}`,
        }))!,
        original = copy(entry.values),
        group = newAccessGroup(draft.schema, "manage");
      group.identities = ["li"];
      expect(
        await store.saveFormAccess(form.id, {
          ...defaultAccess(),
          membersEnabled: true,
          groups: [group],
        }),
      ).toBe(true);
      expect(
        await store.memberUpdate(
          entry.id,
          "li",
          group.id,
          { ...entry.values, name: `正常修改${legacy}`, serial: "伪造编号" },
          original,
        ),
      ).toBe(true);
      expect(entry.values.name).toBe(`正常修改${legacy}`);
      expect(entry.values.serial).toBe(original.serial);
    }
  });
  it("keeps start-node field permissions when a workflow uses serial numbering", async () => {
    const store = tab(),
      form = (await store.createForm("oa", "流程流水号", "workflow"))!,
      draft = store.openForm(form.id)!;
    draft.schema.fields = [
      createField("text", { id: "name", required: true }),
      createField("text", { id: "later", label: "后续办理", required: true }),
      createField("serial", { id: "serial" }),
    ];
    draft.workflow.nodes.find(
      (n) => n.data.kind === "start",
    )!.data.permissions.later = "hidden";
    expect(await store.publishForm(form.id)).toBe(true);
    expect(await store.submitEntry(form.id, {})).toBeUndefined();
    expect(saved().serialCounters).toBeUndefined();
    const entry = await store.submitEntry(form.id, { name: "发起" });
    expect(entry?.values.serial).toBe("00001");
    expect(entry?.values.later).toBeUndefined();
    expect(saved().serialCounters?.[form.id]?.serial?.none?.next).toBe(2);
  });
  it("uses the same counter for authorized member creation and rejects unauthorized requests without spending a number", async () => {
    const { store, form, draft } = await setup(),
      group = newAccessGroup(draft.schema);
    group.identities = ["li"];
    group.actions = ["create"];
    expect(
      await store.saveFormAccess(form.id, {
        ...defaultAccess(),
        membersEnabled: true,
        groups: [group],
      }),
    ).toBe(true);
    expect(
      await store.memberSubmit(form.id, "wang", group.id, { name: "无权限" }),
    ).toBeUndefined();
    const member = await store.memberSubmit(form.id, "li", group.id, {
      name: "成员",
      serial: "伪造",
    });
    expect(member?.values.serial).toBe("00001");
    expect(member?.createdBy).toBe("li");
    expect(
      (await store.submitEntry(form.id, { name: "管理员" }))?.values.serial,
    ).toBe("00002");
  });
  it("validates member-scoped department choices using the submitting member", async () => {
    const { store, form, draft } = await setup(),
      department = createField("department", {
        id: "department",
        required: true,
      });
    department.organization.scope.mode = "currentDepartment";
    department.organization.defaultMode = "currentDepartment";
    draft.schema.fields.push(department);
    expect(await store.publishForm(form.id)).toBe(true);
    const group = newAccessGroup(draft.schema);
    group.identities = ["wang"];
    group.actions = ["create"];
    expect(
      await store.saveFormAccess(form.id, {
        ...defaultAccess(),
        membersEnabled: true,
        groups: [group],
      }),
    ).toBe(true);
    const entry = await store.memberSubmit(form.id, "wang", group.id, {
      name: "研发部提交",
    });
    expect(entry?.values.department).toBe("engineering");
    expect(entry?.values.serial).toBe("00001");
  });
  it("serializes simultaneous submissions from independent pages and reloads the next number", async () => {
    const { form } = await setup(),
      a = tab(),
      b = tab();
    const [one, two] = await Promise.all([
      a.submitEntry(form.id, { name: "A", serial: "伪造编号" }),
      b.submitEntry(form.id, { name: "B" }),
    ]);
    expect([one?.values.serial, two?.values.serial]).toEqual([
      "00001",
      "00002",
    ]);
    expect(
      (await tab().submitEntry(form.id, { name: "C" }))?.values.serial,
    ).toBe("00003");
    expect(saved().serialCounters?.[form.id]?.serial?.none?.next).toBe(4);
  });
  it("does not spend numbers on drafts, duplicate validation, failed saves or ordinary record edits", async () => {
    const { store, form } = await setup();
    const draft = (await store.submitEntry(
      form.id,
      { name: "A", serial: "伪造" },
      "draft",
    ))!;
    expect(draft.values.serial).toBe("");
    expect(saved().serialCounters).toBeUndefined();
    const first = (await store.submitEntry(
      form.id,
      { name: "A" },
      "submitted",
      draft.id,
    ))!;
    expect(first.id).toBe(draft.id);
    expect(first.values.serial).toBe("00001");
    expect(await store.submitEntry(form.id, { name: "A" })).toBeUndefined();
    expect(await store.submitEntry(form.id, { name: "" })).toBeUndefined();
    failSave = true;
    expect(await store.submitEntry(form.id, { name: "B" })).toBeUndefined();
    expect(store.data.serialCounters?.[form.id]?.serial?.none?.next).toBe(2);
    failSave = false;
    const second = (await store.submitEntry(form.id, { name: "B" }))!;
    expect(second.values.serial).toBe("00002");
    expect(await store.updateEntry(second.id, { name: "改名" })).toBe(true);
    expect(saved().entries.find((e) => e.id === second.id)?.values.serial).toBe(
      "00002",
    );
    expect(saved().serialCounters?.[form.id]?.serial?.none?.next).toBe(3);
  });
  it("keeps historical numbers and versions when republishing, copying a form or explicitly resetting", async () => {
    const { store, form, draft } = await setup(),
      first = (await store.submitEntry(form.id, { name: "A" }))!;
    draft.schema.fields[1]!.serial!.rules.unshift({
      id: "prefix",
      type: "text",
      value: "新-",
    });
    expect(await store.publishForm(form.id)).toBe(true);
    expect(
      (await store.submitEntry(form.id, { name: "B" }))?.values.serial,
    ).toBe("新-00002");
    expect(saved().entries.find((e) => e.id === first.id)?.values.serial).toBe(
      "00001",
    );
    expect(
      saved().forms.find((f) => f.id === form.id)!.versions[0]!.schema
        .fields[1]!.serial!.rules,
    ).toHaveLength(1);
    const copied = (await store.duplicateForm(form.id))!;
    expect(await store.publishForm(copied.id)).toBe(true);
    expect(
      (await store.submitEntry(copied.id, { name: "C" }))?.values.serial,
    ).toBe("新-00001");
    failSave = true;
    expect(await store.resetSerialCounter(form.id, "serial")).toBe(false);
    failSave = false;
    expect(saved().serialCounters?.[form.id]?.serial?.none?.next).toBe(3);
    expect(await store.resetSerialCounter(form.id, "serial")).toBe(true);
    expect(
      (await store.submitEntry(form.id, { name: "D" }))?.values.serial,
    ).toBe("新-00001");
    expect(saved().entries.find((e) => e.id === first.id)?.values.serial).toBe(
      "00001",
    );
  });
  it("trials and failed automation groups preserve counters; successful events commit all generated numbers", async () => {
    const { store, form } = await setup();
    const source = store.openForm(
      (await store.createForm("oa", "来源", "form"))!.id,
    )!;
    source.schema.fields = [createField("text", { id: "source" })];
    const config = newAutomation();
    config.name = "流水号目标";
    config.events = ["data_create"];
    Object.assign(config.steps[0]!, {
      targetFormId: form.id,
      targetVersion: 1,
      mappings: [
        { targetId: "name", source: "constant", value: "助手A", fieldId: "" },
      ],
    });
    const second = newAutomationStep();
    Object.assign(second, {
      targetFormId: form.id,
      targetVersion: 1,
      mappings: [
        { targetId: "name", source: "constant", value: "助手B", fieldId: "" },
      ],
    });
    config.steps.push(second);
    const trial = prepareAutomation(
      config,
      source.schema,
      {},
      "data_create",
      store.data,
      { trial: true },
    );
    expect(trial.run.status).toBe("success");
    expect(trial.entries.map((e) => e.values.serial)).toEqual([
      "00002",
      "00001",
    ]);
    expect(store.data.serialCounters).toBeUndefined();
    second.mappings[0]!.value = "助手A";
    expect(
      prepareAutomation(config, source.schema, {}, "data_create", store.data, {
        trial: true,
      }).run.status,
    ).toBe("failed");
    expect(store.data.serialCounters).toBeUndefined();
    second.mappings[0]!.value = "助手B";
    expect(await store.saveAutomation(source.id, config)).toBe(true);
    expect(await store.publishForm(source.id)).toBe(true);
    const other = copy(config);
    other.id = "another";
    other.steps = [copy(config.steps[0]!)];
    other.steps[0]!.mappings[0]!.value = "助手C";
    expect(await store.saveAutomation(source.id, other)).toBe(true);
    expect(await store.publishForm(source.id)).toBe(true);
    expect(await store.submitEntry(source.id, {})).toBeTruthy();
    expect(
      Object.fromEntries(
        saved()
          .entries.filter((e) => e.formId === form.id)
          .map((e) => [e.values.name, e.values.serial]),
      ),
    ).toEqual({ 助手A: "00001", 助手B: "00002", 助手C: "00003" });
    expect(saved().serialCounters?.[form.id]?.serial?.none?.next).toBe(4);
  });
});
