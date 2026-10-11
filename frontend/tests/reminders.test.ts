import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createField, copy } from "../src/domain/form";
import {
  newReminder,
  parseReminders,
  reminderDueAt,
  reminderIssues,
  reminderRecipients,
  renderReminderText,
  runReminder,
} from "../src/domain/reminders";
import {
  parseExtensions,
  fieldExtensionImpacts,
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
async function setup(trigger: "event" | "date" = "event") {
  const store = useWorkspaceStore(),
    created = (await store.createForm("oa", "提醒验收", "form"))!,
    form = store.openForm(created.id)!;
  form.schema.fields = [
    createField("text", { id: "name", label: "合同名称" }),
    createField("datetime", { id: "date", label: "到期日" }),
    createField("members", { id: "owner", label: "负责人" }),
    createField("number", { id: "amount", label: "金额" }),
    createField("select", {
      id: "state",
      label: "状态",
      options: [{ id: "opt", label: "待处理" }],
    }),
  ];
  const config = newReminder();
  Object.assign(config, {
    name: "到期提醒",
    trigger,
    dateFieldId: "date",
    title: "请处理 {{name}}",
    message: "{{owner}}：{{state}}，金额 {{amount}}",
    enabled: true,
    events: ["data_create", "data_update"],
  });
  config.recipients.ids = ["zhang", "product", "role_admin"];
  expect(await store.saveReminder(form.id, config)).toBe(true);
  expect(await store.publishForm(form.id)).toBe(true);
  const values = {
    name: "合同 A",
    date: "2026-10-08",
    owner: ["zhang"],
    amount: 0,
    state: "opt",
  };
  return { store, form, config, values };
}
describe("reminders and published event delivery", () => {
  it("migrates absent settings, rejects duplicate IDs and retains reminders in published schemas", async () => {
    expect(parseExtensions(undefined)).toEqual({ webhooks: [] });
    const { store, form, config } = await setup();
    expect(() => parseReminders([config, config])).toThrow("重复");
    expect(
      parseReminders([{ ...config, offsetDays: null }])[0]!.offsetDays,
    ).toBe(366);
    const restored = parseWorkspace(JSON.stringify(store.data));
    expect(
      restored.forms.find((f) => f.id === form.id)!.published!.extensions!
        .reminders,
    ).toEqual([config]);
  });
  it("deduplicates fixed users, departments and roles, excluding inactive and archived scopes", async () => {
    const { store, config, values } = await setup();
    expect(
      reminderRecipients(config, values, store.data).map((e) => e.id),
    ).toEqual(["zhang", "li"]);
    store.data.organization.employees.find((e) => e.id === "li")!.status =
      "inactive";
    expect(
      reminderRecipients(config, values, store.data).map((e) => e.id),
    ).toEqual(["zhang"]);
    config.recipients = { source: "field", ids: [], fieldId: "owner" };
    expect(
      reminderRecipients(
        config,
        { owner: ["wang", "wang", "missing"] },
        store.data,
      ).map((e) => e.id),
    ).toEqual(["wang"]);
    config.recipients = { source: "fixed", ids: ["product"], fieldId: "" };
    store.data.organization.departments.find(
      (d) => d.id === "product",
    )!.archived = true;
    expect(reminderRecipients(config, values, store.data)).toEqual([]);
  });
  it("renders choice labels, names and zero from stable IDs and reports removed or row-scoped fields", async () => {
    const { store, config, form, values } = await setup();
    expect(
      renderReminderText(config.message, form.schema, values, store.data),
    ).toBe("张三：待处理，金额 0");
    form.schema.fields[0]!.label = "新名称";
    expect(
      renderReminderText(config.title, form.schema, values, store.data),
    ).toBe("请处理 合同 A");
    expect(fieldExtensionImpacts(form, ["owner"])).toEqual([
      "提醒「到期提醒」的触发条件、接收人或消息内容",
    ]);
    config.message = "{{child}}";
    const sub = createField("subform");
    sub.children = [createField("text", { id: "child" })];
    form.schema.fields.push(sub);
    expect(
      reminderIssues(config, form.schema).some(
        (e) => e.target === "reminder-message",
      ),
    ).toBe(true);
    config.message = "{{broken";
    expect(reminderIssues(config, form.schema)[0]!.message).toContain(
      "占位符不完整",
    );
  });
  it("validates real calendar dates and computes offset across month boundaries in local time", async () => {
    const { config } = await setup("date");
    config.offsetDays = -3;
    const date = reminderDueAt(config, { date: "2026-03-01T23:45" })!;
    expect([
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
    ]).toEqual([1, 26, 9, 0]);
    expect(reminderDueAt(config, { date: "2026-02-30" })).toBeUndefined();
    expect(reminderDueAt(config, { date: "" })).toBeUndefined();
    config.time = "24:00";
    expect(reminderDueAt(config, { date: "2026-03-01" })).toBeUndefined();
  });
  it("skips unmatched events, conditions and future dates, and distinguishes empty recipients from channel failure", async () => {
    const { store, form, config, values } = await setup();
    expect(
      runReminder(config, form.schema, values, store.data, {
        event: "data_remove",
      }).status,
    ).toBe("skipped");
    config.filters = [
      {
        id: "f",
        sourceFieldId: "amount",
        operator: "greater",
        source: "constant",
        value: "10",
      },
    ];
    expect(
      runReminder(config, form.schema, values, store.data, {
        event: "data_create",
      }).status,
    ).toBe("skipped");
    config.filters = [];
    config.recipients.ids = ["missing"];
    expect(
      runReminder(config, form.schema, values, store.data, {
        event: "data_create",
      }).error!.target,
    ).toBe("reminder-recipients");
    config.recipients.ids = ["zhang"];
    expect(
      runReminder(config, form.schema, values, store.data, {
        event: "data_create",
        forceFailure: true,
      }).error!.target,
    ).toBe("reminder-scenario");
    config.trigger = "date";
    const checked = runReminder(config, form.schema, values, store.data, {
      now: new Date(2026, 9, 8, 10),
    });
    expect(checked.input.checkedAt).toBe(
      new Date(2026, 9, 8, 10).toISOString(),
    );
    expect(
      runReminder(config, form.schema, values, store.data, {
        now: new Date("invalid"),
      }).error?.message,
    ).toBe("检查时间无效");
    expect(
      runReminder(config, form.schema, values, store.data, {
        now: new Date(2026, 9, 7),
      }).status,
    ).toBe("skipped");
  });
  it("runs event reminders with the original published config and atomically rolls back failed record persistence", async () => {
    const { store, form, config, values } = await setup();
    const entry = (await store.submitEntry(form.id, values))!;
    expect(store.data.extensionRuns![0]!.input.message).toBe(
      "张三：待处理，金额 0",
    );
    config.message = "新版消息";
    await store.saveReminder(form.id, config);
    await store.publishForm(form.id);
    expect(await store.updateEntry(entry.id, { ...values, amount: 5 })).toBe(
      true,
    );
    expect(store.data.extensionRuns![0]!.input.message).toBe(
      "张三：待处理，金额 5",
    );
    const before = copy(store.data);
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
      throw Error("disk full");
    });
    expect(await store.updateEntry(entry.id, { ...values, amount: 6 })).toBe(
      false,
    );
    expect(store.data).toEqual(before);
  });
  it("persists date receipts independently of capped logs and excludes drafts/recycled records", async () => {
    const { store, form, values } = await setup("date");
    const entry = (await store.submitEntry(form.id, values))!;
    const deleted = (await store.submitEntry(form.id, values))!;
    await store.recycleEntries([deleted.id], true);
    await store.submitEntry(form.id, values, "draft");
    const now = new Date(2026, 9, 8, 10);
    expect((await store.checkDueReminders(form.id, now))!.success).toBe(1);
    expect(entry.reminderReceipts).toHaveLength(1);
    expect(store.data.extensionRuns![0]!.origin).toBe("schedule");
    store.data.extensionRuns = [];
    await store.persist();
    const reloaded = new LocalWorkspaceRepository().load()!;
    expect(
      reloaded.entries.find((e) => e.id === entry.id)!.reminderReceipts,
    ).toHaveLength(1);
    setActivePinia(createPinia());
    const next = useWorkspaceStore();
    expect(await next.checkDueReminders(form.id, now)).toMatchObject({
      success: 0,
      already: 1,
    });
    await next.updateEntry(entry.id, { ...values, date: "2026-10-09" });
    expect((await next.checkDueReminders(form.id, now))!.future).toBe(1);
    expect(
      (await next.checkDueReminders(form.id, new Date(2026, 9, 9, 10)))!
        .success,
    ).toBe(1);
  });
  it("keeps skipped records eligible and rolls back both receipts and logs when storage fails", async () => {
    const { store, form, config, values } = await setup("date");
    config.filters = [
      {
        id: "f",
        sourceFieldId: "amount",
        operator: "greater",
        source: "constant",
        value: "10",
      },
    ];
    await store.saveReminder(form.id, config);
    await store.publishForm(form.id);
    const entry = (await store.submitEntry(form.id, values))!,
      now = new Date(2026, 9, 8, 10);
    expect((await store.checkDueReminders(form.id, now))!.skipped).toBe(1);
    expect(entry.reminderReceipts).toBeUndefined();
    await store.updateEntry(entry.id, { ...values, amount: 20 });
    const before = copy(store.data);
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
      throw Error("disk full");
    });
    expect(await store.checkDueReminders(form.id, now)).toBeUndefined();
    expect(store.data).toEqual(before);
    expect((await store.checkDueReminders(form.id, now))!.success).toBe(1);
  });
  it("retains old-version date rules, publishes deactivation only for new records, and copies reminders disabled", async () => {
    const { store, form, config, values } = await setup("date");
    const entry = (await store.submitEntry(form.id, values))!;
    config.enabled = false;
    await store.saveReminder(form.id, config);
    await store.publishForm(form.id);
    await store.submitEntry(form.id, values);
    expect(
      (await store.checkDueReminders(form.id, new Date(2026, 9, 8, 10)))!
        .success,
    ).toBe(1);
    expect(store.data.extensionRuns![0]!.entryId).toBe(entry.id);
    const duplicate = (await store.duplicateForm(form.id))!;
    expect(duplicate.extensions!.reminders![0]!.id).not.toBe(config.id);
    expect(duplicate.extensions!.reminders![0]!.enabled).toBe(false);
    expect(duplicate.versions).toEqual([]);
  });
  it("blocks publication after referenced field removal and restores a failed config save", async () => {
    const { store, form, config } = await setup();
    const before = copy(form.extensions);
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
      throw Error("disk full");
    });
    expect(
      await store.saveReminder(form.id, { ...config, name: "新提醒" }),
    ).toBe(false);
    expect(form.extensions).toEqual(before);
    form.schema.fields = form.schema.fields.filter((f) => f.id !== "owner");
    expect(await store.publishForm(form.id)).toBe(false);
    expect(form.published!.version).toBe(1);
  });
});
