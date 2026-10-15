import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { expect, it } from "vitest";
import { copy, createField } from "../src/domain/form";
import { hasRichTextContent, sanitizeRichText } from "../src/domain/richText";
import { displayValue } from "../src/domain/relations";
import {
  defaultRecordView,
  filterAndSortRecords,
  recordExcelExport,
} from "../src/domain/records";
import {
  newForm,
  type FormEntry,
} from "../src/domain/workspace";
import { excelBytes, readExcel } from "../src/services/excel";

function fixture(value: string) {
  const data = seedWorkspace(),
    form = newForm("oa", "富文本摘要", "form");
  const field = createField("richtext", { id: "body", label: "说明" });
  form.schema.fields = [field];
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-11T00:00:00Z",
  };
  form.versions = [copy(form.published)];
  const entry: FormEntry = {
    id: "summary_record",
    formId: form.id,
    definitionVersion: 1,
    values: { body: value },
    createdAt: "2026-10-11T00:00:00Z",
    status: "submitted",
    history: [],
  };
  data.forms.push(form);
  data.entries.push(entry);
  return { data, form, field, entry };
}

it("decodes visible entities and separates paragraphs, lists and line breaks without joining words", () => {
  const { data, field } = fixture("");
  expect(
    displayValue(
      field,
      "<p>甲&nbsp;&amp;&#32;乙</p><p>第二行<br>第三行</p><ul><li>清单一</li><li>清单二</li></ul>",
      data,
    ),
  ).toBe("甲 & 乙\n第二行\n第三行\n清单一\n清单二");
  expect(displayValue(createField("text"), "<SKU>&nbsp;", data)).toBe(
    "<SKU>&nbsp;",
  );
  expect(displayValue(field, "<p>&lt;型号&gt; &amp;lt;</p>", data)).toBe(
    "<型号> &lt;",
  );
});

it("extracts only sanitized visible text, never scripts, image filenames or link targets", () => {
  const { data, field } = fixture("");
  const html =
    '<script>隐藏脚本</script><style>隐藏样式</style><p><a href="https://example.test/private-token">可见标题</a></p><img src="https://example.test/private-image" alt="隐藏文件名">';
  expect(displayValue(field, html, data)).toBe("可见标题");
  expect(sanitizeRichText(html)).toContain("<img");
});

it("keeps image-only content valid while its text-only summary and export stay empty", () => {
  const { data, field } = fixture("");
  const image =
    '<p>&nbsp;&#160;</p><img src="https://example.test/photo.png" alt="图片">';
  expect(hasRichTextContent(image)).toBe(true);
  expect(displayValue(field, image, data)).toBe("");
  expect(displayValue(field, "<p>&nbsp;</p>", data)).toBe("");
  expect(displayValue(field, undefined, data)).toBe("");
});

it("record search follows the historical field type and searches visible decoded text only", () => {
  const { data, form, entry } = fixture(
    '<p>甲&nbsp;&amp;乙</p><img src="https://example.test/private-token">',
  );
  form.schema.fields[0]!.type = "text";
  const search = (query: string) =>
    filterAndSortRecords([entry], form.schema, data, {
      query,
      filters: [],
      view: defaultRecordView(form.schema),
    });
  expect(search("甲 &乙")).toEqual([entry]);
  expect(search("private-token")).toEqual([]);
  expect(search("nbsp")).toEqual([]);
  expect(entry.values.body).toContain("&nbsp;");
});

it("real Excel cells export visible text and leave image-only fields empty", async () => {
  const { data, form, field, entry } = fixture(
    "<p>甲 &amp; 乙</p><p>后续说明</p>",
  );
  const photo = createField("richtext", { id: "photo", label: "图片说明" });
  const schema = copy(form.schema);
  schema.fields.push(photo);
  entry.values.photo = '<img src="https://example.test/photo.png">';
  entry.values.secret = "不可导出";
  const original = copy(entry);
  const exported = recordExcelExport(
    data,
    [field, photo],
    ["记录"],
    [{ entry, schema, extra: [entry.id] }],
  );
  const bytes = await excelBytes(
    exported.rows,
    exported.fieldIds,
    exported.merges,
  );
  const [sheet] = await readExcel(bytes, "摘要.xlsx");
  expect(sheet!.rows.at(-1)).toEqual([
    entry.id,
    "甲 & 乙\n后续说明",
    "",
  ]);
  expect(JSON.stringify(sheet!.rows)).not.toMatch(/<p>|<img|&amp;|不可导出/);
  expect(entry).toEqual(original);
});
