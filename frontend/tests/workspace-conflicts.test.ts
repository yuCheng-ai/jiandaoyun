import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import { newWebhook } from "../src/domain/extensions";
import { seedWorkspace } from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import { withWorkspaceWriteLock } from "../src/repositories/workspaceWriteLock";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
  WorkspaceConflictError,
} from "../src/repositories/workspaceRepository";

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

describe("workspace stale-save protection and recovery", () => {
  it("requires a successful read, detects a stale writer, and advances the baseline only after success", async () => {
    const a = new LocalWorkspaceRepository(storage),
      b = new LocalWorkspaceRepository(storage);
    expect(() => a.save(seedWorkspace())).toThrow("尚未成功读取");
    const one = a.load()!,
      two = b.load()!;
    one.apps[0]!.name = "Newest";
    await withWorkspaceWriteLock(() => a.save(one));
    expect(a.hasExternalChange()).toBe(false);
    expect(b.hasExternalChange()).toBe(true);
    await expect(withWorkspaceWriteLock(() => b.save(two))).rejects.toThrow(
      WorkspaceConflictError,
    );
    expect(saved().apps[0]!.name).toBe("Newest");
    const baseline = a.baselineRaw();
    storage.setItem.mockImplementationOnce(() => {
      throw Error("quota");
    });
    await expect(withWorkspaceWriteLock(() => a.save(two))).rejects.toThrow(
      "quota",
    );
    expect(a.baselineRaw()).toBe(baseline);
    expect(a.hasExternalChange()).toBe(false);
    await withWorkspaceWriteLock(() => a.save(two));
    expect(saved().apps[0]!.name).toBe(two.apps[0]!.name);
  });

  it("never saves when visiting forms, even from an old tab", async () => {
    const old = openTab(),
      current = openTab();
    await current.createForm("oa", "Another tab", "form");
    const before = memory.get(WORKSPACE_KEY),
      writes = storage.setItem.mock.calls.filter(
        ([key]) => key === WORKSPACE_KEY,
      ).length;
    old.openForm("employee");
    old.openForm("expense");
    expect(memory.get(WORKSPACE_KEY)).toBe(before);
    expect(
      storage.setItem.mock.calls.filter(([key]) => key === WORKSPACE_KEY),
    ).toHaveLength(writes);
    expect(old.data.recentFormIds[0]).toBe("expense");
    expect(openTab().data.recentFormIds[0]).toBe("expense");
  });

  it("blocks stale design saves without relying on storage events and retains the edited draft", async () => {
    const old = openTab(),
      current = openTab();
    const draft = old.openForm("employee")!;
    draft.schema.fields.push(
      createField("number", { label: "Unsaved budget" }),
    );
    await current.renameForm("employee", "Latest title");
    const latestRaw = memory.get(WORKSPACE_KEY);
    expect(await old.saveForm("employee")).toBe(false);
    expect(memory.get(WORKSPACE_KEY)).toBe(latestRaw);
    expect(old.storageConflict).toBe(true);
    expect(draft.schema.fields.at(-1)!.label).toBe("Unsaved budget");
    expect(
      old.data.forms
        .find((f) => f.id === "employee")!
        .schema.fields.some((f) => f.label === "Unsaved budget"),
    ).toBe(false);
    const backup = JSON.parse(old.exportRecovery());
    expect(backup.formDrafts.employee.schema.fields.at(-1).label).toBe(
      "Unsaved budget",
    );
    expect(
      backup.attempt.workspace.forms
        .find((f: any) => f.id === "employee")
        .schema.fields.at(-1).label,
    ).toBe("Unsaved budget");
    expect(backup.latestRaw).toBe(latestRaw);
  });

  it("captures an attempted extension before caller rollback and restores it only as a disabled new design", async () => {
    const old = openTab(),
      current = openTab();
    const config = newWebhook();
    config.name = "Recover config";
    config.url = "https://example.com/hook";
    config.enabled = true;
    old.openForm("employee");
    await current.renameForm("employee", "New employee");
    const before = saved();
    expect(await old.saveWebhook("employee", config)).toBe(false);
    expect(old.drafts.employee!.extensions!.webhooks).toHaveLength(0);
    const candidate = old.recoveryCandidates.find(
      (c) => c.source === "最近保存尝试",
    )!;
    expect(candidate.form.extensions!.webhooks[0]!.name).toBe("Recover config");
    const restored = (await old.recoverDesign(candidate.key))!;
    expect(restored.id).not.toBe("employee");
    expect(restored.published).toBeUndefined();
    expect(restored.versions).toEqual([]);
    expect(restored.extensions!.webhooks[0]!.enabled).toBe(false);
    expect(restored.workflow.title).toBe(restored.title);
    const after = saved();
    expect(after.forms.filter((f) => f.id !== restored.id)).toEqual(
      before.forms,
    );
    expect(after.entries).toEqual(before.entries);
    expect(after.organization).toEqual(before.organization);
    expect((await old.recoverDesign(candidate.key))!.id).toBe(restored.id);
    expect(saved().forms).toHaveLength(before.forms.length + 1);
    expect(await old.persist()).toBe(false);
    expect(saved().forms).toHaveLength(before.forms.length + 1);
  });

  it("rolls back a conflicting publication and strips attempted history from the recovery copy", async () => {
    const old = openTab(),
      current = openTab();
    const draft = old.openForm("employee")!;
    draft.schema.fields.push(createField("text", { label: "Unpublished" }));
    await current.publishForm("employee");
    expect(await old.publishForm("employee")).toBe(false);
    expect(draft.published).toBeUndefined();
    expect(draft.versions).toEqual([]);
    expect(
      saved().forms.find((f) => f.id === "employee")!.versions,
    ).toHaveLength(1);
    const candidate = old.recoveryCandidates.find(
      (c) => c.source === "最近保存尝试",
    )!;
    expect(candidate.form.versions).toHaveLength(1);
    const restored = (await old.recoverDesign(candidate.key))!;
    expect(restored.versions).toEqual([]);
    expect(restored.schema.fields.at(-1)!.label).toBe("Unpublished");
  });

  it("keeps an attempted record in the backup without reporting it committed", async () => {
    const base = openTab();
    await base.publishForm("employee");
    const old = openTab(),
      current = openTab();
    await current.publishForm("employee");
    expect(
      await old.submitEntry("employee", { name: "Unsaved" }, "draft"),
    ).toBeUndefined();
    expect(old.data.entries).toHaveLength(0);
    expect(saved().entries).toHaveLength(0);
    const backup = JSON.parse(old.exportRecovery());
    expect(backup.attempt.workspace.entries).toHaveLength(1);
    expect(backup.currentWorkspace.entries).toHaveLength(0);
  });

  it.each([null, "broken"])(
    "does not replace deleted or corrupt latest data: %s",
    async (raw) => {
      const old = openTab();
      old.openForm("employee")!.title = "Keep me";
      if (raw === null) memory.delete(WORKSPACE_KEY);
      else memory.set(WORKSPACE_KEY, raw);
      expect(old.checkStorageChanges()).toBe(true);
      expect(await old.saveForm("employee")).toBe(false);
      expect(
        await old.recoverDesign(old.recoveryCandidates[0]!.key),
      ).toBeUndefined();
      expect(memory.get(WORKSPACE_KEY) ?? null).toBe(raw);
      expect(JSON.parse(old.exportRecovery()).latestRaw).toBe(raw);
    },
  );

  it("does not adopt a corrupt load as an authorized save baseline", () => {
    memory.set(WORKSPACE_KEY, "broken");
    const repository = new LocalWorkspaceRepository(storage);
    expect(() => repository.load()).toThrow();
    expect(() => repository.save(seedWorkspace())).toThrow("尚未成功读取");
    expect(memory.get(WORKSPACE_KEY)).toBe("broken");
  });

  it("rechecks the latest snapshot when restoring a design and refuses an intervening write", async () => {
    const old = openTab();
    old.openForm("employee")!.title = "Draft";
    const newest = copy(saved());
    newest.apps[0]!.name = "Concurrent update";
    const originalRead = storage.getItem.getMockImplementation()!;
    let reads = 0;
    storage.getItem.mockImplementation((key: string) => {
      if (key === WORKSPACE_KEY && ++reads === 2)
        memory.set(key, JSON.stringify(newest));
      return originalRead(key);
    });
    expect(
      await old.recoverDesign(old.recoveryCandidates[0]!.key),
    ).toBeUndefined();
    expect(saved().forms).toHaveLength(newest.forms.length);
    expect(saved().apps[0]!.name).toBe("Concurrent update");
  });
});
