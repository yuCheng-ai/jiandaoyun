import type {
  Content,
  ContentImage,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import type { FormSchema } from "./form";
import type { FormEntry, WorkspaceData } from "./workspace";
import { entryDefinition, renderDataTitle } from "./collaboration";
import {
  buildRecordBlocks,
  type PrintTemplate,
  type RecordBlock,
} from "./presentation";

export const RECORD_PDF_FONT = "NotoSansSC";
export interface RecordPdfImage extends ContentImage {
  recordImageLabel?: string;
}
export interface RecordPdfInput {
  schema: FormSchema;
  template: PrintTemplate;
  title: string;
  entry: FormEntry;
  /** The caller supplies the same permission-scoped data as the on-screen record. */
  data: WorkspaceData;
}
const date = (value: string) => {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "—" : time.toLocaleString("zh-CN");
};
export function recordPdfFilename(title: string, entryId: string) {
  const clean = (text: string) =>
    text
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
      .replace(/^\.+|\.+$/g, "")
      .trim();
  return `${clean(title).slice(0, 80) || "记录"}-${clean(entryId).slice(0, 60) || "详情"}.pdf`;
}

export function recordPrintFilename(
  { schema, template, title, entry, data }: RecordPdfInput,
  printedAt = new Date(),
) {
  const naming = template.fileName;
  if (!naming) return recordPdfFilename(template.title || title, entry.id);
  const clean = (value: string) =>
    value
      .replace(/[\u0000-\u001f<>:"/\\|?*$\s]/g, "_")
      .replace(/^\.+|\.+$/g, "");
  const stamp = [
    printedAt.getFullYear(),
    printedAt.getMonth() + 1,
    printedAt.getDate(),
    printedAt.getHours(),
    printedAt.getMinutes(),
    printedAt.getSeconds(),
  ].map((value, index) =>
    index ? String(value).padStart(2, "0") : String(value),
  );
  let name = `${title}_${stamp.slice(0, 3).join("")}_${stamp.slice(3).join("")}`;
  if (naming.mode === "title")
    name = renderDataTitle(
      entryDefinition(entry, data)?.extensions?.collaboration,
      schema,
      entry.values,
      data,
      `${title} · ${entry.id.slice(-6)}`,
    );
  if (naming.mode === "custom") {
    const parts = naming.value.split(/(\{\{[^{}]+\}\})/g);
    name = renderDataTitle(
      {
        titleMode: "custom",
        inlineEdit: false,
        titleParts: parts.map((value, index) => ({
          id: String(index),
          kind: value.startsWith("{{") ? "field" : "text",
          value: value.startsWith("{{") ? value.slice(2, -2).trim() : value,
        })),
      },
      schema,
      entry.values,
      data,
      "记录",
    );
  }
  return `${[...clean(name)].slice(0, naming.mode === "custom" ? 50 : 200).join("") || "记录"}.pdf`;
}

/** Structured text and tables remain searchable and paginate without screenshots. */
export function buildRecordPdf({
  schema,
  template,
  title,
  entry,
  data,
}: RecordPdfInput): TDocumentDefinitions {
  const blocks = buildRecordBlocks(
    schema,
    entry.values,
    template,
    data,
    entry.id,
  );
  const paperWidth =
    template.paper === "A5"
      ? template.orientation === "landscape"
        ? 595.28
        : 419.53
      : template.orientation === "landscape"
        ? 841.89
        : 595.28;
  const usableWidth = paperWidth - 80;
  const content: Content[] = [
    { text: template.title || title, style: "title" },
    ...(template.subtitle
      ? [{ text: template.subtitle, style: "subtitle" } as Content]
      : []),
  ];
  if (template.showMetadata)
    content.push({
      text: `记录编号：${entry.id}\n创建时间：${date(entry.createdAt)}\n表单版本：V${entry.definitionVersion}`,
      style: "metadata",
    });
  const heading = (label: string): Content => ({ text: label, style: "label" });
  const textField = (block: RecordBlock): Content => ({
    stack: [heading(block.label), { text: block.text || "—" }],
    margin: [0, 0, 0, 12],
  });
  let pair: Content[] = [];
  const flushPair = () => {
    if (pair.length) {
      if (pair.length === 1) pair.push({ text: "" });
      content.push({ columns: pair, columnGap: 20 });
      pair = [];
    }
  };
  for (const block of blocks) {
    if (block.headers?.length && block.rows) {
      flushPair();
      // Wide subtables use repeated row numbers and the first business column,
      // so every column stays readable and rows can be matched across groups.
      const maxColumns = Math.max(2, Math.floor((usableWidth - 24) / 90));
      const groups: number[][] = [];
      if (block.headers.length <= maxColumns)
        groups.push(block.headers.map((_, i) => i));
      else
        for (let i = 1; i < block.headers.length; i += maxColumns - 1)
          groups.push([
            0,
            ...block.headers.slice(i, i + maxColumns - 1).map((_, j) => i + j),
          ]);
      groups.forEach((indices, group) => {
        const groupLabel =
          block.label +
          (groups.length > 1
            ? `（第 ${group + 1}/${groups.length} 组列）`
            : "");
        const body: TableCell[][] = [
          [
            {
              text: groupLabel,
              colSpan: indices.length + 1,
              style: "label",
              border: [false, false, false, false],
              margin: [0, 0, 0, 5],
            },
            ...indices.map(() => ""),
          ],
          [
            { text: "行", fillColor: "#edf4f5" },
            ...indices.map((i) => ({
              text: block.headers![i]!,
              fillColor: "#edf4f5",
            })),
          ],
          ...block.rows!.map((row, index) => [
            String(index + 1),
            ...indices.map((i): TableCell => {
              const images = block.rowImages?.[index]?.[i] || [];
              return images.length
                ? {
                    stack: [
                      { text: row[i] || "—" },
                      ...images.map((image, imageIndex): RecordPdfImage => ({
                        image,
                        fit: [
                          Math.max(
                            40,
                            (usableWidth - 24) / indices.length - 16,
                          ),
                          120,
                        ],
                        margin: [0, 4, 0, 4],
                        recordImageLabel: `${block.label} · 第${index + 1}行 · ${block.headers![i]} · 图片${imageIndex + 1}`,
                      })),
                    ],
                  }
                : row[i] || "—";
            }),
          ]),
        ];
        if (!block.rows!.length)
          body.push([
            { text: "暂无明细", colSpan: indices.length + 1 },
            ...indices.map(() => ""),
          ]);
        content.push({
          table: {
            headerRows: 2,
            // Keep ordinary first rows with the header. Very long cells remain
            // splittable instead of becoming an unrenderable oversized block.
            keepWithHeaderRows: [
              groupLabel,
              ...indices.map((i) => block.headers![i]!),
              ...indices.map((i) => block.rows![0]?.[i] || ""),
            ].every((text) => text.length < 80 && !text.includes("\n"))
              ? 1
              : 0,
            widths: [24, ...indices.map(() => "*" as const)],
            body,
            dontBreakRows: false,
          },
          layout: "lightHorizontalLines",
          fontSize: Math.min(template.fontSize * 0.75, 10.5),
          margin: [0, 0, 0, 14],
        });
      });
    } else if (block.images.length) {
      flushPair();
      content.push(textField(block));
      block.images.forEach((image, index) => {
        const node: RecordPdfImage = {
          image,
          fit: [usableWidth, 180],
          margin: [0, 0, 0, 10],
          // Retain a business label for a useful decoding error in the browser adapter.
          recordImageLabel: `${block.label} · 图片 ${index + 1}`,
        };
        content.push({
          stack: [
            heading(`${block.label}（${index + 1}/${block.images.length}）`),
            node,
          ],
          unbreakable: true,
        });
      });
    } else if (template.columns === 2) {
      pair.push(textField(block));
      if (pair.length === 2) flushPair();
    } else content.push(textField(block));
  }
  flushPair();
  if (!blocks.length)
    content.push({ text: "没有可展示的字段。", style: "metadata" });
  if (template.showHistory && entry.history.length) {
    content.push(heading("操作记录"));
    for (const item of entry.history)
      content.push({
        text: `${item.label} · ${item.action}\n${date(item.time)}`,
        margin: [0, 0, 0, 8],
      });
  }
  if (template.footer)
    content.push({ text: template.footer, style: "footnote" });
  return {
    pageSize: template.paper,
    pageOrientation: template.orientation,
    pageMargins: [40, 40, 40, 44],
    info: {
      title: template.title || title,
      subject: `记录 ${entry.id} · V${entry.definitionVersion}`,
    },
    defaultStyle: {
      font: RECORD_PDF_FONT,
      fontSize: template.fontSize * 0.75,
      lineHeight: 1.3,
      color: "#202938",
    },
    styles: {
      title: { fontSize: 18, alignment: "center", margin: [0, 0, 0, 10] },
      subtitle: {
        fontSize: 10,
        color: "#627082",
        alignment: "center",
        margin: [0, 0, 0, 16],
      },
      metadata: { fontSize: 9, color: "#627082", margin: [0, 0, 0, 18] },
      label: { color: "#566474", margin: [0, 0, 0, 5] },
      footnote: { fontSize: 9, color: "#627082", margin: [0, 14, 0, 0] },
    },
    content,
    footer: (currentPage, pageCount) => ({
      text: `${currentPage} / ${pageCount}`,
      fontSize: 9,
      alignment: "center",
      color: "#627082",
      margin: [0, 12, 0, 0],
    }),
  };
}
