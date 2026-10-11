// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import {
  defaultCollectionRules,
  type CollectionConfiguration,
} from "@platform/contracts";
import CollectionDialog from "../src/features/data/CollectionDialog.vue";
import {
  collectionInstant,
  localCollectionTime,
  mergeCollectionRules,
} from "../src/domain/collectionRules";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
vi.mock("vue-router", () => ({ onBeforeRouteLeave: vi.fn() }));
vi.mock("../src/repositories/platformApi", async (original) => ({
  ...(await original<typeof import("../src/repositories/platformApi")>()),
  platformApi: vi.fn(),
}));
vi.mock("../src/components/BaseDialog.vue", () => ({
  default: defineComponent({
    props: ["open", "busy"],
    emits: ["close"],
    setup(props, { slots, emit }) {
      return () =>
        props.open
          ? h("section", [
              h("button", { onClick: () => emit("close") }, "共享关闭"),
              slots.default?.(),
              slots.footer?.(),
            ])
          : null;
    },
  }),
}));
let app: ReturnType<typeof createApp> | undefined;
const initial = (): CollectionConfiguration => ({
  revision: 2,
  submittedRecords: 5,
  rules: defaultCollectionRules(),
});
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  )!;
async function settle() {
  for (let i = 0; i < 15; i++) await nextTick();
}
async function mount() {
  document.body.innerHTML = '<div id="app"></div>';
  const saved = vi.fn(),
    close = vi.fn();
  app = createApp({
    render: () =>
      h(CollectionDialog, {
        definitionId: "object",
        title: "共享登记数据",
        onSaved: saved,
        onClose: close,
      }),
  });
  app.mount("#app");
  await settle();
  return { saved, close };
}
async function limit(value: number) {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="number"]',
  )!;
  input.value = String(value);
  input.dispatchEvent(new Event("input"));
  await settle();
}
beforeEach(() => {
  vi.mocked(platformApi).mockResolvedValue(initial());
});
afterEach(() => {
  app?.unmount();
  vi.resetAllMocks();
  document.body.innerHTML = "";
});

it("collection time round-trips explicit offsets and millisecond precision through local editing", () => {
  const source = "2026-10-09T00:00:03.123Z";
  expect(collectionInstant(localCollectionTime(source))).toBe(source);
  expect(
    collectionInstant(localCollectionTime("2026-10-09T08:00:03.123+08:00")),
  ).toBe(source);
  expect(collectionInstant("")).toBe("");
  expect(() => collectionInstant("无效日期")).toThrow();
});
it("independent configuration edits merge while contradictory edits remain explicit", () => {
  const base = defaultCollectionRules(),
    mine = { ...base, limit: 10 },
    latest = { ...base, enabled: false };
  expect(mergeCollectionRules(base, mine, latest)).toEqual({
    rules: { ...latest, limit: 10 },
    conflicts: [],
  });
  expect(
    mergeCollectionRules(base, mine, { ...latest, limit: 20 }).conflicts,
  ).toEqual(["limit"]);
  expect(
    mergeCollectionRules(base, mine, { ...latest, limit: 10 }).conflicts,
  ).toEqual([]);
});
it("settings save one object-scoped revision, show visible pending state and acknowledge only the successful write", async () => {
  const { saved } = await mount();
  await limit(10);
  let resolve!: (value: CollectionConfiguration) => void;
  vi.mocked(platformApi).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  button("保存收集设置").click();
  await settle();
  expect(button("保存收集设置").disabled).toBe(true);
  expect(saved).not.toHaveBeenCalled();
  expect(vi.mocked(platformApi).mock.calls.at(-1)).toEqual([
    "/definitions/object/collection-rules",
    "PUT",
    { expectedRevision: 2, rules: { ...defaultCollectionRules(), limit: 10 } },
  ]);
  resolve({
    revision: 3,
    submittedRecords: 5,
    rules: { ...defaultCollectionRules(), limit: 10 },
  });
  await settle();
  expect(saved).toHaveBeenCalledTimes(1);
});
it("save failures retain inputs and common close/cancel requires a decision for unfinished settings", async () => {
  const { saved, close } = await mount();
  await limit(8);
  vi.mocked(platformApi).mockRejectedValueOnce(new Error("暂时无法保存"));
  button("保存收集设置").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>('input[type="number"]')!.value,
  ).toBe("8");
  expect(saved).not.toHaveBeenCalled();
  button("共享关闭").click();
  await settle();
  expect(close).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("有尚未保存的设置");
  button("继续编辑").click();
  await settle();
  button("取消").click();
  await settle();
  button("放弃修改").click();
  expect(close).toHaveBeenCalledTimes(1);
});
it("revision conflicts preserve inputs, compare without saving and merge independent changes before an explicit save", async () => {
  const { saved } = await mount();
  await limit(9);
  const latest = {
    revision: 3,
    submittedRecords: 5,
    rules: { ...defaultCollectionRules(), enabled: false },
  };
  vi.mocked(platformApi).mockRejectedValueOnce(
    new PlatformError("其他人已修改", 409),
  );
  button("保存收集设置").click();
  await settle();
  expect(button("保存收集设置").disabled).toBe(true);
  vi.mocked(platformApi).mockResolvedValueOnce(latest);
  button("对照最新设置").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>('input[type="number"]')!.value,
  ).toBe("9");
  expect(saved).not.toHaveBeenCalled();
  button("合并到当前设置").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
  ).toBe(false);
  expect(
    vi.mocked(platformApi).mock.calls.filter((c) => c[1] === "PUT"),
  ).toHaveLength(1);
  vi.mocked(platformApi).mockResolvedValueOnce({
    ...latest,
    revision: 4,
    rules: { ...latest.rules, limit: 9 },
  });
  button("保存收集设置").click();
  await settle();
  expect(vi.mocked(platformApi).mock.calls.at(-1)![2]).toEqual({
    expectedRevision: 3,
    rules: { ...latest.rules, limit: 9 },
  });
  expect(saved).toHaveBeenCalledTimes(1);
});
it("contradictory rule edits require an explicit choice; choosing the latest never silently discards other local changes", async () => {
  const { saved } = await mount();
  await limit(9);
  document
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!
    .click();
  await settle();
  vi.mocked(platformApi).mockRejectedValueOnce(
    new PlatformError("其他人已修改", 409),
  );
  button("保存收集设置").click();
  await settle();
  vi.mocked(platformApi).mockResolvedValueOnce({
    revision: 3,
    submittedRecords: 5,
    rules: { ...defaultCollectionRules(), limit: 20 },
  });
  button("对照最新设置").click();
  await settle();
  expect(button("合并到当前设置").disabled).toBe(true);
  const choice = document.querySelector<HTMLSelectElement>(
    '[aria-label="数量上限冲突选择"]',
  )!;
  choice.value = "latest";
  choice.dispatchEvent(new Event("change"));
  await settle();
  button("合并到当前设置").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>('input[type="number"]')!.value,
  ).toBe("20");
  expect(
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!
      .checked,
  ).toBe(false);
  expect(saved).not.toHaveBeenCalled();
});
