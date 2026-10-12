import type { PrintTemplate } from "../../domain/presentation";
import printStyles from "./record-presentation.css?inline";

/** Prints a detached copy of the rendered record, without application controls. */
export async function printRecord(
  element: HTMLElement,
  template: PrintTemplate,
): Promise<void> {
  const iframe = document.createElement("iframe");
  iframe.title = "记录打印";
  Object.assign(iframe.style, {
    position: "fixed",
    width: "0",
    height: "0",
    border: "0",
    left: "-10000px",
  });
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument,
    win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    throw Error("当前浏览器无法打开打印预览");
  }
  doc.title = template.title || template.name;
  const style = doc.createElement("style");
  // Only allow-listed values reach @page, including configs loaded from local storage.
  const paper = template.paper === "A5" ? "A5" : "A4",
    direction = template.orientation === "landscape" ? "landscape" : "portrait";
  style.textContent =
    printStyles +
    `\n@page { size: ${paper} ${direction}; margin: 14mm; } body { margin: 0; color: #202938; font-family: Arial, "PingFang SC", sans-serif; } .print-paper { box-shadow: none; border: 0; padding: 0; max-width: none; width: 100%; }`;
  doc.head.appendChild(style);
  doc.body.appendChild(element.cloneNode(true));
  await Promise.all(
    Array.from(doc.images).map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.onload = img.onerror = () => resolve();
            setTimeout(resolve, 2000);
          }),
    ),
  );
  const remove = () => iframe.remove();
  win.addEventListener("afterprint", remove, { once: true });
  try {
    win.focus();
    win.print();
  } catch {
    remove();
    throw Error("当前浏览器不支持打印，请在系统浏览器中打开本地预览");
  }
  // Some embedded browsers do not emit afterprint.
  setTimeout(remove, 120000);
}
