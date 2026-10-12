import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy } from "../src/domain/form";
import { seedWorkspace } from "../src/domain/workspace";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";
import {
  WORKSPACE_WRITE_LOCK,
  withWorkspaceWriteLock,
} from "../src/repositories/workspaceWriteLock";
import { useWorkspaceStore } from "../src/stores/workspace";

let memory: Map<string, string>;
let storage: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
};
const openTab = () => useWorkspaceStore(createPinia());
const saved = () => new LocalWorkspaceRepository(storage).load()!;
beforeEach(() => {
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  storage = {
    getItem: vi.fn((key: string) => memory.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      memory.set(key, value);
    }),
  };
  vi.stubGlobal("localStorage", storage);
});

describe("exclusive workspace write boundary", () => {
  it("rejects direct writes and releases the lock after a thrown callback", async () => {
    const repository = new LocalWorkspaceRepository(storage),
      data = repository.load()!;
    expect(() => repository.save(data)).toThrow("受保护");
    expect(storage.setItem).not.toHaveBeenCalled();
    await expect(
      withWorkspaceWriteLock(() => {
        throw Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    expect(() => repository.save(data)).toThrow("受保护");
    await withWorkspaceWriteLock(() => repository.save(data));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("allows at most one simultaneous writer and rejects the stale retry without overwriting the winner", async () => {
    const a = openTab(),
      b = openTab();
    a.openForm("employee")!.title = "From A";
    b.openForm("employee")!.title = "From B";
    const results = await Promise.all([
      a.saveForm("employee"),
      b.saveForm("employee"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? a : b,
      loser = results[0] ? b : a;
    expect(saved().forms.find((f) => f.id === "employee")!.title).toBe(
      winner.drafts.employee!.title,
    );
    expect(loser.storageError).toContain("其他页面保存了新内容");
    expect(loser.data.forms.find((f) => f.id === "employee")!.title).not.toBe(
      loser.drafts.employee!.title,
    );
    expect(await loser.saveForm("employee")).toBe(false);
    expect(loser.storageConflict).toBe(true);
    expect(saved().forms.find((f) => f.id === "employee")!.title).toBe(
      winner.drafts.employee!.title,
    );
    expect(JSON.parse(loser.exportRecovery()).formDrafts.employee.title).toBe(
      loser.drafts.employee!.title,
    );
  });

  it("takes no action before the asynchronous grant, copies caller inputs, and suppresses duplicate clicks", async () => {
    const store = openTab(), before = store.data.recordViews;
    const item = { fieldIds: ["amount"], sortField: "$createdAt", descending: true, pageSize: 20 as const };
    const first = store.saveRecordView("expense", item);
    expect(store.writePending).toBe(true);
    expect(store.data.recordViews).toEqual(before);
    item.fieldIds.push("note");
    expect(await store.createApp("Double click")).toBeUndefined();
    expect(await first).toBe(true);
    expect(store.writePending).toBe(false);
    expect(saved().recordViews?.expense?.fieldIds).toEqual(["amount"]);
    expect(saved().apps.some((a) => a.name === "Double click")).toBe(false);
  });

  it("rolls back failed storage and can acquire the lock again for a successful retry", async () => {
    const store = openTab(),
      before = copy(store.data.apps);
    storage.setItem.mockImplementationOnce(() => {
      throw Error("quota");
    });
    expect(await store.createApp("Retry me")).toBeUndefined();
    expect(store.data.apps).toEqual(before);
    expect(store.writePending).toBe(false);
    expect(saved().apps).toEqual(before);
    expect(await store.createApp("Retry me")).toBeDefined();
    expect(saved().apps.filter((a) => a.name === "Retry me")).toHaveLength(1);
    expect(store.storageError).toBe("");
  });

  it("keeps the workspace read-only when Web Locks is missing or denied, without an unsafe fallback", async () => {
    const store = openTab(),
      before = memory.get(WORKSPACE_KEY),
      count = store.data.apps.length;
    const locks = navigator.locks;
    vi.stubGlobal("navigator", {});
    expect(await store.createApp("Unsupported")).toBeUndefined();
    expect(store.storageError).toContain("不支持安全保存");
    vi.stubGlobal("navigator", {
      locks: { request: () => Promise.reject(Error("Permission denied")) },
    });
    expect(await store.createApp("Denied")).toBeUndefined();
    expect(store.storageError).toBe("Permission denied");
    expect(store.data.apps).toHaveLength(count);
    expect(memory.get(WORKSPACE_KEY)).toBe(before);
    vi.stubGlobal("navigator", { locks });
    expect(await store.createApp("Available again")).toBeDefined();
  });

  it("makes recovery use the same lock, preserving its draft when another writer holds it", async () => {
    const store = openTab();
    store.openForm("employee")!.title = "Recover after lock";
    const key = store.recoveryCandidates[0]!.key,
      before = saved();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = navigator.locks.request(
      WORKSPACE_WRITE_LOCK,
      { mode: "exclusive", ifAvailable: true },
      async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    );
    await ready;
    const pending = store.recoverDesign(key);
    await Promise.resolve();
    expect(store.writePending).toBe(true);
    expect(saved()).toEqual(before);
    expect(store.recoveryCandidates[0]!.form.title).toBe("Recover after lock");
    release();
    await held;
    const restored = await pending;
    expect(restored?.published).toBeUndefined();
    expect(restored?.title).toBe("Recover after lock · 恢复副本");
    expect(saved().forms).toHaveLength(before.forms.length + 1);
    expect(saved().entries).toEqual(before.entries);
  });

  it("uses one lock for nested publication and member submission, while prefills remain immediate", async () => {
    const store = openTab();
    await store.publishForm("employee");
    expect(navigator.locks.request).toHaveBeenCalledTimes(1);
    const token = store.queuePrefill("employee", 1, { name: "Prefill" });
    expect(typeof token).toBe("string");
    expect(store.consumePrefill(token, "employee", 1)).toEqual({
      name: "Prefill",
    });
    expect(navigator.locks.request).toHaveBeenCalledTimes(1);
    await store.submitEntry("employee", { name: "Accepted" }, "draft");
    expect(navigator.locks.request).toHaveBeenCalledTimes(2);
    expect(saved().entries).toHaveLength(1);
  });
});
