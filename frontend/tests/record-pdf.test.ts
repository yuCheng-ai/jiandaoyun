import { describe, expect, it } from "vitest";
import pdfMake from "pdfmake";
import { resolve } from "node:path";
import { createField, emptySchema } from "../src/domain/form";
import { newPrintTemplate } from "../src/domain/presentation";
import { seedWorkspace, type FormEntry } from "../src/domain/workspace";
import {
  buildRecordPdf,
  recordPdfFilename,
  recordPrintFilename,
} from "../src/domain/recordPdf";
import { newForm } from "../src/domain/workspace";
import { copy } from "../src/domain/form";

function sample() {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "name", label: "客户", defaultValue: "" }),
    createField("textarea", { id: "notes", label: "说明" }),
    createField("text", { id: "secret", label: "内部字段", visible: false }),
    createField("subform", {
      id: "items",
      label: "采购明细",
      children: Array.from({ length: 8 }, (_, i) =>
        createField("text", { id: `c${i}`, label: `明细列${i}` }),
      ),
    }),
  ];
  const entry: FormEntry = {
    id: "entry-pdf-test",
    formId: "pdf-test",
    definitionVersion: 3,
    status: "submitted",
    createdAt: "2026-10-08T08:00:00.000Z",
    values: {
      name: "中文客户",
      notes: "很长的说明\n".repeat(200),
      secret: "不得导出",
      items: Array.from({ length: 60 }, (_, row) =>
        Object.fromEntries(
          Array.from({ length: 8 }, (_, col) => [
            `c${col}`,
            `R${row + 1}C${col}`,
          ]),
        ),
      ),
    },
    history: [
      {
        label: "填写表单",
        action: "提交数据",
        time: "2026-10-08T08:00:00.000Z",
      },
    ],
  };
  return {
    schema,
    entry,
    template: newPrintTemplate(schema, "采购单"),
    title: "采购单",
    data: seedWorkspace(),
  };
}
describe("record PDF document contract", () => {
  it("uses the form name and print time, configured data title or a custom name without changing PDF content or old naming", () => {
    const input = sample();
    const before = JSON.stringify(buildRecordPdf(input));
    const now = new Date(2026, 9, 10, 6, 35, 7);
    input.template.title = "打印抬头";
    expect(recordPrintFilename(input, now)).toBe("采购单_20261010_063507.pdf");
    const form = newForm("oa", "当前表单名称");
    form.id = input.entry.formId;
    form.published = {
      version: input.entry.definitionVersion,
      title: input.title,
      schema: copy(input.schema),
      workflow: form.workflow,
      publishedAt: "",
      extensions: {
        webhooks: [],
        collaboration: {
          titleMode: "custom",
          inlineEdit: false,
          titleParts: [
            { id: "a", kind: "text", value: "原版-" },
            { id: "b", kind: "field", value: "name" },
          ],
        },
      },
    };
    input.data.forms.push(form);
    input.template.fileName = { mode: "title", value: "" };
    expect(recordPrintFilename(input, now)).toBe("原版-中文客户.pdf");
    input.template.fileName = { mode: "custom", value: "合同-{{name}}" };
    expect(recordPrintFilename(input, now)).toBe("合同-中文客户.pdf");
    input.template.title = "采购单";
    expect(JSON.stringify(buildRecordPdf(input))).toBe(before);
    delete input.template.fileName;
    expect(recordPrintFilename(input, now)).toBe("采购单-entry-pdf-test.pdf");
  });
  it("renders file name values through visible scalar fields, preserving zeroes and business labels and sanitizing unsafe record values", () => {
    const input = sample();
    input.schema.fields.push(
      createField("number", { id: "zero" }),
      createField("select", {
        id: "choice",
        options: [{ id: "option", label: "华东" }],
      }),
      createField("tabs", {
        id: "hidden_tab",
        visible: false,
        children: [createField("text", { id: "private" })],
      }),
    );
    input.entry.values = {
      name: "公司/分部 $客户",
      zero: 0,
      choice: "option",
      secret: "不可见",
      private: "私密",
    };
    input.template.fileName = {
      mode: "custom",
      value: "{{name}}-{{zero}}-{{choice}}-{{secret}}-{{private}}",
    };
    expect(recordPrintFilename(input)).toBe("公司_分部__客户-0-华东--.pdf");
    input.template.fileName.value = "{{name}}";
    input.entry.values.name = "长".repeat(80);
    expect(recordPrintFilename(input)).toBe("长".repeat(50) + ".pdf");
    input.template.fileName.value = "{{secret}}";
    expect(recordPrintFilename(input)).toBe("记录.pdf");
  });
  it.each([
    ["A4", "portrait", 595.28, 841.89],
    ["A4", "landscape", 841.89, 595.28],
    ["A5", "portrait", 419.53, 595.28],
    ["A5", "landscape", 595.28, 419.53],
  ] as const)(
    "generates a real multipage %s %s file with the packaged Chinese font",
    async (paper, orientation, width, height) => {
      const font = resolve("src/assets/fonts/NotoSansSC-Regular.otf");
      pdfMake.addFonts({
        NotoSansSC: {
          normal: font,
          bold: font,
          italics: font,
          bolditalics: font,
        },
      });
      pdfMake.setUrlAccessPolicy(() => false);
      pdfMake.setLocalAccessPolicy((path) => path === font);
      const input = sample();
      input.template.paper = paper;
      input.template.orientation = orientation;
      const buffer = await pdfMake.createPdf(buildRecordPdf(input)).getBuffer();
      const raw = buffer.toString("latin1");
      expect(raw.startsWith("%PDF-")).toBe(true);
      expect(raw).toContain(`/MediaBox [0 0 ${width} ${height}]`);
      expect((raw.match(/\/Type \/Page\b/g) || []).length).toBeGreaterThan(2);
      expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    },
    15000,
  );
  it("keeps Chinese and long content as text, uses original metadata, and excludes hidden fields", () => {
    const input = sample();
    const definition = buildRecordPdf(input);
    const text = JSON.stringify(definition.content);
    expect(text).toContain("中文客户");
    expect(text).toContain(
      JSON.stringify(input.entry.values.notes).slice(1, -1),
    );
    expect(text).toContain("V3");
    expect(text).toContain("提交数据");
    expect(text).not.toContain("不得导出");
    expect(definition.defaultStyle?.font).toBe("NotoSansSC");
  });
  it("embeds a real local image inside a child table cell while excluding remote previews", async () => {
    const input = sample();
    input.schema.fields = [
      createField("subform", {
        id: "items",
        label: "明细",
        children: [createField("image", { id: "photo", label: "凭证" })],
      }),
    ];
    input.template.fieldIds = ["items"];
    const preview =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAuklEQVR4nGP8//8/w1AGTAPtAEoBC4TiXjhtYN1BBvgan8UA9wADA8PN0NiBcwzJQH31YghjyCehUQ8MNBj1wECDIe8BFsJKiAa7blxbeOo4AwPD2UcPjeXkGRgYYk0tPDS1qWgFJqCmB9w0tNw0tBgYGIy6WpbGJVPRZDxgyCehUQ8MNBj1wECDUQ9gA+fKamhhLFYwGgMDDUY9MNBg1AMDDUY9MNBg1AMDDRA9MvhY19ACjKOj0wMMAEcyHE5F/lzKAAAAAElFTkSuQmCC";
    input.entry.values.items = [
      {
        photo: [
          {
            id: "photo",
            name: "凭证.png",
            type: "image/png",
            size: 243,
            preview,
          },
          {
            id: "remote",
            name: "外链.png",
            type: "image/png",
            size: 1,
            preview: "https://example.test/private.png",
          },
        ],
      },
    ];
    const definition = buildRecordPdf(input);
    expect(JSON.stringify(definition.content)).toContain(preview);
    expect(JSON.stringify(definition.content)).not.toContain(
      "https://example.test/private.png",
    );
    const buffer = await pdfMake.createPdf(definition).getBuffer();
    expect(buffer.toString("latin1")).toContain("/Subtype /Image");
    expect(buffer.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });
  it("retains all rows and columns in wide table groups with repeated row identifiers and headers", () => {
    const input = sample();
    input.template.paper = "A5";
    const definition = buildRecordPdf(input);
    const tables = (definition.content as any[]).filter((node) => node.table);
    expect(tables.length).toBeGreaterThan(1);
    for (const node of tables) {
      expect(node.table.headerRows).toBe(2);
      expect(node.table.dontBreakRows).toBe(false);
      expect(node.table.body).toHaveLength(62);
      expect(node.table.body[61].slice(0, 2)).toEqual(["60", "R60C0"]);
    }
    const text = JSON.stringify(tables);
    for (let row = 1; row <= 60; row++)
      for (let col = 0; col < 8; col++)
        expect(text).toContain(`"R${row}C${col}"`);
  });
  it("applies the selected template order, paper, font size, empty and history visibility", () => {
    const input = sample();
    Object.assign(input.template, {
      fieldIds: ["notes", "name"],
      paper: "A5",
      orientation: "landscape",
      columns: 1,
      fontSize: 16,
      showMetadata: false,
      showHistory: false,
      footer: "财务留存",
      subtitle: "业务交付验收",
    });
    const definition = buildRecordPdf(input),
      text = JSON.stringify(definition.content);
    expect(definition.pageSize).toBe("A5");
    expect(definition.pageOrientation).toBe("landscape");
    expect(definition.defaultStyle?.fontSize).toBe(12);
    expect(text.indexOf("说明")).toBeLessThan(text.indexOf("客户"));
    expect(text).not.toContain("采购明细");
    expect(text).not.toContain("提交数据");
    expect(text).not.toContain("记录编号");
    expect(text).toContain("财务留存");
    expect(text).toContain("业务交付验收");
    input.template.hideEmpty = true;
    input.entry.values.name = "";
    expect(JSON.stringify(buildRecordPdf(input).content)).not.toContain("客户");
  });
  it("never includes remote raster URLs or SVG content and keeps safe download filenames", () => {
    const input = sample();
    input.schema.fields = [
      createField("signature", { id: "sign", label: "签名" }),
    ];
    input.template.fieldIds = ["sign"];
    for (const source of [
      "https://example.test/private.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
    ]) {
      input.entry.values.sign = source;
      expect(JSON.stringify(buildRecordPdf(input).content)).not.toContain(
        source,
      );
    }
    expect(recordPdfFilename("../采购:订单?", "entry/1")).toBe(
      "_采购_订单_-entry_1.pdf",
    );
  });
});
