// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { addressParts, isAddressValue } from "@platform/contracts";
import { createField, copy, type FormField } from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";
import { LocalWorkspaceRepository } from "../src/repositories/workspaceRepository";
import { defaultAccess, newAccessGroup } from "../src/domain/access";
import {
  recordImportColumns,
  memberImportColumns,
  importFieldKey,
  importExcelLayout,
  importHeaderRows,
  importHeaders,
  suggestImportMapping,
  recognizeImportTemplate,
  prepareImportRows,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import { recordExcelExport } from "../src/domain/records";
import {
  excelBytes,
  readExcel,
  type ExcelValue,
  type ExcelMerge,
} from "../src/services/excel";
import RecordImportDialog from "../src/features/forms/components/RecordImportDialog.vue";
const address = {
  province: "江苏省",
  city: "无锡市",
  district: "锡山区",
  detail: "演示仓库,1号\n=SUM(1,2)",
};
let app: ReturnType<typeof createApp> | undefined;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await nextTick();
};
const button = (name: string) =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ).find((b) => b.textContent?.trim() === name)!;
async function fixture(details = false) {
  const pinia = createPinia(),
    store = useWorkspaceStore(pinia);
  const created = (await store.createForm("oa", "地址导入验收", "form"))!;
  const draft = store.openForm(created.id)!;
  draft.schema.fields = [
    createField("text", { id: "name", label: "名称" }),
    createField("address", {
      id: "address",
      label: "收货地址",
      defaultValue: { province: "浙江省" },
    }),
    createField("text", { id: "private", label: "内部说明" }),
  ];
  if (details)
    draft.schema.fields.push(
      createField("subform", {
        id: "items",
        label: "明细",
        children: [
          createField("text", { id: "item", label: "商品" }),
          createField("address", { id: "destination", label: "送达地址" }),
        ],
      }),
    );
  expect(await store.publishForm(created.id)).toBe(true);
  const live = () => store.data.forms.find((f) => f.id === created.id)!;
  const request = (
    rows: ExcelValue[][],
    keys?: string[],
    extra: Partial<RecordImportRequest> = {},
  ): RecordImportRequest => {
    const cols = recordImportColumns(live().published!.schema);
    return {
      mode: "create",
      definitionVersion: live().published!.version,
      rows,
      firstRow: 3,
      validate: true,
      triggerWorkflow: false,
      targets: [],
      mapping: (
        keys || [
          "name",
          ...addressParts(live().published!.schema.fields[1]!).map((p) =>
            importFieldKey("address", p),
          ),
        ]
      ).map((key, column) => {
        if (key === "data_id") return { column, fieldId: key, type: "data_id" };
        const c = cols.find(
          (c) => importFieldKey(c.field.id, c.addressPart) === key,
        )!;
        return {
          column,
          fieldId: c.field.id,
          type: c.field.type,
          ...(c.parent ? { parentId: c.parent.id } : {}),
          ...(c.addressPart ? { addressPart: c.addressPart } : {}),
        };
      }),
      ...extra,
    };
  };
  return { pinia, store, live, draft, request };
}
it("writes independent address-part IDs and source column labels for all four precisions, preserving renamed and ambiguous fields", async () => {
  const f = await fixture();
  f.draft.schema.fields = ["province", "city", "district", "detail"].map(
    (format, i) =>
      createField("address", { id: `a${i}`, label: "同名", format }),
  );
  await f.store.publishForm(f.draft.id);
  const schema = f.live().published!.schema,
    cols = recordImportColumns(schema),
    layout = importExcelLayout(cols);
  expect(() =>
    importExcelLayout(
      Array.from({ length: 126 }, (_, i) =>
        createField("address", { id: `wide${i}` }),
      ).flatMap((field) => recordImportColumns({ ...schema, fields: [field] })),
    ),
  ).toThrow("500列");
  expect(layout.headers[0]).toEqual([
    "同名（省/自治区/直辖市）",
    "同名（省/自治区/直辖市）",
    "同名（市）",
    "同名（省/自治区/直辖市）",
    "同名（市）",
    "同名（县/区）",
    "同名（省/自治区/直辖市）",
    "同名（市）",
    "同名（县/区）",
    "同名（详细地址）",
  ]);
  const [sheet] = await readExcel(
    await excelBytes(
      [...layout.headers, Array(10).fill("江苏省")],
      layout.fieldIds,
    ),
    "标准模板.xlsx",
  );
  schema.fields.forEach((field) => (field.label = "改名"));
  expect(suggestImportMapping(sheet!, 1, schema)).toEqual(layout.fieldIds);
  expect(
    suggestImportMapping({ ...sheet!, fieldIds: undefined }, 1, schema),
  ).toEqual(Array(10).fill(""));
  expect(
    suggestImportMapping(
      { rows: [["改名"]], headerRow: 0, name: "数据" },
      0,
      schema,
    ),
  ).toEqual([""]);
  const recognized = recognizeImportTemplate(
    { ...sheet!, fieldIds: undefined, headerRow: 0 },
    schema,
  );
  expect(recognized.headerRow).toBe(1);
  expect(suggestImportMapping(recognized, 1, schema)).toEqual(layout.fieldIds);
});
it("exports and reimports real merged Excel with main and child addresses, exact part values and literal detail text", async () => {
  const f = await fixture(true);
  const first = (await f.store.submitEntry(f.live().id, {
    name: "主单",
    address,
    items: [
      { item: "甲", destination: address },
      {
        item: "乙",
        destination: {
          province: "北京市",
          city: "北京市",
          district: "海淀区",
          detail: "2号",
        },
      },
    ],
  }))!;
  const exported = recordExcelExport(
    f.store.data,
    f.live().published!.schema.fields,
    ["data_id"],
    [{ entry: first, schema: f.live().published!.schema, extra: [first.id] }],
  );
  const [sheet] = await readExcel(
    await excelBytes(exported.rows, exported.fieldIds, exported.merges),
    "地址明细.xlsx",
  );
  expect(importHeaderRows(sheet!, 1)).toBe(2);
  expect(importHeaders(sheet!, 1)).toContain("明细 · 送达地址（县/区）");
  const start = 3,
    mapping = suggestImportMapping(sheet!, 1, f.live().published!.schema);
  expect(mapping).toEqual(exported.fieldIds);
  const rows = sheet!.rows.slice(start),
    input = f.request(rows, mapping, {
      firstRow: 4,
      merges: sheet!.merges
        ?.filter((m) => m.s.r >= start)
        .map((m) => ({
          s: { ...m.s, r: m.s.r - start },
          e: { ...m.e, r: m.e.r - start },
        })),
    });
  const result = await f.store.importEntries(f.live().id, input);
  if (!result) throw Error("import failed");
  expect(result.created).toBe(1);
  const saved = f.store.data.entries.find((e) => e.id !== first.id)!;
  expect(saved.values.address).toEqual(address);
  expect(saved.values.items).toEqual(first.values.items);
  expect(first.values.address).toEqual(address);
  expect(isAddressValue(saved.values.address)).toBe(true);
});
it("rejects incomplete and cross-province rows together and retries only rejected addresses without defaults or duplicate writes", async () => {
  const f = await fixture();
  const input = f.request([
    ["正确", ...Object.values(address)],
    ["不完整", "江苏省", "无锡市", "锡山区", null],
    ["错省", "浙江省", "无锡市", "锡山区", "2号"],
    ["空地址", null, null, null, null],
  ]);
  const result = await f.store.importEntries(f.live().id, input);
  expect(result).toMatchObject({ created: 2, updated: 0 });
  if (!result) throw Error("import failed");
  expect(result!.rows.map((r) => r.kind)).toEqual([
    "create",
    "error",
    "error",
    "create",
  ]);
  expect(result!.rows[1]!.issues).toMatchObject([
    {
      fieldId: "address",
      row: 4,
      message: expect.stringContaining("完整填写"),
    },
  ]);
  expect(result!.rows[2]!.values!.address).toMatchObject({
    province: "浙江省",
    city: "无锡市",
  });
  expect(
    f.store.data.entries.find((e) => e.values.name === "空地址")!.values
      .address,
  ).toEqual({ province: "", city: "", district: "", detail: "" });
  const accepted = copy(f.store.data.entries);
  input.rows[1]![4] = "3号";
  input.rows[2]![1] = "江苏省";
  expect(
    await f.store.importEntries(f.live().id, { ...input, onlyRows: [1, 2] }),
  ).toMatchObject({
    created: 2,
    rows: [
      { row: 4, kind: "create" },
      { row: 5, kind: "create" },
    ],
  });
  expect(f.store.data.entries).toHaveLength(4);
  for (const entry of accepted)
    expect(f.store.data.entries.find((e) => e.id === entry.id)).toEqual(entry);
  expect(new LocalWorkspaceRepository().load()!.entries).toHaveLength(4);
});
it("honors admin validation and partial matching while keeping blank and unmapped update parts and unrelated values", async () => {
  const f = await fixture();
  const e = (await f.store.submitEntry(f.live().id, {
    name: "原单",
    address,
    private: "保留",
  }))!;
  const partial = f.request(
    [[e.id, "只改详情", null]],
    ["data_id", "address.detail", "address.city"],
    { mode: "update", targets: [copy(e)] },
  );
  expect(await f.store.importEntries(f.live().id, partial)).toMatchObject({
    updated: 1,
  });
  const saved = f.store.data.entries.find((x) => x.id === e.id)!;
  expect(saved.values).toMatchObject({
    address: { ...address, detail: "只改详情" },
    private: "保留",
    name: "原单",
  });
  const invalid = f.request(
    [[e.id, "不存在的市"]],
    ["data_id", "address.city"],
    { mode: "update", targets: [copy(saved)] },
  );
  expect(await f.store.importEntries(f.live().id, invalid)).toMatchObject({
    updated: 0,
    rows: [{ kind: "error" }],
  });
  expect(f.store.data.entries.find((x) => x.id === e.id)).toEqual(saved);
  expect(
    await f.store.importEntries(f.live().id, { ...invalid, validate: false }),
  ).toMatchObject({ updated: 1 });
  expect(
    f.store.data.entries.find((x) => x.id === e.id)!.values.address,
  ).toMatchObject({
    city: "不存在的市",
    province: "江苏省",
    district: "锡山区",
    detail: "只改详情",
  });
});
it("uses exact historical address precision for exports and updates, never current default values", async () => {
  const f = await fixture();
  f.draft.schema.fields[1]!.format = "province";
  await f.store.publishForm(f.live().id);
  const old = (await f.store.submitEntry(f.live().id, {
    name: "旧版",
    address: { province: "江苏省" },
  }))!;
  const oldDefinition = copy(
    f.live().versions.find((v) => v.version === old.definitionVersion)!,
  );
  f.draft.schema.fields[1]!.format = "detail";
  await f.store.publishForm(f.live().id);
  const input = f.request([[old.id, "无锡市"]], ["data_id", "address.city"], {
    mode: "update",
    targets: [copy(old)],
  });
  expect(await f.store.importEntries(f.live().id, input)).toMatchObject({
    updated: 0,
    rows: [{ kind: "error", message: expect.stringContaining("原版本") }],
  });
  const province = f.request(
    [[old.id, "浙江省"]],
    ["data_id", "address.province"],
    { mode: "update", targets: [copy(old)] },
  );
  expect(await f.store.importEntries(f.live().id, province)).toMatchObject({
    updated: 1,
  });
  const saved = f.store.data.entries.find((e) => e.id === old.id)!;
  expect(saved.definitionVersion).toBe(old.definitionVersion);
  expect(saved.values.address).toEqual({ province: "浙江省" });
  expect(
    f.live().versions.find((v) => v.version === oldDefinition.version),
  ).toEqual(oldDefinition);
  const output = recordExcelExport(
    f.store.data,
    f.live().published!.schema.fields,
    [],
    [{ entry: saved, schema: oldDefinition.schema, extra: [] }],
  );
  expect(output.rows.at(-1)!.slice(1, 5)).toEqual(["浙江省", null, null, null]);
});
it("clamps every address part to the original member field permission and rejects revoked imports", async () => {
  const f = await fixture(true),
    group = newAccessGroup(f.live().published!.schema, "read");
  group.id = "address-import";
  group.identities = ["zhang"];
  group.actions = ["view", "edit", "import"];
  group.fields.private = "hidden";
  group.fields.address = "read";
  group.fields.destination = "edit";
  group.fields.items = "edit";
  await f.store.saveFormAccess(f.live().id, {
    ...defaultAccess(),
    membersEnabled: true,
    groups: [group],
  });
  const member = { actorId: "zhang", selection: group.id };
  const cols = memberImportColumns(f.live(), "update", f.store.data, member);
  expect(
    cols.some((c) => c.field.id === "private" || c.field.id === "address"),
  ).toBe(false);
  expect(cols.filter((c) => c.field.id === "destination")).toHaveLength(4);
  const input = f.request([["江苏省"]], ["address.province"], {
    member,
    mode: "update",
  });
  input.mapping.unshift({ column: 1, fieldId: "data_id", type: "data_id" });
  expect(() => prepareImportRows(f.live(), input, f.store.data)).toThrow(
    "无导入权限",
  );
  group.fields.address = "edit";
  await f.store.saveFormAccess(f.live().id, {
    ...defaultAccess(),
    membersEnabled: true,
    groups: [group],
  });
  const create = f.request(
    [["江苏省", "无锡市", "锡山区", "4号"]],
    ["address.province", "address.city", "address.district", "address.detail"],
    { member, validate: false },
  );
  expect(prepareImportRows(f.live(), create, f.store.data)[0]!.kind).toBe(
    "create",
  );
  expect(
    prepareImportRows(
      f.live(),
      { ...create, rows: [["浙江省", "无锡市", "锡山区", "4号"]] },
      f.store.data,
    )[0]!.kind,
  ).toBe("error");
  group.actions = ["view"];
  await f.store.saveFormAccess(f.live().id, {
    ...defaultAccess(),
    membersEnabled: true,
    groups: [group],
  });
  const baseline = copy(f.store.data.entries);
  expect(await f.store.importEntries(f.live().id, create)).toBe(false);
  expect(f.store.data.entries).toEqual(baseline);
});
it("rejects duplicate parts, forged parts on other fields, misplaced children and malformed data IDs", async () => {
  const f = await fixture(true),
    input = f.request(
      [["江苏省", "江苏省"]],
      ["address.province", "address.city"],
    );
  expect(() =>
    prepareImportRows(
      f.live(),
      {
        ...input,
        mapping: input.mapping.map((m) => ({ ...m, addressPart: "province" })),
      },
      f.store.data,
    ),
  ).toThrow("重复匹配");
  expect(() =>
    prepareImportRows(
      f.live(),
      {
        ...input,
        mapping: [
          { column: 0, fieldId: "name", type: "text", addressPart: "province" },
        ],
      },
      f.store.data,
    ),
  ).toThrow("类型或子表归属");
  expect(() =>
    prepareImportRows(
      f.live(),
      {
        ...input,
        mapping: [
          {
            column: 0,
            fieldId: "destination",
            type: "address",
            addressPart: "province",
          },
        ],
      },
      f.store.data,
    ),
  ).toThrow("类型或子表归属");
  expect(() =>
    prepareImportRows(
      f.live(),
      {
        ...input,
        mapping: [
          {
            column: 0,
            fieldId: "data_id",
            type: "data_id",
            addressPart: "province",
          },
          input.mapping[1]!,
        ],
      },
      f.store.data,
    ),
  ).toThrow("data_id 匹配无效");
});
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({ render: () => h(RecordImportDialog, { form: f.live() }) });
  app.use(f.pinia);
  app.mount("#app");
  await settle();
}
async function upload(
  rows: ExcelValue[][],
  ids: string[],
  labels: string[],
  merges: ExcelMerge[] = [],
) {
  const bytes = await excelBytes([labels, ...rows], ids, merges);
  const node = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(node, "files", {
    configurable: true,
    value: [{ name: "地址模板.xlsx", arrayBuffer: async () => bytes }],
  });
  node.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(button("下一步")).toBeTruthy());
  await settle();
}
it("matches real address Excel, corrects all four cells through one existing picker and retries only failed rows", async () => {
  const f = await fixture();
  await mount(f);
  const validate = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'dialog input[type="checkbox"]',
    ),
  ).find((i) => i.parentElement?.textContent?.includes("导入触发数据校验"))!;
  validate.click();
  const layout = importExcelLayout(
    recordImportColumns(f.live().published!.schema),
  );
  await upload(
    [
      ["通过", ...Object.values(address)],
      ["待改", "江苏省", "无锡市", "锡山区", null],
    ],
    layout.fieldIds,
    layout.headers[0]!.map(String),
  );
  button("下一步").click();
  await settle();
  const selects = Array.from(
    document.querySelectorAll<HTMLSelectElement>(
      'select[aria-label$="列匹配字段"]',
    ),
  );
  expect(selects.map((s) => s.value).slice(0, 5)).toEqual(
    layout.fieldIds.slice(0, 5),
  );
  button("导入").click();
  await vi.waitFor(() => expect(button("修改失败数据")).toBeTruthy());
  const accepted = copy(f.store.data.entries[0]!);
  button("修改失败数据").click();
  await settle();
  expect(
    document.querySelectorAll(".import-correction-table .address-trigger"),
  ).toHaveLength(1);
  const detail = document.querySelector<HTMLTextAreaElement>(
    ".import-correction-table .address-detail",
  )!;
  expect(detail).toBeTruthy();
  expect(detail.placeholder).not.toBe("江苏省");
  detail.value = "纠错地址5号";
  detail.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(
    document.querySelectorAll(".import-correction-table td.has-error"),
  ).toHaveLength(0);
  button("重新导入").click();
  await vi.waitFor(() => expect(f.store.data.entries).toHaveLength(2));
  expect(
    f.store.data.entries.find((e) => e.values.name === "待改")!.values.address,
  ).toEqual({ ...address, detail: "纠错地址5号" });
  expect(f.store.data.entries.find((e) => e.id === accepted.id)).toEqual(
    accepted,
  );
});
it("partial address matching edits only mapped cells and keeps the other mapped part through correction", async () => {
  const f = await fixture();
  await mount(f);
  const validate = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'dialog input[type="checkbox"]',
    ),
  ).find((i) => i.parentElement?.textContent?.includes("导入触发数据校验"))!;
  validate.click();
  await upload(
    [["待改", "江苏省", null]],
    ["name", "address.province", "address.detail"],
    ["名称", "收货地址（省/自治区/直辖市）", "收货地址（详细地址）"],
  );
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(button("修改失败数据")).toBeTruthy());
  button("修改失败数据").click();
  await settle();
  expect(
    document.querySelector(".import-correction-table .address-trigger"),
  ).toBeNull();
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Excel 第 3 行 收货地址（详细地址）"]',
  )!;
  input.value = "仅修改映射列";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(
    document.querySelector(".import-correction-table")!.textContent,
  ).toContain("完整填写");
  expect(f.store.data.entries).toHaveLength(0);
  const province = document.querySelector<HTMLInputElement>(
    '[aria-label="Excel 第 3 行 收货地址（省/自治区/直辖市）"]',
  )!;
  expect(province.value).toBe("江苏省");
});

