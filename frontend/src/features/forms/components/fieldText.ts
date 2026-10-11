export const escapeText = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Both editors serialize a visible field chip back to its stable reference. */
export function serializeFieldText(node: Node, root: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return (node.textContent || "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ");
  if (!(node instanceof HTMLElement)) return "";
  if (node.dataset.field) return "{{" + node.dataset.field + "}}";
  if (node.tagName === "BR") return "\n";
  return (
    Array.from(node.childNodes)
      .map((child) => serializeFieldText(child, root))
      .join("") +
    (["DIV", "P"].includes(node.tagName) && node !== root && node.nextSibling
      ? "\n"
      : "")
  );
}
