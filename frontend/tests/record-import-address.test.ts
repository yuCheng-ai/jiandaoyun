import { expect, it } from "vitest";
import { addressParts } from "@platform/contracts";
import { createField, copy, emptySchema } from "../src/domain/form";
import { emptyWorkspace, newForm } from "../src/domain/workspace";
import {
  recordImportColumns,
  importFieldKey,
  importExcelLayout,
  suggestImportMapping,
  recognizeImportTemplate,
  prepareImportRows,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import { excelBytes, readExcel, type ExcelValue } from "../src/services/excel";

function fixture() {
  const data = emptyWorkspace();
  const form = newForm("oa", "地址导入解析");
  form.schema.fields = [
    createField("text", { id: "name", label: "名称" }),
    createField("address", { id: "address", label: "收货地址" }),
    createField("subform", {
      id: "items",
      label: "明细",
      children: [
        createField("text", { id: "item", label: "商品" }),
        createField("address", { id: "destination", label: "送达地址" }),
      ],
    }),
  ];
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-10",
  };
  form.versions = [form.published];
  data.forms = [form];
  const request = (
    rows: ExcelValue[][],
    keys?: string[],
    extra: Partial<RecordImportRequest> = {},
  ): RecordImportRequest => {
    const cols = recordImportColumns(form.published!.schema);
    return {
      mode: "create",
      definitionVersion: form.published!.version,
      rows,
      firstRow: 3,
      validate: true,
      triggerWorkflow: false,
      targets: [],
      mapping: (
        keys || [
          "name",
          ...addressParts(form.published!.schema.fields[1]!).map((p) =>
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

  return { data, form, request };
}

it("writes independent address-part IDs and source column labels for all four precisions, preserving renamed and ambiguous fields", async () => {
  const schema = emptySchema();
  schema.fields = ["province", "city", "district", "detail"].map((format, i) =>
    createField("address", { id: `a${i}`, label: "同名", format }),
  );
  const cols = recordImportColumns(schema),
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

it("rejects duplicate parts, forged parts on other fields, misplaced children and malformed data IDs", () => {
  const f = fixture(),
    input = f.request(
      [["江苏省", "江苏省"]],
      ["address.province", "address.city"],
    );
  expect(() =>
    prepareImportRows(
      f.form,
      {
        ...input,
        mapping: input.mapping.map((m) => ({ ...m, addressPart: "province" })),
      },
      f.data,
    ),
  ).toThrow("重复匹配");
  expect(() =>
    prepareImportRows(
      f.form,
      {
        ...input,
        mapping: [
          { column: 0, fieldId: "name", type: "text", addressPart: "province" },
        ],
      },
      f.data,
    ),
  ).toThrow("类型或子表归属");
  expect(() =>
    prepareImportRows(
      f.form,
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
      f.data,
    ),
  ).toThrow("类型或子表归属");
  expect(() =>
    prepareImportRows(
      f.form,
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
      f.data,
    ),
  ).toThrow("data_id 匹配无效");
});
