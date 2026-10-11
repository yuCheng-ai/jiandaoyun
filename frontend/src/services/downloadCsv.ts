import { csvText } from "../domain/csv";

/** Request a browser download; completion is controlled by the browser, not this adapter. */
export function downloadCsv(
  filename: string,
  rows: readonly (readonly unknown[])[],
) {
  const url = URL.createObjectURL(
    new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
