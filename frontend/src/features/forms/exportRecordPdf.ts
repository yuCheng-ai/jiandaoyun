import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import fontUrl from "../../assets/fonts/NotoSansSC-Regular.otf?url";
import { RECORD_PDF_FONT, type RecordPdfImage } from "../../domain/recordPdf";

let engine: Promise<typeof import("pdfmake/build/pdfmake")> | undefined;
async function loadEngine() {
  engine ??= (async () => {
    const { default: pdf } = await import("pdfmake/build/pdfmake");
    const response = await fetch(fontUrl);
    if (!response.ok) throw Error("中文字体加载失败，请检查网络后重试。");
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const filename = "NotoSansSC-Regular.otf";
    pdf.addVirtualFileSystem({ [filename]: btoa(binary) });
    pdf.addFonts({
      [RECORD_PDF_FONT]: {
        normal: filename,
        bold: filename,
        italics: filename,
        bolditalics: filename,
      },
    });
    pdf.setUrlAccessPolicy(() => false);
    return pdf;
  })().catch((error) => {
    engine = undefined;
    throw error;
  });
  return engine;
}

/** Decode only local raster previews; normalize them to a PDF-compatible PNG. */
function rasterImage(source: string, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(source)) {
      reject(Error(`「${label}」不是可导出的本地图片。`));
      return;
    }
    const image = new Image();
    const fail = () =>
      reject(Error(`「${label}」无法读取，请检查原记录图片后重试。`));
    image.onerror = fail;
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(
          1,
          1800 / Math.max(image.naturalWidth, image.naturalHeight),
        );
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw Error();
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        fail();
      }
    };
    image.src = source;
  });
}

async function prepareImages(content: Content): Promise<void> {
  if (Array.isArray(content)) {
    for (const item of content) await prepareImages(item);
    return;
  }
  if (!content || typeof content !== "object") return;
  if ("image" in content && typeof content.image === "string")
    content.image = await rasterImage(
      content.image,
      (content as RecordPdfImage).recordImageLabel || "记录图片",
    );
  if ("stack" in content && content.stack) await prepareImages(content.stack);
  if ("columns" in content && content.columns)
    await prepareImages(content.columns);
  if ("table" in content && content.table)
    await prepareImages(content.table.body as Content);
}

export async function createRecordPdfBlob(
  definition: TDocumentDefinitions,
): Promise<Blob> {
  await prepareImages(definition.content);
  const pdf = await loadEngine();
  const blob = await pdf.createPdf(definition).getBlob();
  if (!blob.size) throw Error("PDF 生成失败，请重试。");
  return blob;
}
