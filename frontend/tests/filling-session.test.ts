import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createField, copy } from "../src/domain/form";
import { fillingSession } from "../src/domain/fillingSession";
import { contextFingerprint } from "../src/domain/editorDrafts";
import { useWorkspaceStore } from "../src/stores/workspace";
import { LocalWorkspaceRepository } from "../src/repositories/workspaceRepository";
import { migrateLegacyFillCache } from "../src/repositories/legacyFillCache";

let memory: Map<string, string>, storage: any;
beforeEach(() => {
  memory = new Map();
  storage = {
    getItem: vi.fn((k) => memory.get(k) ?? null),
    setItem: vi.fn((k, v) => memory.set(k, v)),
    removeItem: vi.fn((k) => memory.delete(k)),
  };
  vi.stubGlobal("localStorage", storage);
  setActivePinia(createPinia());
});
async function fixture() {
  const store = useWorkspaceStore();
  const created = (await store.createForm("oa", "Draft lifecycle", "form"))!;
  const form = store.openForm(created.id)!;
  form.schema.fields = [createField("text", { id: "name", label: "V1 Name" })];
  await store.publishForm(form.id);
  const draft = (await store.submitEntry(
    form.id,
    { name: "Original" },
    "draft",
  ))!;
  return { store, form, draft, actor: store.data.organization.currentUserId };
}
describe("saved filling draft lifecycle", () => {
  it("continues the original publication after V2 and submits exactly one record after reload", async () => {
    const { store, form, draft, actor } = await fixture();
    form.schema.fields.push(
      createField("number", { id: "v2", required: true }),
    );
    await store.publishForm(form.id);
    const fresh = useWorkspaceStore(createPinia());
    expect(
      fillingSession(fresh.data, form.id, draft.id, actor).definition?.schema,
    ).toEqual(
      fillingSession(store.data, form.id, draft.id, actor).definition?.schema,
    );
    expect(
      contextFingerprint(
        JSON.stringify(
          fillingSession(fresh.data, form.id, draft.id, actor).definition
            ?.schema,
        ),
      ),
    ).toBe(
      contextFingerprint(
        JSON.stringify(
          fillingSession(store.data, form.id, draft.id, actor).definition
            ?.schema,
        ),
      ),
    );
    expect(
      fillingSession(fresh.data, form.id, draft.id, actor).definition?.version,
    ).toBe(1);
    expect(
      fillingSession(fresh.data, form.id, undefined, actor).definition?.version,
    ).toBe(2);
    const saved = (await fresh.submitEntry(
      form.id,
      { name: "Changed" },
      "draft",
      draft.id,
    ))!;
    expect(saved.id).toBe(draft.id);
    expect(saved.createdAt).toBe(draft.createdAt);
    expect(saved.history).toHaveLength(2);
    const result = (await fresh.submitEntry(
      form.id,
      saved.values,
      "submitted",
      draft.id,
    ))!;
    expect(result.definitionVersion).toBe(1);
    expect(result.history.at(-1)?.action).toBe("提交数据");
    expect(result.history.at(-1)?.label).toBe("填写表单");
    expect(result.history).toHaveLength(3);
    const persisted = new LocalWorkspaceRepository(storage).load()!;
    expect(persisted.entries.filter((e) => e.formId === form.id)).toHaveLength(
      1,
    );
    expect(persisted.entries.find((e) => e.id === draft.id)?.status).toBe(
      "submitted",
    );
    expect(
      await fresh.submitEntry(
        form.id,
        { name: "Duplicate" },
        "submitted",
        draft.id,
      ),
    ).toBeUndefined();
    expect(fresh.data.entries.filter((e) => e.formId === form.id)).toHaveLength(
      1,
    );
  });
  it("refuses missing, deleted, foreign-owner and missing-version drafts without creating new records", async () => {
    const { store, form, draft, actor } = await fixture();
    const before = copy(store.data.entries);
    expect(
      fillingSession(store.data, form.id, draft.id, "someone-else").issue,
    ).toContain("自己");
    expect(
      await store.submitEntry(form.id, {}, "submitted", "missing"),
    ).toBeUndefined();
    expect(
      await store.submitEntry(
        form.id,
        {},
        "submitted",
        draft.id,
        "someone-else",
      ),
    ).toBeUndefined();
    expect(store.data.entries).toEqual(before);
    const entry = store.data.entries.find((e) => e.id === draft.id)!;
    entry.deletedAt = new Date().toISOString();
    expect(
      fillingSession(store.data, form.id, draft.id, actor).issue,
    ).toContain("不存在");
    entry.deletedAt = undefined;
    entry.definitionVersion = 999;
    expect(
      await store.submitEntry(form.id, {}, "draft", draft.id),
    ).toBeUndefined();
    expect(store.data.entries.filter((e) => e.formId === form.id)).toHaveLength(
      1,
    );
  });
  it("retains the original draft and history when submission persistence fails", async () => {
    const { store, form, draft } = await fixture();
    const before = copy(store.data.entries);
    storage.setItem.mockImplementation(() => {
      throw Error("quota");
    });
    expect(
      await store.submitEntry(
        form.id,
        { name: "Changed" },
        "submitted",
        draft.id,
      ),
    ).toBeUndefined();
    expect(store.data.entries).toEqual(before);
  });
});

describe("legacy filling cache migration", () => {
  it("removes old data only after successful durable retention", () => {
    memory.set("fill", '{"name":"old"}');
    expect(migrateLegacyFillCache("fill", () => false, storage)).toContain(
      "保留",
    );
    expect(memory.has("fill")).toBe(true);
    const retain = vi.fn(() => true);
    expect(migrateLegacyFillCache("fill", retain, storage)).toBe("");
    expect(retain).toHaveBeenCalledWith({ name: "old" });
    expect(memory.has("fill")).toBe(false);
  });
  it("preserves unreadable or unsafe old data and data that changes during migration", () => {
    for (const raw of [
      "damaged",
      '{"__proto__":{}}',
      '"' + "x".repeat(1_000_001) + '"',
    ]) {
      memory.set("fill", raw);
      const retain = vi.fn(() => true);
      expect(migrateLegacyFillCache("fill", retain, storage)).toContain("保留");
      expect(retain).not.toHaveBeenCalled();
      expect(memory.get("fill")).toBe(raw);
    }
    memory.set("fill", '{"name":"old"}');
    migrateLegacyFillCache(
      "fill",
      () => {
        memory.set("fill", '{"name":"new"}');
        return true;
      },
      storage,
    );
    expect(memory.get("fill")).toBe('{"name":"new"}');
  });
});
