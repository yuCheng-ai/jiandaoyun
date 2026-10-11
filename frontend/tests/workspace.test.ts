import { beforeEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createField, copy } from "../src/domain/form";
import { initialDocument, makeNode, makeEdge } from "../src/domain/workflow";
import { newForm, advanceEntry, type FormEntry } from "../src/domain/workspace";
import { useWorkspaceStore, syncFormWorkflow } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  parseWorkspace,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";
let memory: Map<string, string>;
let storage: {
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
describe("workspace integration", () => {
  it("retains node permissions after field rename and removes deleted field permissions", () => {
    const form = newForm("app", "Form");
    const field = createField("text");
    form.schema.fields = [field];
    syncFormWorkflow(form);
    form.workflow.nodes[1]!.data.permissions[field.id] = "read";
    field.label = "New label";
    syncFormWorkflow(form);
    expect(form.workflow.nodes[1]!.data.permissions[field.id]).toBe("read");
    form.schema.fields = [];
    syncFormWorkflow(form);
    expect(form.workflow.nodes[1]!.data.permissions).toEqual({});
  });
  it("separates drafts, saved designs and immutable publication history across reloads", async () => {
    const store = useWorkspaceStore();
    const created = (await store.createForm("oa", "Version test", "form"))!;
    const draft = store.openForm(created.id)!;
    draft.schema.fields = [createField("number", { defaultValue: 123 })];
    expect(await store.publishForm(created.id)).toBe(true);
    draft.schema.fields[0]!.label = "Renamed";
    expect(
      store.data.forms.find((f) => f.id === created.id)!.published!.schema
        .fields[0]!.label,
    ).toBe("数字");
    await store.publishForm(created.id);
    const reloaded = new LocalWorkspaceRepository(storage as any).load()!;
    const f = reloaded.forms.find((f) => f.id === created.id)!;
    expect(f.versions.map((v) => v.schema.fields[0]!.label)).toEqual([
      "数字",
      "Renamed",
    ]);
    expect(f.schema.fields[0]!.defaultValue).toBe(123);
  });
  it("does not falsely publish or submit when local persistence fails", async () => {
    const store = useWorkspaceStore();
    const draft = store.openForm("employee")!;
    await store.publishForm("employee");
    const old = copy(draft.published);
    storage.setItem.mockImplementation(() => {
      throw Error("quota");
    });
    expect(await store.publishForm("employee")).toBe(false);
    expect(draft.published).toEqual(old);
    expect(draft.versions).toHaveLength(1);
    expect(
      await store.submitEntry("employee", {
        [draft.schema.fields[0]!.id]: "合成姓名",
        [draft.schema.fields[1]!.id]: "13900000001",
      }),
    ).toBeUndefined();
    expect(store.data.entries).toHaveLength(0);
  });
  it("resumes a saved draft using the same entry instead of creating duplicates", async () => {
    const store = useWorkspaceStore();
    await store.publishForm("employee");
    const fields = store.data.forms.find((form) => form.id === "employee")!
      .published!.schema.fields;
    const draft = (await store.submitEntry(
      "employee",
      { [fields[0]!.id]: "A" },
      "draft",
    ))!;
    const submitted = (await store.submitEntry(
      "employee",
      { [fields[0]!.id]: "B", [fields[1]!.id]: "13900000001" },
      "submitted",
      draft.id,
    ))!;
    expect(submitted.id).toBe(draft.id);
    expect(store.data.entries).toHaveLength(1);
    expect(submitted.status).toBe("submitted");
  });
  it("restores archived forms and copies a form without published history", async () => {
    const store = useWorkspaceStore();
    await store.publishForm("employee");
    const duplicate = (await store.duplicateForm("employee"))!;
    expect(duplicate.published).toBeUndefined();
    expect(duplicate.versions).toEqual([]);
    await store.archiveForm(duplicate.id);
    expect(
      store.activeForms.find((f) => f.id === duplicate.id),
    ).toBeUndefined();
    await store.archiveForm(duplicate.id, false);
    expect(store.activeForms.find((f) => f.id === duplicate.id)).toBeDefined();
  });
  it("keeps corrupt stored data intact and blocks accidental replacement", async () => {
    memory.set(WORKSPACE_KEY, "broken");
    const store = useWorkspaceStore();
    expect(store.storageError).toBeTruthy();
    expect(await store.saveForm("employee")).toBe(false);
    expect(memory.get(WORKSPACE_KEY)).toBe("broken");
  });
  it("validates old publication versions too", async () => {
    const store = useWorkspaceStore();
    await store.publishForm("employee");
    const raw = copy(store.data);
    raw.forms.find((f) => f.id === "employee")!.versions[0]!.schema.version =
      7 as any;
    expect(() => parseWorkspace(JSON.stringify(raw))).toThrow();
  });
  it("runs conditional local approval through the selected field and skips copy nodes", () => {
    const flow = initialDocument();
    const condition = makeNode("condition", "condition", 0, 0);
    condition.data.conditionFieldId = "budget";
    const c = makeNode("cc", "copy", 0, 0);
    flow.nodes.splice(1, 0, condition, c);
    flow.edges = [
      makeEdge("start", "condition"),
      makeEdge("condition", "1"),
      makeEdge("condition", "end"),
      makeEdge("1", "cc"),
      makeEdge("cc", "end"),
    ];
    const entry: FormEntry = {
      id: "e",
      formId: "f",
      values: { budget: 7000 },
      definitionVersion: 1,
      status: "submitted",
      createdAt: "now",
      history: [],
    };
    advanceEntry(entry, flow, "start");
    expect(entry.currentNodeId).toBe("1");
    advanceEntry(entry, flow, "approved");
    expect(entry.status).toBe("approved");
    expect(entry.history.some((h) => h.label === "抄送节点")).toBe(true);
    const low = {
      ...entry,
      values: { budget: 100 },
      history: [],
      status: "submitted",
    } as FormEntry;
    advanceEntry(low, flow, "start");
    expect(low.status).toBe("approved");
  });
});
