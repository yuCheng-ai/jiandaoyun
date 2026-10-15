import { seedWorkspace } from "./fixtures/workspace";
import { describe, expect, it } from "vitest";

import { createField, emptySchema } from "../src/domain/form";
import {
  buildRecordBlocks,
  defaultDetailSettings,
  newPrintTemplate,
  parseDetailSettings,
  parsePrintTemplates,
  presentationFields,
  printTemplateIssues,
  printTemplateReferences,
} from "../src/domain/presentation";
import { parseExtensions } from "../src/domain/extensions";
import { newForm } from "../src/domain/workspace";
function sample() {
  const schema = emptySchema();
  const tabs = createField("tabs", {
    id: "tabs",
    children: [createField("text", { id: "name", label: "名称" })],
  });
  const rows = createField("subform", {
    id: "items",
    label: "明细",
    children: [
      createField("text", { id: "item", label: "物品" }),
      createField("number", { id: "count", label: "数量" }),
    ],
  });
  schema.fields = [
    tabs,
    createField("number", { id: "total", label: "合计" }),
    rows,
    createField("text", { id: "blank", label: "空字段" }),
  ];
  const values = {
    name: "采购单",
    total: 0,
    items: [
      { item: "纸张", count: 2 },
      { item: "笔", count: 0 },
    ],
    blank: "",
  };
  return { schema, values, data: seedWorkspace() };
}
describe("record presentation and print templates", () => {
  it("migrates missing configs and normalizes imported layout values", () => {
    expect(parseExtensions(undefined)).toEqual({ webhooks: [] });
    expect(
      parseDetailSettings({ columns: 7, fieldIds: ["x", "x", 42] }),
    ).toEqual({ ...defaultDetailSettings(), fieldIds: ["x"] });
    expect(() => parsePrintTemplates([{ id: "a" }, { id: "a" }])).toThrow();
    const template = parsePrintTemplates([
      {
        id: "a",
        paper: "<style>",
        orientation: "wide",
        fontSize: 999,
        fieldMode: "custom",
      },
    ])[0]!;
    expect([template.paper, template.orientation, template.fontSize]).toEqual([
      "A4",
      "portrait",
      14,
    ]);
    expect(template.fileName).toBeUndefined();
  });
  it("orders fields by stable IDs, flattens tabs but preserves subform row scope and zeroes", () => {
    const { schema, values, data } = sample();
    expect(presentationFields(schema).map((f) => f.id)).toEqual([
      "name",
      "total",
      "items",
      "blank",
    ]);
    const settings = {
      ...defaultDetailSettings(),
      fieldMode: "custom" as const,
      fieldIds: ["items", "total", "blank"],
      hideEmpty: true,
    };
    const blocks = buildRecordBlocks(schema, values, settings, data);
    expect(blocks.map((b) => b.id)).toEqual(["items", "total"]);
    expect(blocks[0]!.headers).toEqual(["物品", "数量"]);
    expect(blocks[0]!.rows).toEqual([
      ["纸张", "2"],
      ["笔", "0"],
    ]);
    expect(blocks[1]!.text).toBe("0");
  });
  it("respects hidden containers and row visibility rules without modifying original values", () => {
    const { schema, values, data } = sample();
    schema.fields[0]!.visible = false;
    schema.settings.rules = [
      {
        id: "r",
        sourceId: "count",
        operator: "greater",
        value: "0",
        targetIds: ["item"],
      },
    ];
    const blocks = buildRecordBlocks(
      schema,
      values,
      defaultDetailSettings(),
      data,
    );
    expect(blocks.some((b) => b.id === "name")).toBe(false);
    expect(blocks.find((b) => b.id === "items")!.rows).toEqual([
      ["纸张", "2"],
      ["—", "0"],
    ]);
    expect(values.items[1]!.item).toBe("笔");
  });
  it("renders labels and selected relation rows even if current filters no longer match", () => {
    const { schema, values, data } = sample();
    const source = newForm("oa", "商品");
    source.schema.fields = [
      createField("text", { id: "product", label: "商品名称" }),
    ];
    data.forms.push(source);
    data.entries.push({
      id: "r1",
      formId: source.id,
      definitionVersion: 1,
      values: { product: "打印纸" },
      status: "submitted",
      history: [],
      createdAt: "",
    });
    const relation = createField("relationTable", {
      id: "related",
      referenceFormId: source.id,
    });
    relation.reference.columns = ["product"];
    relation.reference.filters = [
      {
        id: "filter",
        sourceFieldId: "product",
        operator: "equals",
        source: "constant",
        value: "已过期的筛选",
      },
    ];
    schema.fields.push(
      relation,
      createField("select", {
        id: "choice",
        options: [{ id: "o1", label: "选项名称" }],
      }),
    );
    const blocks = buildRecordBlocks(
      schema,
      { ...values, related: ["r1"], choice: "o1" },
      defaultDetailSettings(),
      data,
    );
    expect(blocks.find((b) => b.id === "related")!.rows).toEqual([["打印纸"]]);
    expect(blocks.find((b) => b.id === "choice")!.text).toBe("选项名称");
  });
  it("only embeds locally stored raster image previews", () => {
    const { schema, values, data } = sample();
    schema.fields = [
      createField("image", { id: "image" }),
      createField("signature", { id: "sign" }),
    ];
    const blocks = buildRecordBlocks(
      schema,
      {
        ...values,
        image: [
          { name: "外链", preview: "https://example.com/x.png" },
          { name: "本地", preview: "data:image/png;base64,aGVsbG8=" },
        ],
        sign: "data:image/svg+xml;base64,evil",
      },
      defaultDetailSettings(),
      data,
    );
    expect(blocks[0]!.images).toEqual(["data:image/png;base64,aGVsbG8="]);
    expect(blocks[1]!.images).toEqual([]);
  });
  it("keeps child images and signatures in their own rows, excluding row-hidden images and remote or SVG previews", () => {
    const { schema, data } = sample();
    const preview = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    schema.fields = [
      createField("subform", {
        id: "lines",
        children: [
          createField("text", { id: "gate" }),
          createField("image", { id: "photo" }),
          createField("signature", { id: "sign" }),
        ],
      }),
    ];
    schema.settings.rules = [
      {
        id: "image_rule",
        sourceId: "gate",
        operator: "equals",
        value: "show",
        targetIds: ["photo"],
      },
    ];
    const image = {
      id: "image",
      name: "本地.gif",
      type: "image/gif",
      size: 1,
      preview,
    };
    const blocks = buildRecordBlocks(
      schema,
      {
        lines: [
          {
            gate: "show",
            photo: [image, { ...image, preview: "https://example.test/x.png" }],
            sign: "data:image/png;base64,AQ==",
          },
          {
            gate: "hide",
            photo: [image],
            sign: "data:image/svg+xml;base64,evil",
          },
        ],
      },
      defaultDetailSettings(),
      data,
    );
    expect(blocks[0]!.rowImages).toEqual([
      [[], [preview], ["data:image/png;base64,AQ=="]],
      [[], [], []],
    ]);
    expect(blocks[0]!.rowFiles![1]![1]).toBeUndefined();
  });
  it("round-trips configured presentation without adding it to unconfigured old forms", () => {
    const data = seedWorkspace(),
      form = data.forms[0]!;
    form.extensions = {
      webhooks: [],
      printTemplates: [newPrintTemplate(form.schema, form.title)],
      detail: defaultDetailSettings(),
    };
    expect(parseExtensions(form.extensions)).toEqual(form.extensions);
    expect(parseExtensions(data.forms[1]!.extensions)).toEqual({
      webhooks: [],
    });
  });
  it("validates custom file names without counting stable ID lengths as customer text, or discarding inactive naming drafts", () => {
    const { schema } = sample();
    const template = newPrintTemplate(schema, "单据");
    template.fileName = { mode: "custom", value: "合同-{{name}}-{{total}}" };
    expect(printTemplateIssues(template, schema)).toEqual([]);
    expect(
      printTemplateReferences({ ...template, fieldMode: "all" }, schema),
    ).toEqual(["name", "total"]);
    for (const [value, message] of [
      ["", "请填写"],
      ["名".repeat(51), "50 个字符"],
      ["{{name}}".repeat(11), "10 个字段"],
      ["单据/{{name}}", "不能包含"],
      ["单据 {{name}}", "不能包含"],
      ["{{missing}}", "已失效"],
      ["{{item}}", "已失效"],
      ["单据-{{name}", "不完整"],
    ]) {
      template.fileName.value = value!;
      expect(printTemplateIssues(template, schema).join("；"), value).toContain(
        message,
      );
    }
    template.fileName.value = "名".repeat(49) + "{{name}}";
    expect(printTemplateIssues(template, schema)).toEqual([]);
    template.fileName.mode = "title";
    template.fileName.value = "未完成/{{missing}}";
    expect(printTemplateIssues(template, schema)).toEqual([]);
    expect(parsePrintTemplates([template])[0]!.fileName).toEqual(
      template.fileName,
    );
  });
});
