import { seedWorkspace } from "./fixtures/workspace";
import { expect, it } from "vitest";
import * as xlsx from "xlsx";
import { excelBytes, readExcel } from "../src/services/excel";
import {
  suggestImportMapping,
  recognizeImportTemplate,
  importExcelValue,
} from "../src/domain/recordImport";
import { emptySchema, createField } from "../src/domain/form";

it("roundtrips standard templates with hidden IDs, renamed and duplicate labels, zero and literal formula-looking text", async () => {
  const bytes = await excelBytes(
    [
      ["旧名称", "同名", "同名"],
      ['=HYPERLINK("https://example.com")', 0, "正常"],
    ],
    ["name", "quantity", "other"],
  );
  const [sheet] = await readExcel(bytes, "模板.xlsx");
  expect(sheet?.fieldIds).toEqual(["name", "quantity", "other"]);
  expect(sheet?.headerRow).toBe(1);
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "name", label: "改名" }),
    createField("number", { id: "quantity", label: "同名" }),
    createField("text", { id: "other", label: "同名" }),
  ];
  expect(suggestImportMapping(sheet!, sheet!.headerRow, schema)).toEqual([
    "name",
    "quantity",
    "other",
  ]);
  expect(sheet?.rows[2]).toEqual([
    '=HYPERLINK("https://example.com")',
    0,
    "正常",
  ]);
  expect(xlsx.read(bytes, { type: "array" }).Sheets.数据!.A3.f).toBeUndefined();
});
it("reads real legacy xls, multiple worksheets, formatted civil dates and cached formula results", async () => {
  const book = xlsx.utils.book_new(),
    one = xlsx.utils.aoa_to_sheet([
      ["日期", "数量"],
      [0, 42],
    ]);
  one.A2 = { t: "n", v: 46023, z: "yyyy-mm-dd" };
  one.B2 = { t: "n", v: 42, f: "6*7" };
  one.C1 = { t: "s", v: "错误" };
  one.C2 = { t: "e", v: 7 };
  one["!ref"] = "A1:C2";
  xlsx.utils.book_append_sheet(book, one, "一");
  xlsx.utils.book_append_sheet(
    book,
    xlsx.utils.aoa_to_sheet([["标题"], ["内容"]]),
    "二",
  );
  const sheets = await readExcel(
    xlsx.write(book, { type: "array", bookType: "xls" }),
    "旧文件.xls",
  );
  expect(sheets.map((s) => s.name)).toEqual(["一", "二"]);
  expect(sheets[0]?.rows[1]).toEqual(["2026-01-01T00:00:00", 42, "#DIV/0!"]);
});
it("does not guess ambiguous labels or reuse unrelated hidden IDs", () => {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "a", label: "同名" }),
    createField("text", { id: "b", label: "同名" }),
  ];
  expect(
    suggestImportMapping(
      { name: "数据", rows: [["data_id", "同名"]], headerRow: 0 },
      0,
      schema,
    ),
  ).toEqual(["data_id", ""]);
  expect(
    suggestImportMapping(
      {
        name: "数据",
        rows: [
          ["data_id", "foreign"],
          ["data_id", "同名"],
        ],
        fieldIds: ["data_id", "foreign"],
        headerRow: 1,
      },
      1,
      schema,
    ),
  ).toEqual(["data_id", ""]);
});

it("does not silently split a multiple-choice label containing the Excel import delimiter", () => {
  const data = seedWorkspace(),
    field = createField("multiselect", {
      id: "choice",
      label: "类别",
      options: [{ id: "a", label: "甲,乙" }],
    });
  const entry = {
    id: "e",
    formId: "f",
    definitionVersion: 1,
    createdAt: "2026-10-10",
    status: "submitted" as const,
    values: { choice: ["a"] },
    history: [],
  };
  expect(() => importExcelValue(field, entry, data)).toThrow("名称含逗号");
});
it("retains exact template identity after an xls converter loses the hidden row flag", async () => {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "field_name", label: "新名称" }),
    createField("number", { id: "field_quantity", label: "数量" }),
  ];
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(
    book,
    xlsx.utils.aoa_to_sheet([
      ["data_id", "field_name", "field_quantity"],
      ["data_id", "旧名称", "数量"],
      ["entry_a", "更新", 0],
    ]),
    "数据",
  );
  const [sheet] = await readExcel(
    xlsx.write(book, { type: "array", bookType: "xls" }),
    "转换.xls",
  );
  const matched = recognizeImportTemplate(sheet!, schema);
  expect(matched.headerRow).toBe(1);
  expect(suggestImportMapping(matched, 1, schema)).toEqual([
    "data_id",
    "field_name",
    "field_quantity",
  ]);
  expect(matched.rows[2]).toEqual(["entry_a", "更新", 0]);
});
it("rejects wrong formats, oversize files and excessive ranges, and retains merged rows for record grouping", async () => {
  await expect(
    readExcel(new TextEncoder().encode("编号,数量\nC,0").buffer, "伪装.xlsx"),
  ).rejects.toThrow("有效的 Excel");
  await expect(
    readExcel(new ArrayBuffer(3 * 1024 * 1024), "大文件.xlsx"),
  ).rejects.toThrow("2MB");
  const book = xlsx.utils.book_new(),
    sheet = xlsx.utils.aoa_to_sheet([
      ["编号", "数量"],
      ["C", 0],
      ["D", 1],
    ]);
  sheet["!merges"] = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }];
  xlsx.utils.book_append_sheet(book, sheet, "明细");
  const [detail] = await readExcel(
    xlsx.write(book, { type: "array", bookType: "xlsx" }),
    "明细.xlsx",
  );
  expect(detail!.merges).toEqual(sheet["!merges"]);
  sheet["!merges"] = [];
  sheet["!ref"] = "A1:SG2";
  await expect(
    readExcel(
      xlsx.write(book, { type: "array", bookType: "xlsx" }),
      "超列.xlsx",
    ),
  ).rejects.toThrow("500 列");
  sheet["!ref"] = "A1:A100003";
  sheet["A100003"] = { t: "n", v: 0 };
  const [limit] = await readExcel(
    xlsx.write(book, { type: "array", bookType: "xlsx" }),
    "十万明细.xlsx",
  );
  expect(limit!.rows).toHaveLength(100003); // hidden IDs + two headers + 100,000 physical data rows
  sheet["!ref"] = "A1:A100004";
  sheet["A100004"] = { t: "n", v: 0 };
  await expect(
    readExcel(
      xlsx.write(book, { type: "array", bookType: "xlsx" }),
      "超过十万.xlsx",
    ),
  ).rejects.toThrow("10 万");
});
