import DOMPurify from "dompurify";

export const richTextCharacterLimit = 30000;
/** Preserve legacy values while allowing corrections that reduce their stored size. */
export function richTextValueIssue(value: unknown, previous?: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") return "请输入富文本内容";
  const previousLength = typeof previous === "string" ? previous.length : 0;
  return value.length > richTextCharacterLimit && value.length > previousLength
    ? "内容过长，请减少文字或格式（上限 3 万字符）"
    : "";
}

export interface RichTextImage {
  id?: string;
  src?: string;
  alt?: string;
}

export function richImagesHtml(images: RichTextImage[]): string {
  return sanitizeRichText(
    images
      .map((value) => {
        const image = document.createElement("img");
        if (value.id) image.dataset.fileId = value.id;
        if (value.src) image.src = value.src;
        image.alt = value.alt || "";
        return image.outerHTML;
      })
      .join(""),
  );
}

export const richImageAccept = "image/png,image/jpeg,image/gif,image/webp";
export const richImageBatchLimit = 10;
export function richImageFilesIssue(
  files: Pick<File, "type" | "size">[],
  maxSizeMb = 1,
  maxCount = richImageBatchLimit,
): string {
  if (files.length > maxCount) return `最多可再添加 ${maxCount} 张图片`;
  if (files.some((file) => !richImageAccept.split(",").includes(file.type)))
    return "请选择 PNG、JPEG、GIF 或 WebP 图片";
  if (files.some((file) => file.size > maxSizeMb * 1024 * 1024))
    return `每张图片不能超过 ${maxSizeMb} MB`;
  return "";
}
export async function richImageFilesHtml(
  files: File[],
  maxSizeMb = 1,
  maxCount = richImageBatchLimit,
): Promise<string> {
  return richImagesHtml(await richImageFiles(files, maxSizeMb, maxCount));
}

export async function richImageFiles(
  files: File[],
  maxSizeMb = 1,
  maxCount = richImageBatchLimit,
): Promise<RichTextImage[]> {
  const issue = richImageFilesIssue(files, maxSizeMb, maxCount);
  if (issue) throw Error(issue);
  const images = await Promise.all(
    files.map(async (file) => {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(Error("图片读取失败，请重新选择"));
        reader.readAsDataURL(file);
      });
      return { src, alt: file.name };
    }),
  );
  return images;
}

export function richTextLink(value: string): string | undefined {
  const text = value.trim();
  if (!text) return;
  if (text.startsWith("#") || (text.startsWith("/") && !text.startsWith("//")))
    return text;
  try {
    const url = new URL(text);
    if (["https:", "http:", "mailto:", "tel:"].includes(url.protocol))
      return url.href;
  } catch {
    /* Invalid URLs remain in the editor for correction. */
  }
}

