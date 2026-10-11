export type ExcelValue = string | number | boolean | null;
export type ExcelMerge = {
  s: { r: number; c: number };
  e: { r: number; c: number };
};
export type ExcelSheet = {
  name: string;
  rows: ExcelValue[][];
  fieldIds?: string[];
  headerRow: number;
  merges?: ExcelMerge[];
};
const maxRows = 100000,
  maxColumns = 500;

/** Read real Excel files locally. Formula cells use saved results, never execute. */
export async function readExcel(
  bytes: ArrayBuffer,
  filename: string,
): Promise<ExcelSheet[]> {
  if (!/\.(xlsx|xls)$/i.test(filename)) throw Error("请选择 xlsx 或 xls 文件");
  if (bytes.byteLength > 2 * 1024 * 1024) throw Error("文件不能超过 2MB");
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (
    !(signature[0] === 0x50 && signature[1] === 0x4b) &&
    !(signature[0] === 0xd0 && signature[1] === 0xcf) &&
    !(signature[0] === 0x09 && signature[1] === 0x08)
  )
    throw Error("文件不是有效的 Excel 文件，请重新保存为 xlsx 或 xls");
  const xlsx = await import("xlsx");
  let book: import("xlsx").WorkBook;
  try {
    book = xlsx.read(bytes, {
      type: "array",
      cellNF: true,
      cellStyles: true,
      sheetRows: maxRows + 3,
    });
  } catch {
    throw Error("无法读取文件，请在 Excel 中重新保存为 xlsx 或 xls 后重试");
  }
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name]!;
    const range = xlsx.utils.decode_range(
      sheet["!fullref"] || sheet["!ref"] || "A1",
    );
    const standard = !!sheet["!rows"]?.[0]?.hidden;
    // Reserve a hidden ID row plus both subform header rows; the import command
    // enforces the data-row limit after the selected headers are removed.
    if (range.e.r >= maxRows + 3 || range.e.c >= maxColumns)
      throw Error(`「${name}」超过 10 万条数据或 500 列`);
    const rows: ExcelValue[][] = [];
    for (let r = 0; r <= range.e.r; r++) {
      const row: ExcelValue[] = [];
      for (let c = 0; c <= range.e.c; c++) {
        const cell = sheet[xlsx.utils.encode_cell({ r, c })];
        if (cell?.f && cell.v === undefined)
          throw Error(
            `「${name}」第 ${r + 1} 行公式没有保存结果，请在 Excel 中计算并保存后重试`,
          );
        let value: ExcelValue = cell?.v ?? null;
        if (cell?.t === "e") value = cell.w || "#ERROR!";
        if (cell?.t === "n" && cell.z && xlsx.SSF.is_date(cell.z)) {
          const d = xlsx.SSF.parse_date_code(cell.v, {
            date1904: !!book.Workbook?.WBProps?.date1904,
          });
          if (d) {
            const pad = (n: number) => String(n).padStart(2, "0");
            value = `${String(d.y).padStart(4, "0")}-${pad(d.m)}-${pad(d.d)}T${pad(d.H)}:${pad(d.M)}:${pad(d.S)}`;
          }
        }
        row.push(value);
      }
      rows.push(row);
    }
    return {
      name,
      rows,
      headerRow: standard ? 1 : 0,
      ...(sheet["!merges"]?.length ? { merges: sheet["!merges"] } : {}),
      ...(standard ? { fieldIds: rows[0]?.map((v) => String(v ?? "")) } : {}),
    };
  });
}

/** Standard templates retain field IDs in a hidden row; strings stay literal. */
export async function excelBytes(
  rows: ExcelValue[][],
  fieldIds?: string[],
  merges: ExcelMerge[] = [],
): Promise<ArrayBuffer> {
  const xlsx = await import("xlsx");
  const book = xlsx.utils.book_new();
  const sheet = xlsx.utils.aoa_to_sheet(fieldIds ? [fieldIds, ...rows] : rows);
  if (fieldIds) sheet["!rows"] = [{ hidden: true }];
  sheet["!merges"] = merges.map(({ s, e }) => ({
    s: { ...s, r: s.r + (fieldIds ? 1 : 0) },
    e: { ...e, r: e.r + (fieldIds ? 1 : 0) },
  }));
  sheet["!cols"] = rows[0]?.map((title) => ({
    wch: Math.min(32, Math.max(16, String(title ?? "").length * 2)),
  }));
  xlsx.utils.book_append_sheet(book, sheet, "数据");
  return xlsx.write(book, { type: "array", bookType: "xlsx" });
}
export async function downloadExcel(
  filename: string,
  rows: ExcelValue[][],
  fieldIds?: string[],
  merges: ExcelMerge[] = [],
  beforeDownload?: () => void,
) {
  const bytes = await excelBytes(rows, fieldIds, merges);
  beforeDownload?.();
  const url = URL.createObjectURL(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|]/g, "_");
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
