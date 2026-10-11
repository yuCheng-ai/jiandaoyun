// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import RecordImportDialog from "../src/features/forms/components/RecordImportDialog.vue";
import { copy, createField } from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  excelBytes,
  type ExcelValue,
  type ExcelMerge,
} from "../src/services/excel";
import {
  importExcelLayout,
  recordImportColumns,
} from "../src/domain/recordImport";
import { defaultAccess, newAccessGroup } from "../src/domain/access";
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 10; i++) await nextTick();
};
const button = (label: string) =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ).find((item) => item.textContent?.trim() === label)!;
afterEach(() => {
  vi.restoreAllMocks();
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});
async function fixture(
  details = false,
  relation = false,
  member = false,
  unique = false,
  organization = false,
) {
  const pinia = createPinia(),
    store = useWorkspaceStore(pinia),
    form = (await store.createForm("oa", "导入控件", "form"))!,
    draft = store.openForm(form.id)!;
  draft.schema.fields = [
    createField("text", {
      id: "field_name",
      label: "名称",
      required: true,
      unique,
    }),
    createField("number", { id: "field_quantity", label: "数量", min: 0 }),
  ];
  if (details)
    draft.schema.fields.push(
      createField("subform", {
        id: "items",
        label: "订单明细",
        children: [
          createField("text", { id: "item", label: "商品" }),
          createField("number", { id: "qty", label: "数量", min: 0, max: 10 }),
        ],
      }),
    );
  if (organization)
    draft.schema.fields.push(
      createField("member", { id: "owner", label: "负责人" }),
      createField("department", { id: "department", label: "部门" }),
    );
  let sourceId = "";
  if (relation) {
    const source = (await store.createForm("oa", "客户信息", "form"))!;
    sourceId = source.id;
    store.openForm(source.id)!.schema.fields = [
      createField("text", { id: "clientName", label: "客户名称" }),
      createField("text", { id: "clientCode", label: "客户编号" }),
    ];
    expect(await store.publishForm(source.id)).toBe(true);
    await store.submitEntry(source.id, {
      clientName: "甲公司",
      clientCode: "C-A",
    });
    draft.schema.fields.push(
      createField("relation", {
        id: "customer",
        label: "关联客户",
        referenceFormId: source.id,
      }),
    );
  }
  expect(await store.publishForm(form.id)).toBe(true);
  const entry = (await store.submitEntry(form.id, {
    field_name: "原值",
    field_quantity: 2,
  }))!;
  let memberScope: { actorId: string; selection: string } | undefined;
  if (member) {
    const group = newAccessGroup(
      store.data.forms.find((f) => f.id === form.id)!.published!.schema,
      "read",
    );
    group.id = "import-member";
    group.identities = ["zhang"];
    group.actions = ["view", "import", "edit"];
    group.fields.field_name = "edit";
    expect(
      await store.saveFormAccess(form.id, {
        ...defaultAccess(),
        membersEnabled: true,
        groups: [group],
      }),
    ).toBe(true);
    memberScope = { actorId: "zhang", selection: group.id };
  }
  let closed = 0,
    saves = 0;
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    render: () =>
      h(RecordImportDialog, {
        form: store.data.forms.find((f) => f.id === form.id)!,
        member: memberScope,
        onClose: () => closed++,
        onSaved: () => saves++,
      }),
  });
  app.use(pinia);
  app.mount("#app");
  await settle();
  return {
    store,
    form,
    entry,
    sourceId,
    closed: () => closed,
    saves: () => saves,
  };
}
async function select(label: string, value: string) {
  const node = document.querySelector<HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  node.value = value;
  node.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}