/** One inert, sanitized fragment supplies rendering, validation and text summaries. */
function richTextFragment(value: string): DocumentFragment {
  if (!value) return document.createDocumentFragment();
  const fragment = DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [
      "p",
      "div",
      "br",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "strike",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "ul",
      "ol",
      "li",
      "span",
      "font",
      "a",
      "img",
    ],
    ALLOWED_ATTR: [
      "style",
      "color",
      "size",
      "href",
      "src",
      "alt",
      "width",
      "target",
      "data-file-id",
    ],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const original of fragment.querySelectorAll<HTMLElement>("*")) {
    let node = original;
    const styles = original.style;
    const color = original.getAttribute("color") || styles.color;
    const size = original.getAttribute("size");
    const fontSize = size
      ? ["10px", "13px", "16px", "18px", "24px", "32px", "48px"][
          Number(size) - 1
        ] || ""
      : styles.fontSize;
    const decoration = styles.textDecorationLine || styles.textDecoration;
    const imageWidth =
      styles.width ||
      (original.getAttribute("width")
        ? `${original.getAttribute("width")}px`
        : "");
    const imageLayout = {
      display: styles.display,
      marginLeft: styles.marginLeft,
      marginRight: styles.marginRight,
    };
    const retained = {
      backgroundColor:
        /^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i.test(
          styles.backgroundColor,
        )
          ? styles.backgroundColor
          : "",
      color:
        /^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i.test(
          color,
        )
          ? color
          : "",
      fontSize:
        /^(?:[89]|[1-6]\d|7[0-2])px$|^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)$/.test(
          fontSize,
        )
          ? fontSize
          : "",
      fontWeight: /^(normal|bold|[1-9]00)$/.test(styles.fontWeight)
        ? styles.fontWeight
        : "",
      fontStyle: /^(normal|italic)$/.test(styles.fontStyle)
        ? styles.fontStyle
        : "",
      textDecoration:
        /^(none|(?:underline|line-through)(?: (?:underline|line-through))?)$/.test(
          decoration,
        )
          ? decoration
          : "",
      textAlign: /^(left|center|right|justify)$/.test(styles.textAlign)
        ? styles.textAlign
        : "",
    };
    if (original.tagName === "FONT") {
      node = document.createElement("span");
      while (original.firstChild) node.appendChild(original.firstChild);
      original.replaceWith(node);
    }
    node.removeAttribute("style");
    node.removeAttribute("color");
    node.removeAttribute("size");
    node.removeAttribute("width");
    Object.assign(node.style, retained);
    if (!node.getAttribute("style")) node.removeAttribute("style");
    if (node.tagName === "A") {
      const href = richTextLink(node.getAttribute("href") || "");
      if (href) {
        node.setAttribute("href", href);
        node.setAttribute(
          "target",
          node.getAttribute("target") === "_self" ? "_self" : "_blank",
        );
        node.setAttribute("rel", "noopener noreferrer");
      } else node.removeAttribute("href");
    }
    if (node.tagName === "IMG") {
      if (imageLayout.display === "block") {
        node.style.display = "block";
        node.style.marginLeft = /^(auto|0px)$/.test(imageLayout.marginLeft)
          ? imageLayout.marginLeft
          : "";
        node.style.marginRight = /^(auto|0px)$/.test(imageLayout.marginRight)
          ? imageLayout.marginRight
          : "";
      }
      if (
        /^(?:\d+(?:\.\d+)?)(?:px|%)$/.test(imageWidth) &&
        Number.parseFloat(imageWidth) > 0
      )
        node.style.width = imageWidth;
      const src = node.getAttribute("src") || "";
      const fileId = node.getAttribute("data-file-id") || "";
      if (/^[\w.-]{1,160}$/.test(fileId)) {
        // Object URLs belong to the current renderer, never to persisted HTML.
        node.removeAttribute("src");
        continue;
      }
      node.removeAttribute("data-file-id");
      if (
        !/^data:image\/(png|jpeg|gif|webp);base64,[\da-z+/=]+$/i.test(src) &&
        !/^https?:\/\//i.test(src)
      )
        node.remove();
    }
  }
  return fragment;
}

/** The editor, designer and filling view retain the same supported formatting. */
export function sanitizeRichText(value: string): string {
  if (!value) return "";
  const container = document.createElement("div");
  container.appendChild(richTextFragment(value));
  return container.innerHTML;
}

/** Only visible text belongs in table summaries, search and text-only exports. */
export function richTextPlainText(value: string): string {
  if (!value) return "";
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE)
      return (node.textContent || "").replace(/\s+/g, " ");
    if (node.nodeName === "BR") return "\n";
    const text = Array.from(node.childNodes, visit).join("");
    return [
      "P",
      "DIV",
      "LI",
      "BLOCKQUOTE",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
    ].includes(node.nodeName)
      ? `\n${text}\n`
      : text;
  };
  return visit(richTextFragment(value))
    .replace(/ *\n */g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}

/** Required checks use the same content that the editor can safely display. */
export function hasRichTextContent(value: string): boolean {
  const content = richTextFragment(value);
  return Boolean(content.textContent?.trim() || content.querySelector("img"));
}
