import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspaceStore } from "../src/stores/workspace";
import { createField, copy } from "../src/domain/form";
import { newWebhook } from "../src/domain/extensions";
import { sourceEntries } from "../src/domain/relations";
import { defaultRecordView, filterAndSortRecords } from "../src/domain/records";
import { LocalWorkspaceRepository } from "../src/repositories/workspaceRepository";

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
    created = (await store.createForm("oa", "记录测试", "form"))!,
    form = store.openForm(created.id)!;
  form.schema.fields = [
    createField("text", {
      id: "code",
      label: "编号",
      required: true,
      unique: true,
    }),
    createField("number", { id: "quantity", label: "数量", min: 0 }),
    createField("select", {
      id: "choice",
      label: "类别",
      options: [{ id: "opt", label: "办公用品" }],
    }),
  ];
  const credential = (await store.createWebhookCredential())!,
    config = newWebhook();
  Object.assign(config, {
    name: "事件测试",
    url: "https://example.com/hooks",
    credentialRef: credential.id,
    events: ["data_create", "data_update", "data_remove", "data_recover"],
    fieldIds: ["code", "quantity"],
    enabled: true,
  });
  await store.saveWebhook(form.id, config);
  await store.publishForm(form.id);
  const a = (await store.submitEntry(form.id, {
      code: "A",
      quantity: 2,
      choice: "opt",
    }))!,
    b = (await store.submitEntry(form.id, { code: "B", quantity: 10 }))!;
  return { store, form, a, b };
}
describe("record operations", () => {
  it("updates using the historical schema and emits a data_update without restarting the flow", async () => {
    const { store, form, a } = await setup();
    const version = a.definitionVersion,
      current = a.currentNodeId;
    form.schema.fields.push(
      createField("text", { id: "newRequired", required: true }),
    );
    await store.publishForm(form.id);
    expect(await store.updateEntry(a.id, { ...a.values, quantity: 99 })).toBe(
      true,
    );
    expect(a.definitionVersion).toBe(version);
    expect(a.currentNodeId).toBe(current);
    expect(a.values.quantity).toBe(99);
    expect(store.data.extensionRuns![0]!.event).toBe("data_update");
    expect(store.data.extensionRuns![0]!.snapshot.values.quantity).toBe(99);
    expect(a.history.at(-1)!.action).toBe("修改记录");
  });
  it("rejects invalid edits and uniqueness collisions without changing entries or logs", async () => {
    const { store, a } = await setup(),
      before = copy(a),
      runs = copy(store.data.extensionRuns);
    expect(await store.updateEntry(a.id, { code: "B", quantity: 2 })).toBe(
      false,
    );
    expect(await store.updateEntry(a.id, { code: "", quantity: -1 })).toBe(
      false,
    );
    expect(a).toEqual(before);
    expect(store.data.extensionRuns).toEqual(runs);
  });
  it("recycles and restores records atomically, excluding them from relation candidates", async () => {
    const { store, form, a, b } = await setup();
    expect(await store.recycleEntries([a.id, b.id], true)).toBe(true);
    expect(sourceEntries(store.data, form.id)).toEqual([]);
    expect(await store.updateEntry(a.id, { code: "C" })).toBe(false);
    expect(await store.processEntry(a.id, "approved")).toBe(false);
    const removed = store.data.extensionRuns!.filter(
      (r) => r.event === "data_remove",
    );
    expect(removed).toHaveLength(2);
    expect(removed.map((r) => r.entryId).sort()).toEqual([a.id, b.id].sort());
    for (const run of removed)
      expect((run.input as any).body.data).toEqual({ _id: run.entryId });
    expect(await store.recycleEntries([a.id, b.id], false)).toBe(true);
    expect(sourceEntries(store.data, form.id)).toHaveLength(2);
    expect(
      store.data.extensionRuns!.filter((r) => r.event === "data_recover"),
    ).toHaveLength(2);
    expect(a.history.at(-1)!.action).toBe("恢复记录");
  });
  it("blocks a conflicting restore and rejects stale batch selections with no partial effects", async () => {
    const { store, form, a, b } = await setup();
    await store.recycleEntries([a.id], true);
    await store.submitEntry(form.id, { code: "A", quantity: 7 });
    const before = copy(store.data.entries),
      logs = copy(store.data.extensionRuns);
    expect(await store.recycleEntries([a.id], false)).toBe(false);
    expect(await store.recycleEntries([b.id, "missing"], true)).toBe(false);
    expect(store.data.entries).toEqual(before);
    expect(store.data.extensionRuns).toEqual(logs);
  });
  it("does not emit published data events for recycled drafts and preserves status on restore", async () => {
    const { store, form } = await setup(),
      draft = (await store.submitEntry(form.id, {}, "draft"))!,
      runs = copy(store.data.extensionRuns);
    expect(await store.recycleEntries([draft.id], true)).toBe(true);
    expect(await store.recycleEntries([draft.id], false)).toBe(true);
    expect(draft.status).toBe("draft");
    expect(store.data.extensionRuns).toEqual(runs);
  });
  it("rolls back edited values, recycle flags, history and event logs on storage failure", async () => {
    const { store, a, b } = await setup(),
      before = copy(store.data.entries),
      logs = copy(store.data.extensionRuns);
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw Error("quota");
    });
    expect(await store.updateEntry(a.id, { ...a.values, quantity: 3 })).toBe(
      false,
    );
    expect(await store.recycleEntries([a.id, b.id], true)).toBe(false);
    expect(store.data.entries).toEqual(before);
    expect(store.data.extensionRuns).toEqual(logs);
  });
  it("searches display labels and sorts numeric values correctly, with immutable filters", async () => {
    const { store, form, a, b } = await setup(),
      all = [a, b],
      before = copy(all);
    const view = {
      ...defaultRecordView(form.schema),
      sortField: "quantity",
      descending: false,
    };
    expect(
      filterAndSortRecords(all, form.schema, store.data, {
        query: "办公用品",
        filters: [],
        view,
      }).map((e) => e.id),
    ).toEqual([a.id]);
    expect(
      filterAndSortRecords(all, form.schema, store.data, {
        query: "",
        filters: [],
        view,
      }).map((e) => e.id),
    ).toEqual([a.id, b.id]);
    expect(
      filterAndSortRecords(all, form.schema, store.data, {
        query: "",
        filters: [
          {
            id: "n",
            sourceFieldId: "quantity",
            source: "constant",
            operator: "greater",
            value: "5",
          },
        ],
        view,
      }).map((e) => e.id),
    ).toEqual([b.id]);
    expect(all).toEqual(before);
  });
  it("persists recycled records and per-form list settings and rolls back failed view saves", async () => {
    const { store, form, a } = await setup();
    await store.recycleEntries([a.id], true);
    const view = {
      ...defaultRecordView(form.schema),
      fieldIds: ["quantity", "code"],
      pageSize: 10 as const,
    };
    expect(await store.saveRecordView(form.id, view)).toBe(true);
    const loaded = new LocalWorkspaceRepository().load()!;
    expect(loaded.entries.find((e) => e.id === a.id)!.deletedAt).toBeTruthy();
    expect(loaded.recordViews![form.id]).toEqual(view);
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw Error("quota");
    });
    expect(await store.saveRecordView(form.id, { ...view, pageSize: 50 })).toBe(
      false,
    );
    expect(store.data.recordViews![form.id]).toEqual(view);
  });
});