async function upload(
  rows: ExcelValue[][],
  fields = ["field_name", "field_quantity"],
  labels = ["旧名称", "数量"],
  merges: ExcelMerge[] = [],
) {
  const bytes = await excelBytes([labels, ...rows], fields, merges);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{ name: "实际模板.xlsx", arrayBuffer: async () => bytes }],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(button("下一步")).toBeTruthy());
  await settle();
}
async function editCell(label: string, value: string) {
  const node = document.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`,
  )!;
  node.focus();
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
async function validatedImport(rows: ExcelValue[][]) {
  const checkbox = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'dialog input[type="checkbox"]',
    ),
  ).find((node) =>
    node.parentElement?.textContent?.includes("导入触发数据校验"),
  )!;
  checkbox.click();
  await upload(rows);
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(button("修改失败数据")).toBeTruthy());
}
it("corrects all marked cells in place and imports only failed records while retaining numeric zero", async () => {
  const f = await fixture(false, false, false, true);
  await validatedImport([
    ["成功", 2],
    ["原值", -1],
    ["原值", 5],
  ]);
  const accepted = copy(
    f.store.data.entries.find((e) => e.values.field_name === "成功")!,
  );
  expect(f.store.data.entries).toHaveLength(2);
  button("修改失败数据").click();
  await settle();
  expect(
    document.querySelectorAll(".import-correction-table tbody tr"),
  ).toHaveLength(2);
  expect(
    document.querySelectorAll(".import-correction-table td.has-error"),
  ).toHaveLength(3);
  expect(
    document.querySelector(".import-correction-table")?.textContent,
  ).not.toContain("Excel 第 3 行");
  await editCell("Excel 第 4 行 名称", "纠错甲");
  await editCell("Excel 第 4 行 数量", "0");
  await editCell("Excel 第 5 行 名称", "成功");
  expect(
    document.querySelectorAll(".import-correction-table td.has-error"),
  ).toHaveLength(1);
  await editCell("Excel 第 5 行 名称", "纠错乙");
  expect(
    document.querySelectorAll(".import-correction-table td.has-error"),
  ).toHaveLength(0);
  button("重新导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(2));
  expect(document.querySelector(".import-result")?.textContent).toContain(
    "新增 2 条数据",
  );
  expect(f.store.data.entries).toHaveLength(4);
  expect(f.store.data.entries.find((e) => e.id === accepted.id)).toEqual(
    accepted,
  );
  expect(
    f.store.data.entries.find((e) => e.values.field_name === "纠错甲")!.values
      .field_quantity,
  ).toBe(0);
});
it("returns to the failed result only after explicitly discarding unsaved corrections", async () => {
  const f = await fixture(false, false, false, true);
  await validatedImport([["原值", 1]]);
  button("修改失败数据").click();
  await settle();
  await editCell("Excel 第 3 行 名称", "尚未导入");
  document
    .querySelector<HTMLButtonElement>(
      'dialog[aria-label="修改失败数据"] header [aria-label="关闭"]',
    )!
    .click();
  await settle();
  expect(document.querySelector(".config-discard")?.textContent).toContain(
    "修改尚未重新导入",
  );
  expect(f.closed()).toBe(0);
  button("继续修改").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>(
      '[aria-label="Excel 第 3 行 名称"]',
    )!.value,
  ).toBe("尚未导入");
  document
    .querySelector<HTMLButtonElement>(
      'dialog[aria-label="修改失败数据"] header [aria-label="关闭"]',
    )!
    .click();
  await settle();
  button("放弃修改").click();
  await settle();
  expect(button("修改失败数据")).toBeTruthy();
  expect(f.closed()).toBe(0);
  button("修改失败数据").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>(
      '[aria-label="Excel 第 3 行 名称"]',
    )!.value,
  ).toBe("原值");
  expect(f.store.data.entries).toHaveLength(1);
});
it("retains corrected cells when persistence fails and retries without duplicating the accepted rows", async () => {
  const f = await fixture(false, false, false, true);
  await validatedImport([
    ["成功", 2],
    ["原值", 1],
  ]);
  button("修改失败数据").click();
  await settle();
  await editCell("Excel 第 4 行 名称", "修正");
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("quota");
  });
  button("重新导入").click();
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')).toBeTruthy(),
  );
  expect(f.saves()).toBe(1);
  expect(f.store.data.entries).toHaveLength(2);
  expect(
    document.querySelector<HTMLInputElement>(
      '[aria-label="Excel 第 4 行 名称"]',
    )!.value,
  ).toBe("修正");
  save.mockRestore();
  button("重新导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(2));
  expect(f.store.data.entries).toHaveLength(3);
  expect(
    f.store.data.entries.filter((e) => e.values.field_name === "成功"),
  ).toHaveLength(1);
});
it.each([29, 30])(
  "offers online correction only below 30 failed records (%i errors)",
  async (count) => {
    const f = await fixture(false, false, false, true);
    const checkbox = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'dialog input[type="checkbox"]',
      ),
    ).find((node) =>
      node.parentElement?.textContent?.includes("导入触发数据校验"),
    )!;
    checkbox.click();
    await upload(Array.from({ length: count }, () => ["原值", 1]));
    button("下一步").click();
    await settle();
    button("导入").click();
    await vi.waitFor(() => expect(f.saves()).toBe(1));
    expect(!!button("修改失败数据")).toBe(count < 30);
    expect(button("下载错误报告")).toBeTruthy();
    expect(f.store.data.entries).toHaveLength(1);
  },
);
it("does not offer failed-row correction for format warnings on successfully imported data", async () => {
  const f = await fixture();
  await upload([["格式提醒", "bad"]]);
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(button("修改失败数据")).toBeUndefined();
  expect(button("下载导入结果")).toBeTruthy();
  expect(
    f.store.data.entries.find((e) => e.values.field_name === "格式提醒")!.values
      .field_quantity,
  ).toBeNull();
});
it("uses the existing organization pickers inside correction cells and returns focus to the correction layer", async () => {
  const f = await fixture(false, false, false, false, true);
  await upload(
    [["纠错组织", "找不到成员", "找不到部门"]],
    ["field_name", "owner", "department"],
    ["名称", "负责人", "部门"],
  );
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(button("修改失败数据")).toBeTruthy());
  button("修改失败数据").click();
  await settle();
  expect(
    document.querySelectorAll(".import-correction-table td.has-error"),
  ).toHaveLength(2);
  const owner = document.querySelector<HTMLButtonElement>(
    '[aria-label="Excel 第 3 行 负责人"]',
  )!;
  expect(owner.textContent).toContain("找不到成员");
  owner.click();
  await settle();
  const picker = document.querySelector<HTMLDialogElement>(
    'dialog[aria-label="Excel 第 3 行 负责人"]',
  )!;
  expect(
    document.querySelector<HTMLElement>('dialog[aria-label="修改失败数据"]')
      ?.inert,
  ).toBe(true);
  picker.querySelector<HTMLInputElement>('[aria-label="选择张三"]')!.click();
  await settle();
  button("确定").click();
  await settle();
  expect(
    document.querySelector('dialog[aria-label="Excel 第 3 行 负责人"]'),
  ).toBeNull();
  document
    .querySelector<HTMLButtonElement>('[aria-label="Excel 第 3 行 部门"]')!
    .click();
  await settle();
  document
    .querySelector<HTMLInputElement>(
      'dialog[aria-label="Excel 第 3 行 部门"] .picker-result input',
    )!
    .click();
  await settle();
  button("确定").click();
  await settle();
  expect(
    document.querySelectorAll(".import-correction-table td.has-error"),
  ).toHaveLength(0);
  button("重新导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(2));
  expect(
    f.store.data.entries.find((e) => e.values.field_name === "纠错组织")!
      .values,
  ).toMatchObject({ owner: "zhang" });
});
it("retries a failed mixed-mode row against its own successful update baseline", async () => {
  const f = await fixture();
  await select("导入模式", "both");
  const checkbox = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'dialog input[type="checkbox"]',
    ),
  ).find((node) =>
    node.parentElement?.textContent?.includes("导入触发数据校验"),
  )!;
  checkbox.click();
  await upload(
    [
      [f.entry.id, "自身成功", 1],
      [f.entry.id, "自身修正", -1],
    ],
    ["data_id", "field_name", "field_quantity"],
    ["data_id", "名称", "数量"],
  );
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(f.entry.values.field_name).toBe("自身成功");
  button("修改失败数据").click();
  await settle();
  await editCell("Excel 第 4 行 数量", "0");
  button("重新导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(2));
  expect(f.store.data.entries).toHaveLength(1);
  expect(f.store.data.entries[0]!.values).toMatchObject({
    field_name: "自身修正",
    field_quantity: 0,
  });
  expect(
    f.store.data.entries[0]!.history.filter((h) =>
      h.action.includes("导入更新"),
    ),
  ).toHaveLength(2);
});
it("retains correction inputs after another editor changes the target and requires a recheck", async () => {
  const f = await fixture();
  await select("导入模式", "update");
  const checkbox = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'dialog input[type="checkbox"]',
    ),
  ).find((node) =>
    node.parentElement?.textContent?.includes("导入触发数据校验"),
  )!;
  checkbox.click();
  await upload(
    [[f.entry.id, -1]],
    ["data_id", "field_quantity"],
    ["data_id", "数量"],
  );
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  button("修改失败数据").click();
  await settle();
  await editCell("Excel 第 3 行 数量", "0");
  const other = useWorkspaceStore(createPinia());
  const target = other.data.entries.find((e) => e.id === f.entry.id)!;
  expect(
    await other.batchUpdateEntries(
      f.form.id,
      [
        {
          id: target.id,
          definitionVersion: target.definitionVersion,
          values: copy(target.values),
        },
      ],
      { fieldId: "field_quantity", mode: "fixed", value: 6 },
    ),
  ).toBe(true);
  button("重新导入").click();
  await vi.waitFor(() => expect(button("重新核对最新数据")).toBeTruthy());
  expect(f.saves()).toBe(1);
  expect(
    document.querySelector<HTMLInputElement>(
      '[aria-label="Excel 第 3 行 数量"]',
    )!.value,
  ).toBe("0");
  button("重新核对最新数据").click();
  await settle();
  button("重新导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(2));
  expect(f.store.data.entries[0]!.values.field_quantity).toBe(0);
});
it("corrects merged child cells by physical row without copying a previous child into blank Excel rows", async () => {
  const f = await fixture(true);
  Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'dialog input[type="checkbox"]',
    ),
  )
    .find((node) =>
      node.parentElement?.textContent?.includes("导入触发数据校验"),
    )!
    .click();
  await upload(
    [
      ["订单", "甲", -1],
      [null, null, null],
      [null, "乙", 99],
      ["成功", "丙", 0],
    ],
    ["field_name", "item", "qty"],
    ["名称", "明细商品", "明细数量"],
    [{ s: { r: 1, c: 0 }, e: { r: 3, c: 0 } }],
  );
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  button("修改失败数据").click();
  await settle();
  expect(
    document.querySelectorAll(".import-correction-table tbody tr"),
  ).toHaveLength(3);
  expect(
    document.querySelector<HTMLInputElement>(
      '[aria-label="Excel 第 4 行 订单明细 · 商品"]',
    )!.value,
  ).toBe("");
  expect(
    document.querySelector<HTMLInputElement>(
      '[aria-label="Excel 第 4 行 订单明细 · 数量"]',
    )!.value,
  ).toBe("");
  await editCell("Excel 第 3 行 名称", "纠错单");
  await editCell("Excel 第 3 行 订单明细 · 数量", "0");
  await editCell("Excel 第 5 行 订单明细 · 数量", "2");
  expect(
    document.querySelectorAll(".import-correction-table td.has-error"),
  ).toHaveLength(0);
  button("重新导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(2));
  expect(f.store.data.entries).toHaveLength(3);
  expect(
    f.store.data.entries.find((e) => e.values.field_name === "纠错单")!.values
      .items,
  ).toEqual([
    { item: "甲", qty: 0 },
    { item: "乙", qty: 2 },
  ]);
});
it("keeps corrected member inputs through permission revocation, restoring them only after access and an explicit recheck", async () => {
  const f = await fixture(false, false, true);
  await select("导入模式", "update");
  await upload(
    [[f.entry.id, "长".repeat(201)]],
    ["data_id", "field_name"],
    ["data_id", "名称"],
  );
  button("下一步").click();
  await settle();
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  button("修改失败数据").click();
  await settle();
  await editCell("Excel 第 3 行 名称", "保留修正");
  const access = copy(f.store.data.formAccess![f.form.id]!);
  access.groups[0]!.fields.field_name = "read";
  const other = useWorkspaceStore(createPinia());
  expect(await other.saveFormAccess(f.form.id, access)).toBe(true);
  button("重新导入").click();
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "导入权限",
    ),
  );
  expect(f.saves()).toBe(1);
  expect(
    document.querySelector('[aria-label="Excel 第 3 行 名称"]'),
  ).toBeNull();
  expect(f.store.data.entries[0]!.values.field_name).toBe("原值");
  access.groups[0]!.fields.field_name = "edit";
  expect(await other.saveFormAccess(f.form.id, access)).toBe(true);
  button("重新核对最新数据").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>(
      '[aria-label="Excel 第 3 行 名称"]',
    )!.value,
  ).toBe("保留修正");
  button("重新导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(2));
  expect(f.store.data.entries[0]!.values.field_name).toBe("保留修正");
});
it("reads actual Excel bytes, hides template IDs, auto-matches renamed labels and imports zero", async () => {
  const f = await fixture();
  await upload([["导入", 0]]);
  expect(document.querySelector(".import-table")?.textContent).not.toContain(
    "field_name",
  );
  button("下一步").click();
  await settle();
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="第 1 列匹配字段"]')
      ?.value,
  ).toBe("field_name");
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(
    f.store.data.entries.find((e) => e.values.field_name === "导入")?.values
      .field_quantity,
  ).toBe(0);
  expect(document.querySelector("dialog")?.textContent).toContain(
    "数据导入完成",
  );
  button("完成").click();
  await settle();
  expect(f.closed()).toBe(1);
});
it("uses the admin validation checkbox for duplicate Excel values in both preview and commit", async () => {
  const f = await fixture(false, false, false, true);
  const checkbox = () =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'dialog input[type="checkbox"]',
      ),
    ).find((node) =>
      node.parentElement?.textContent?.includes("导入触发数据校验"),
    )!;
  expect(checkbox().checked).toBe(false);
  checkbox().click();
  await settle();
  await upload([
    ["原值", 0],
    ["原值", 1],
  ]);
  button("下一步").click();
  await settle();
  expect(document.querySelector(".import-counts")?.textContent).toContain(
    "新增 0 条",
  );
  expect(document.querySelector(".import-counts")?.textContent).toContain(
    "失败 2 条",
  );
  for (const checked of [false, true, false]) {
    button("上一步").click();
    await settle();
    button("上一步").click();
    await settle();
    checkbox().click();
    expect(checkbox().checked).toBe(checked);
    button("下一步").click();
    await settle();
    button("下一步").click();
    await settle();
    expect(document.querySelector(".import-counts")?.textContent).toContain(
      `新增 ${checked ? 0 : 2} 条`,
    );
  }
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(
    f.store.data.entries.filter((e) => e.values.field_name === "原值"),
  ).toHaveLength(3);
});

it("shows both header rows and merged parents, then imports each physical detail exactly once", async () => {
  const f = await fixture(true);
  const layout = importExcelLayout(
    recordImportColumns(
      f.store.data.forms.find((form) => form.id === f.form.id)!.published!
        .schema,
    ),
  );
  const bytes = await excelBytes(
    [...layout.headers, ["订单一", 5, "甲", 0], [null, null, "乙", 2]],
    layout.fieldIds,
    [
      ...layout.merges,
      { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } },
      { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } },
    ],
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{ name: "子表.xlsx", arrayBuffer: async () => bytes }],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(button("下一步")).toBeTruthy());
  expect(
    document.querySelector('.import-table [rowspan="2"]')?.textContent,
  ).toContain("名称");
  expect(
    document.querySelector('.import-table [colspan="2"]')?.textContent,
  ).toContain("订单明细");
  button("下一步").click();
  await settle();
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="第 4 列匹配字段"]')
      ?.value,
  ).toBe("qty");
  expect(document.querySelector("dialog")?.textContent).toContain(
    "订单明细 · 商品",
  );
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(
    f.store.data.entries.find((e) => e.values.field_name === "订单一")?.values
      .items,
  ).toEqual([
    { item: "甲", qty: 0 },
    { item: "乙", qty: 2 },
  ]);
  expect(f.store.data.entries).toHaveLength(2);
});
it("places the source-key selector under a relation column, retains it across steps and saves the actual link", async () => {
  const f = await fixture(false, true);
  await upload(
    [["联系人", "甲公司"]],
    ["field_name", "customer"],
    ["名称", "关联客户"],
  );
  button("下一步").click();
  await settle();
  expect(button("导入").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "主表匹配字段",
  );
  const key = document.querySelector<HTMLSelectElement>(
    '[aria-label="第 2 列关联匹配字段"]',
  )!;
  expect(
    key.parentElement?.querySelector('[aria-label="第 2 列匹配字段"]'),
  ).toBeTruthy();
  expect([...key.options].map((o) => o.textContent)).toEqual([
    "请选择匹配字段",
    "客户信息-客户名称",
    "客户信息-客户编号",
  ]);
  await select("第 2 列关联匹配字段", "clientName");
  expect(button("导入").disabled).toBe(false);
  button("上一步").click();
  await settle();
  button("下一步").click();
  await settle();
  expect(
    document.querySelector<HTMLSelectElement>(
      '[aria-label="第 2 列关联匹配字段"]',
    )?.value,
  ).toBe("clientName");
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  const source = f.store.data.entries.find((e) => e.formId === f.sourceId)!;
  expect(
    f.store.data.entries.find((e) => e.values.field_name === "联系人")!.values
      .customer,
  ).toBe(source.id);
});
it("fails a relation row when another tab creates a duplicate source after preview, keeping the imported file in the result", async () => {
  const f = await fixture(false, true);
  await upload(
    [["联系人", "甲公司"]],
    ["field_name", "customer"],
    ["名称", "关联客户"],
  );
  button("下一步").click();
  await settle();
  await select("第 2 列关联匹配字段", "clientName");
  const other = useWorkspaceStore(createPinia());
  expect(
    await other.submitEntry(f.sourceId, {
      clientName: "甲公司",
      clientCode: "C-NEW",
    }),
  ).toBeTruthy();
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(
    f.store.data.entries.some((e) => e.values.field_name === "联系人"),
  ).toBe(false);
  expect(document.querySelector("dialog")?.textContent).toContain(
    "多条主表数据",
  );
  expect(button("下载错误报告")).toBeTruthy();
});
it("keeps the file when returning to settings and requires explicit dismissal before abandoning it", async () => {
  const f = await fixture();
  await upload([["导入", 0]]);
  button("上一步").click();
  await settle();
  expect(document.querySelector("dialog")?.textContent).toContain(
    "已选择 实际模板.xlsx",
  );
  button("下一步").click();
  await settle();
  button("下一步").click();
  await settle();
  document
    .querySelector<HTMLButtonElement>('dialog [aria-label="关闭"]')!
    .click();
  await settle();
  expect(f.closed()).toBe(0);
  expect(document.querySelector("dialog")?.textContent).toContain(
    "文件尚未导入",
  );
  button("继续导入").click();
  await settle();
  expect(f.store.data.entries).toHaveLength(1);
  document
    .querySelector<HTMLButtonElement>('dialog [aria-label="关闭"]')!
    .click();
  await settle();
  button("放弃导入").click();
  await settle();
  expect(f.closed()).toBe(1);
  expect(f.store.data.entries).toHaveLength(1);
});
it("makes unmapped update IDs visible and recovers by choosing the ID column without reselecting the file", async () => {
  const f = await fixture();
  await select("导入模式", "update");
  await upload(
    [[f.entry.id, 0]],
    ["wrong", "field_quantity"],
    ["记录", "数量"],
  );
  button("下一步").click();
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "data_id",
  );
  expect(button("导入").disabled).toBe(true);
  await select("第 1 列匹配字段", "data_id");
  expect(button("导入").disabled).toBe(false);
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(f.entry.values).toEqual({ field_name: "原值", field_quantity: 0 });
});
it("preserves file and mapping on a real concurrent edit, then saves only after an explicit recheck", async () => {
  const f = await fixture();
  await select("导入模式", "update");
  await upload(
    [[f.entry.id, 0]],
    ["data_id", "field_quantity"],
    ["data_id", "数量"],
  );
  button("下一步").click();
  await settle();
  const other = useWorkspaceStore(createPinia()),
    target = other.data.entries.find((e) => e.id === f.entry.id)!;
  expect(
    await other.batchUpdateEntries(
      f.form.id,
      [
        {
          id: target.id,
          definitionVersion: target.definitionVersion,
          values: copy(target.values),
        },
      ],
      { fieldId: "field_quantity", mode: "fixed", value: 6 },
    ),
  ).toBe(true);
  button("导入").click();
  await vi.waitFor(() => expect(button("重新核对最新数据")).toBeTruthy());
  expect(f.saves()).toBe(0);
  expect(button("导入").disabled).toBe(true);
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="第 1 列匹配字段"]')
      ?.value,
  ).toBe("data_id");
  button("重新核对最新数据").click();
  await settle();
  expect(
    f.store.data.entries.find((e) => e.id === f.entry.id)?.values
      .field_quantity,
  ).toBe(6);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "已读取最新数据",
  );
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(
    f.store.data.entries.find((e) => e.id === f.entry.id)?.values
      .field_quantity,
  ).toBe(0);
  expect(f.store.data.entries).toHaveLength(1);
});
it("reuses the import dialog for members, offers two modes and omits readonly columns from update mapping", async () => {
  const f = await fixture(false, false, true);
  expect(
    Array.from(document.querySelectorAll('[aria-label="导入模式"] option')).map(
      (x) => x.getAttribute("value"),
    ),
  ).toEqual(["create", "update"]);
  expect(document.querySelector("dialog")?.textContent).not.toContain(
    "导入触发数据校验",
  );
  await select("导入模式", "update");
  await upload(
    [[f.entry.id, "成员更新", 999]],
    ["data_id", "field_name", "field_quantity"],
    ["data_id", "名称", "数量"],
  );
  button("下一步").click();
  await settle();
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="第 3 列匹配字段"]')!
      .value,
  ).toBe("");
  button("导入").click();
  await vi.waitFor(() => expect(f.saves()).toBe(1));
  expect(f.entry.values).toMatchObject({
    field_name: "成员更新",
    field_quantity: 2,
  });
});
it("keeps a member's Excel and mappings after revoked field permissions and permits a deliberate recheck", async () => {
  const f = await fixture(false, false, true);
  await select("导入模式", "update");
  await upload(
    [[f.entry.id, "成员更新"]],
    ["data_id", "field_name"],
    ["data_id", "名称"],
  );
  button("下一步").click();
  await settle();
  const access = copy(f.store.data.formAccess![f.form.id]!);
  access.groups[0]!.fields.field_name = "read";
  await useWorkspaceStore(createPinia()).saveFormAccess(f.form.id, access);
  button("导入").click();
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "导入权限",
    ),
  );
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(f.saves()).toBe(0);
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="第 2 列匹配字段"]')!
      .value,
  ).toBe("field_name");
  expect(document.querySelector("dialog")?.textContent).toContain("成员更新");
  expect(button("重新核对最新数据")).toBeTruthy();
  button("重新核对最新数据").click();
  await settle();
  expect(
    document.querySelector('[aria-label="第 2 列匹配字段"]')?.textContent,
  ).not.toContain("名称");
  expect(f.entry.values.field_name).toBe("原值");
});