it("corrects one child address in a merged record without copying it to its sibling or changing the main address", async () => {
  const f = await fixture(true);
  await mount(f);
  const validate = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'dialog input[type="checkbox"]',
    ),
  ).find((i) => i.parentElement?.textContent?.includes("导入触发数据校验"))!;
  validate.click();
  const layout = importExcelLayout(
    recordImportColumns(f.live().published!.schema),
  );
  await upload(
    [
      [
        "合并主单",
        ...Object.values(address),
        null,
        "甲",
        ...Object.values(address),
      ],
      [
        null,
        null,
        null,
        null,
        null,
        null,
        "乙",
        "江苏省",
        "无锡市",
        "滨湖区",
        null,
      ],
    ],
    layout.fieldIds,
    layout.headers[0]!.map(String),
    Array.from({ length: 6 }, (_, c) => ({ s: { r: 1, c }, e: { r: 2, c } })),
  );
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(button("修改失败数据")).toBeTruthy());
  expect(f.store.data.entries).toHaveLength(0);
  button("修改失败数据").click();
  await settle();
  expect(
    document.querySelectorAll(".import-correction-table .address-trigger"),
  ).toHaveLength(3);
  const detail = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Excel 第 4 行 明细 · 送达地址 详细地址"]',
  )!;
  detail.value = "明细乙6号";
  detail.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  button("重新导入").click();
  await vi.waitFor(() => expect(f.store.data.entries).toHaveLength(1));
  expect(f.store.data.entries[0]!.values.address).toEqual(address);
  expect(f.store.data.entries[0]!.values.items).toEqual([
    { item: "甲", destination: address },
    {
      item: "乙",
      destination: {
        province: "江苏省",
        city: "无锡市",
        district: "滨湖区",
        detail: "明细乙6号",
      },
    },
  ]);
});
