<script setup lang="ts">
import { ref, reactive, watch, onMounted, useId, nextTick } from "vue";
import AppIcon from "../AppIcon.vue";
import BaseDialog from "../BaseDialog.vue";
import OptionColorPicker from "../OptionColorPicker.vue";
import RichTextImageDialog from "./RichTextImageDialog.vue";
import RichTextImageResize from "./RichTextImageResize.vue";
import {
  richTextLink,
  sanitizeRichText,
  richImageFilesHtml,
  richImageFilesIssue,
  richImagesHtml,
} from "../../domain/richText";
import { useDialogLayer } from "../../composables/useDialogLayer";
import type { RichTextImageStorage } from "./types";
import { useRichTextImages } from "./useRichTextImages";
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    readonly?: boolean;
    toolbar?: "compact" | "full";
    maxImageSizeMb?: number;
    maxImages?: number;
    allowPastedImages?: boolean;
    imageStorage?: RichTextImageStorage;
  }>(),
  {
    label: "富文本",
    toolbar: "full",
    maxImageSizeMb: 5,
    maxImages: 10,
    allowPastedImages: false,
  },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const editor = ref<HTMLElement>();
const linkId = `${useId()}-link`;
const { imageLoadError, loadStoredImages } = useRichTextImages(
  editor,
  () => props.imageStorage,
);
const previewImage = ref<{ src: string; alt: string }>();
const imageOpen = ref(false);
const linkText = ref("");
const selectedImage = ref<HTMLImageElement>();
const resizingImage = ref(false);
const imageResize = ref<InstanceType<typeof RichTextImageResize>>();
const imageTools = ref<HTMLElement>();
const imagePosition = ref({ left: "0px", top: "0px" });
const imageLink = ref(false);
const linkNewWindow = ref(true);
const closeImageTools = () => {
  selectedImage.value = undefined;
};
const { zIndex: imageZIndex } = useDialogLayer(
  imageTools,
  closeImageTools,
  () => {},
  {
    modal: false,
    anchor: () => editor.value,
    reposition: () => imageResize.value?.measure(),
  },
);
const linkOpen = ref(false),
  linkValue = ref(""),
  linkError = ref(""),
  imageError = ref("");
const alignment = ref("justifyLeft"),
  fontSize = ref(""),
  textColor = ref(""),
  backgroundColor = ref(""),
  blockType = ref("p");
const imageSlots = ref(10);
const marks = reactive({
  bold: false,
  italic: false,
  underline: false,
  strikeThrough: false,
  insertUnorderedList: false,
  insertOrderedList: false,
});
const fontSizes = [10, 13, 16, 18, 24, 32, 48];
// The description toolbar uses the source editor's text palette.
const textPalette = [
  "#8d3030",
  "#964d0e",
  "#2a7443",
  "#006e5c",
  "#00687d",
  "#1c4b8d",
  "#4c2b8d",
  "#822773",
  "#eb5050",
  "#fa8118",
  "#46c26f",
  "#00b899",
  "#00aed1",
  "#2f7deb",
  "#7e47eb",
  "#d941c0",
  "#f5a8a8",
  "#fdc08c",
  "#a3e1b7",
  "#80dccc",
  "#80d7e8",
  "#97bef5",
  "#bfa3f5",
  "#eca0e0",
  "#141e31",
  "#525967",
  "#838892",
  "#b5b8be",
  "#ededef",
  "#b5b7bf",
  "#757987",
  "#55596b",
];
let selection: Range | undefined;
function rememberSelection() {
  const current = document.getSelection();
  if (current?.rangeCount && editor.value?.contains(current.anchorNode)) {
    selection = current.getRangeAt(0).cloneRange();
    const node = current.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    if (element) {
      const style = getComputedStyle(element);
      blockType.value =
        element.closest("h1,h2,h3,h4,h5,h6,p,div,li")?.tagName.toLowerCase() ||
        "p";
      if (!["h1", "h2", "h3", "h4", "h5", "h6"].includes(blockType.value))
        blockType.value = "p";
      backgroundColor.value =
        style.backgroundColor === "rgba(0, 0, 0, 0)"
          ? ""
          : style.backgroundColor;
      alignment.value =
        (
          {
            left: "justifyLeft",
            center: "justifyCenter",
            right: "justifyRight",
            justify: "justifyFull",
          } as Record<string, string>
        )[style.textAlign] || "justifyLeft";
      const size = fontSizes.indexOf(Number.parseFloat(style.fontSize));
      fontSize.value = size < 0 ? "" : String(size + 1);
      const rgb = style.color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (rgb)
        textColor.value =
          "#" +
          rgb
            .slice(1, 4)
            .map((n) => Number(n).toString(16).padStart(2, "0"))
            .join("");
    }
    if (typeof document.queryCommandState === "function") {
      for (const mark of Object.keys(marks) as (keyof typeof marks)[])
        marks[mark] = document.queryCommandState(mark);
    }
  }
}
function restoreSelection() {
  const retained = selection;
  editor.value?.focus();
  const current = document.getSelection();
  if (retained && editor.value?.contains(retained.commonAncestorContainer)) {
    current?.removeAllRanges();
    current?.addRange(retained);
    selection = retained;
  }
}
function input() {
  if (!editor.value || props.readonly || resizingImage.value) return;
  const value = sanitizeRichText(editor.value.innerHTML);
  if (value !== sanitizeRichText(props.modelValue))
    emit("update:modelValue", value);
}
function command(action: string, value?: string) {
  if (props.readonly || !editor.value) return;
  restoreSelection();
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(action, false, value);
  rememberSelection();
  input();
  void loadStoredImages();
}
function colorText(value: string) {
  textColor.value = value;
  command("foreColor", value);
}
function clearFormatting() {
  if (props.readonly || !editor.value) return;
  restoreSelection();
  const current = document.getSelection();
  if (current?.isCollapsed && current.rangeCount) {
    const line =
      current.anchorNode instanceof Element
        ? current.anchorNode
        : current.anchorNode?.parentElement;
    const block = line?.closest("p,div,h1,h2,h3,h4,h5,h6,li");
    if (block && block !== editor.value && editor.value.contains(block))
      current.selectAllChildren(block);
  }
  // Native commands retain the browser's undo history and selection handling.
  document.execCommand("removeFormat", false);
  document.execCommand("justifyLeft", false);
  let node = document.getSelection()?.anchorNode?.parentElement;
  let depth = 0;
  while (node && node !== editor.value) {
    if (node.tagName === "BLOCKQUOTE") depth++;
    node = node.parentElement;
  }
  for (let index = 0; index < depth; index++)
    document.execCommand("outdent", false);
  rememberSelection();
  input();
}
function availableImageSlots() {
  return Math.min(
    10,
    Math.max(
      0,
      props.maxImages -
        (editor.value?.querySelectorAll("img").length || 0) +
        (selection?.cloneContents().querySelectorAll("img").length || 0),
    ),
  );
}
async function imageFilesHtml(files: File[]) {
  const count = availableImageSlots();
  const issue = richImageFilesIssue(files, props.maxImageSizeMb, count);
  if (issue) throw Error(issue);
  return props.imageStorage
    ? richImagesHtml(await props.imageStorage.upload(files))
    : richImageFilesHtml(files, props.maxImageSizeMb, count);
}
async function paste(event: ClipboardEvent) {
  if (props.readonly) return;
  rememberSelection();
  imageError.value = "";
  const files = Array.from(event.clipboardData?.files || []);
  if (!props.allowPastedImages) {
    const html = event.clipboardData?.getData("text/html");
    if (html) {
      const content = document.createElement("template");
      content.innerHTML = sanitizeRichText(html);
      content.content
        .querySelectorAll("img")
        .forEach((image) => image.remove());
      command("insertHTML", content.innerHTML);
    } else {
      const text = event.clipboardData?.getData("text/plain") || "";
      if (text) command("insertText", text);
      else if (files.length) imageError.value = "请通过“插入图片”添加图片";
    }
    return;
  }
  if (files.length) {
    const source = editor.value,
      baseline = props.modelValue,
      retained = selection;
    try {
      const html = await imageFilesHtml(files);
      if (
        !props.readonly &&
        source === editor.value &&
        baseline === props.modelValue
      ) {
        selection = retained;
        command("insertHTML", html);
      }
    } catch (reason) {
      if (
        source === editor.value &&
        baseline === props.modelValue &&
        !props.readonly
      )
        imageError.value =
          reason instanceof Error ? reason.message : "图片上传失败，请重试";
    }
    return;
  }
  const html = event.clipboardData?.getData("text/html");
  if (html) command("insertHTML", sanitizeRichText(html));
  else command("insertText", event.clipboardData?.getData("text/plain") || "");
}
function openLink() {
  imageLink.value = false;
  rememberSelection();
  const node = selection?.startContainer;
  const element = node instanceof Element ? node : node?.parentElement;
  const link = element?.closest("a");
  const ownLink = link && editor.value?.contains(link) ? link : undefined;
  linkValue.value = ownLink?.getAttribute("href") || "";
  linkNewWindow.value = ownLink?.getAttribute("target") !== "_self";
  if (ownLink && selection) selection.selectNode(ownLink);
  linkText.value = ownLink?.textContent || selection?.toString() || "";
  linkError.value = "";
  linkOpen.value = true;
}
async function insertLink() {
  const href = richTextLink(linkValue.value);
  if (!href) {
    linkError.value = "请输入有效的链接地址";
    return;
  }
  if (imageLink.value) {
    await editImage({ href });
    return;
  }
  if (!linkText.value.trim()) {
    linkError.value = "请输入显示文本";
    return;
  }
  const retained = selection;
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = linkNewWindow.value ? "_blank" : "_self";
  if (
    retained &&
    !retained.collapsed &&
    retained.toString() === linkText.value
  ) {
    const content = retained.cloneContents();
    for (const old of content.querySelectorAll("a"))
      old.replaceWith(...old.childNodes);
    anchor.appendChild(content);
  } else anchor.textContent = linkText.value;
  linkOpen.value = false;
  await nextTick();
  selection = retained;
  command("insertHTML", sanitizeRichText(anchor.outerHTML));
}
function openImages() {
  rememberSelection();
  imageError.value = "";
  imageSlots.value = availableImageSlots();
  imageOpen.value = true;
}
async function insertImages(html: string) {
  const retained = selection;
  imageOpen.value = false;
  await nextTick();
  selection = retained;
  command("insertHTML", sanitizeRichText(html));
}
function showImageTools(event: MouseEvent | KeyboardEvent) {
  if (
    event instanceof KeyboardEvent &&
    !(event.altKey && event.key === "Enter")
  ) {
    closeImageTools();
    return;
  }
  const range = document.getSelection()?.rangeCount
    ? document.getSelection()!.getRangeAt(0)
    : undefined;
  const target =
    event instanceof MouseEvent
      ? event.target
      : range &&
          range.startContainer === range.endContainer &&
          range.endOffset === range.startOffset + 1
        ? range.startContainer.childNodes[range.startOffset]
        : undefined;
  if (
    !(target instanceof HTMLImageElement) ||
    !editor.value?.contains(target)
  ) {
    closeImageTools();
    return;
  }
  event.preventDefault();
  if (props.readonly) {
    previewImage.value = { src: target.src, alt: target.alt };
    return;
  }
  selectImage(target);
}
function selectImage(target: HTMLImageElement) {
  positionImageTools(target.getBoundingClientRect());
  selectedImage.value = target;
}
function positionImageTools(rect: DOMRect) {
  imagePosition.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`,
    top: `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 94))}px`,
  };
}
function openImageLink() {
  if (!selectedImage.value) return;
  imageLink.value = true;
  linkValue.value =
    selectedImage.value.closest("a")?.getAttribute("href") || "";
  linkNewWindow.value =
    selectedImage.value.closest("a")?.getAttribute("target") !== "_self";
  linkError.value = "";
  linkOpen.value = true;
}
async function editImage(
  change: {
    width?: string;
    href?: string;
    align?: "left" | "center" | "right";
  },
  keepSelected = false,
) {
  const image = selectedImage.value;
  if (props.readonly || !image || !editor.value?.contains(image)) {
    linkError.value = "图片已变化，请重新选择图片";
    return;
  }
  const target = image.closest("a") || image;
  const imageIndex = Array.from(editor.value.querySelectorAll("img")).indexOf(
    image,
  );
  const before = target.outerHTML;
  let replacement = target.cloneNode(true) as HTMLElement;
  const replacementImage =
    replacement.tagName === "IMG"
      ? replacement
      : replacement.querySelectorAll("img")[
          Array.from(target.querySelectorAll("img")).indexOf(image)
        ]!;
  if (change.width) replacementImage.style.width = change.width;
  if (change.align) {
    replacementImage.style.display = "block";
    replacementImage.style.marginLeft =
      change.align === "left" ? "0px" : "auto";
    replacementImage.style.marginRight =
      change.align === "right" ? "0px" : "auto";
  }
  let html = "";
  if (change.href !== undefined) {
    if (change.href) {
      if (replacement.tagName !== "A") {
        const anchor = document.createElement("a");
        anchor.appendChild(replacement);
        replacement = anchor;
      }
      replacement.setAttribute("href", change.href);
      replacement.setAttribute(
        "target",
        linkNewWindow.value ? "_blank" : "_self",
      );
    } else if (replacement.tagName === "A") html = replacement.innerHTML;
  }
  html ||= replacement.outerHTML;
  const retained = document.createRange();
  retained.selectNode(target);
  linkOpen.value = false;
  closeImageTools();
  await nextTick();
  if (
    props.readonly ||
    !editor.value?.contains(target) ||
    target.outerHTML !== before
  )
    return;
  selection = retained;
  command("insertHTML", sanitizeRichText(html));
  if (keepSelected) {
    const updated = editor.value?.querySelectorAll("img")[imageIndex];
    if (updated) selectImage(updated);
  }
}
async function removeImage() {
  const image = selectedImage.value;
  if (props.readonly || !image || !editor.value?.contains(image)) return;
  const retained = document.createRange();
  retained.selectNode(image);
  closeImageTools();
  await nextTick();
  if (props.readonly || !editor.value?.contains(image)) return;
  selection = retained;
  command("delete");
}
function viewImage() {
  const image = selectedImage.value;
  if (!image) return;
  previewImage.value = { src: image.src, alt: image.alt };
}
onMounted(() => {
  if (editor.value)
    editor.value.innerHTML = sanitizeRichText(props.modelValue || "");
  void loadStoredImages();
});
watch(
  () => props.modelValue,
  (value) => {
    if (
      editor.value &&
      sanitizeRichText(value || "") !== sanitizeRichText(editor.value.innerHTML)
    ) {
      closeImageTools();
      linkOpen.value = false;
      imageOpen.value = false;
      imageError.value = "";
      editor.value.innerHTML = sanitizeRichText(value || "");
      selection = undefined;
      previewImage.value = undefined;
    }
    void loadStoredImages();
  },
);
watch(
  () => props.readonly,
  (readonly) => {
    if (readonly) {
      linkOpen.value = false;
      imageOpen.value = false;
      closeImageTools();
    }
  },
);
</script>
<template>
  <div
    v-bind="$attrs"
    class="rich-text-editor"
    :class="{ 'rich-full-editor': toolbar === 'full' }"
  >
    <div
      v-if="!readonly"
      class="rich-toolbar"
      role="toolbar"
      aria-label="富文本工具"
    >
      <template v-if="toolbar === 'full'">
        <button
          type="button"
          aria-label="撤销"
          title="撤销"
          @mousedown.prevent
          @click="command('undo')"
        >
          <AppIcon name="undo" :size="14" />
        </button>
        <button
          type="button"
          aria-label="重做"
          title="重做"
          @mousedown.prevent
          @click="command('redo')"
        >
          <AppIcon name="redo" :size="14" />
        </button>
        <button
          type="button"
          aria-label="清除格式"
          title="清除格式"
          @mousedown.prevent
          @click="clearFormatting"
        >
          <span class="rich-clear-mark">T</span>
        </button>
        <label class="rich-block-picker"
          >{{ blockType === "p" ? "正文" : `标题 ${blockType.slice(1)}` }}
          <select
            v-model="blockType"
            aria-label="段落样式"
            @pointerdown="rememberSelection"
            @change="command('formatBlock', blockType)"
          >
            <option value="p">正文</option>
            <option v-for="level in 6" :key="level" :value="`h${level}`">
              标题 {{ level }}
            </option>
          </select>
        </label>
      </template>
      <button
        type="button"
        title="粗体"
        aria-label="粗体"
        :aria-pressed="marks.bold"
        @mousedown.prevent
        @click="command('bold')"
      >
        <b>B</b></button
      ><button
        type="button"
        title="斜体"
        aria-label="斜体"
        :aria-pressed="marks.italic"
        @mousedown.prevent
        @click="command('italic')"
      >
        <i>I</i></button
      ><button
        type="button"
        title="下划线"
        aria-label="下划线"
        :aria-pressed="marks.underline"
        @mousedown.prevent
        @click="command('underline')"
      >
        <u>U</u>
      </button>
      <button
        v-if="toolbar === 'full'"
        type="button"
        aria-label="删除线"
        title="删除线"
        :aria-pressed="marks.strikeThrough"
        @mousedown.prevent
        @click="command('strikeThrough')"
      >
        <s>S</s>
      </button>
      <label class="rich-tool-picker" title="段落对齐"
        ><AppIcon name="align" :size="14" /><select
          v-model="alignment"
          aria-label="段落对齐"
          @pointerdown="rememberSelection"
          @change="command(alignment)"
        >
          <option value="justifyLeft">左对齐</option>
          <option value="justifyCenter">居中</option>
          <option value="justifyRight">右对齐</option>
          <option v-if="toolbar !== 'full'" value="justifyFull">
            两端对齐
          </option>
        </select></label
      >
      <span
        class="rich-color-tool"
        @pointerdown.capture="rememberSelection"
        @focusin="rememberSelection"
      >
        <OptionColorPicker
          :color="textColor"
          :palette="textPalette"
          label="文字"
          swatch="text"
          @change="colorText"
        />
      </span>
      <span
        v-if="toolbar === 'full'"
        class="rich-color-tool rich-background-tool"
        @pointerdown.capture="rememberSelection"
        @focusin="rememberSelection"
      >
        <OptionColorPicker
          :color="backgroundColor"
          :palette="textPalette"
          label="背景"
          swatch="bar"
          @change="command('hiliteColor', $event)"
        />
      </span>
      <label v-if="toolbar !== 'full'" class="rich-tool-picker" title="文字大小"
        ><span>Tt</span
        ><select
          v-model="fontSize"
          aria-label="文字大小"
          @pointerdown="rememberSelection"
          @change="command('fontSize', fontSize)"
        >
          <option value="" disabled>文字大小</option>
          <option
            v-for="(size, index) in fontSizes"
            :key="size"
            :value="String(index + 1)"
          >
            {{ size }} px
          </option>
        </select></label
      >
      <template v-if="toolbar === 'full'">
        <button
          type="button"
          aria-label="无序列表"
          title="无序列表"
          :aria-pressed="marks.insertUnorderedList"
          @mousedown.prevent
          @click="command('insertUnorderedList')"
        >
          ☷
        </button>
        <button
          type="button"
          aria-label="有序列表"
          title="有序列表"
          :aria-pressed="marks.insertOrderedList"
          @mousedown.prevent
          @click="command('insertOrderedList')"
        >
          ≡₁
        </button>
        <button
          type="button"
          aria-label="减少缩进"
          title="减少缩进"
          @mousedown.prevent
          @click="command('outdent')"
        >
          ⇤
        </button>
        <button
          type="button"
          aria-label="增加缩进"
          title="增加缩进"
          @mousedown.prevent
          @click="command('indent')"
        >
          ⇥
        </button>
      </template>
      <button
        type="button"
        title="插入链接"
        aria-label="插入链接"
        @mousedown.prevent
        @click="openLink"
      >
        <AppIcon name="link" :size="14" />
      </button>
      <button
        type="button"
        title="取消链接"
        aria-label="取消链接"
        @mousedown.prevent
        @click="command('unlink')"
      >
        <AppIcon name="unlink" :size="14" />
      </button>
      <button
        v-if="maxImages > 0"
        type="button"
        title="插入图片"
        aria-label="插入图片"
        @mousedown.prevent
        @click="openImages"
      >
        <AppIcon name="image" :size="14" />
      </button>
    </div>
    <div
      ref="editor"
      class="rich-editable"
      :contenteditable="!readonly"
      :aria-readonly="!!readonly"
      role="textbox"
      :aria-label="label"
      aria-multiline="true"
      @input="input"
      @blur="input"
      @keyup="rememberSelection"
      @focus="rememberSelection"
      @mouseup="rememberSelection"
      @paste.prevent="paste"
      @drop.prevent
      @dragstart.prevent
      @click="showImageTools"
      @keydown="showImageTools"
    />
    <p v-if="imageError" class="field-error rich-upload-error" role="status">
      {{ imageError }}
    </p>
    <p
      v-if="imageLoadError"
      class="field-error rich-upload-error"
      role="status"
    >
      {{ imageLoadError }}
      <button type="button" class="text-button" @click="loadStoredImages">
        重新加载图片
      </button>
    </p>
  </div>
  <Teleport to="body">
    <div
      v-if="selectedImage"
      ref="imageTools"
      class="rich-image-tools"
      role="toolbar"
      aria-label="图片设置"
      :style="{ ...imagePosition, zIndex: imageZIndex }"
    >
      <RichTextImageResize
        ref="imageResize"
        :image="selectedImage"
        @measure="positionImageTools"
        @resize="editImage({ width: $event }, true)"
        @resizing="resizingImage = $event"
      />
      <button
        type="button"
        class="icon-button"
        aria-label="图片链接"
        @click="openImageLink"
      >
        <AppIcon name="link" :size="14" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="取消图片链接"
        :disabled="!selectedImage.closest('a')"
        @click="editImage({ href: '' })"
      >
        <AppIcon name="unlink" :size="14" />
      </button>
      <button type="button" aria-label="放大查看图片" @click="viewImage">
        查看
      </button>
      <button type="button" aria-label="删除图片" @click="removeImage">
        删除
      </button>
      <span class="rich-image-tools-break" />
      <button
        v-for="item in [
          { value: 'left' as const, label: '左对齐' },
          { value: 'center' as const, label: '居中' },
          { value: 'right' as const, label: '右对齐' },
        ]"
        :key="item.value"
        type="button"
        :aria-label="`图片${item.label}`"
        @click="editImage({ align: item.value })"
      >
        {{ item.label }}
      </button>
      <button
        v-for="size in [
          { label: '1/4', value: '25%' },
          { label: '1/2', value: '50%' },
          { label: '3/4', value: '75%' },
          { label: '整行', value: '100%' },
        ]"
        :key="size.value"
        type="button"
        :aria-label="`图片宽度${size.label}`"
        :aria-pressed="selectedImage.style.width === size.value"
        @click="editImage({ width: size.value })"
      >
        {{ size.label }}
      </button>
    </div>
  </Teleport>
  <BaseDialog
    :open="!!previewImage"
    title="查看图片"
    width="960px"
    @close="previewImage = undefined"
  >
    <img
      v-if="previewImage"
      class="rich-image-preview"
      :src="previewImage.src"
      :alt="previewImage.alt || '图片'"
    />
  </BaseDialog>
  <BaseDialog
    :open="linkOpen"
    :title="imageLink ? '图片链接' : '插入链接'"
    width="420px"
    @close="linkOpen = false"
  >
    <div class="form-group">
      <label :for="linkId">链接地址</label
      ><input
        :id="linkId"
        v-model="linkValue"
        type="text"
        placeholder="https://example.com"
        @keydown.enter.prevent="insertLink"
      />
      <p v-if="linkError" class="field-error" role="status">{{ linkError }}</p>
      <template v-if="!imageLink"
        ><label :for="`${linkId}-text`">显示文本</label
        ><input
          :id="`${linkId}-text`"
          v-model="linkText"
          type="text"
          @keydown.enter.prevent="insertLink"
      /></template>
      <label class="checkbox-line"
        ><input v-model="linkNewWindow" type="checkbox" />在新窗口打开</label
      >
    </div>
    <template #footer
      ><button type="button" class="button" @click="linkOpen = false">
        取消</button
      ><button
        type="button"
        class="button primary"
        :disabled="!linkValue.trim()"
        @click="insertLink"
      >
        确定
      </button></template
    >
  </BaseDialog>
  <RichTextImageDialog
    :open="imageOpen"
    :max-size-mb="maxImageSizeMb"
    :max-count="imageSlots"
    :upload="imageFilesHtml"
    @close="imageOpen = false"
    @insert="insertImages"
  />
</template>
<style scoped>
.rich-text-editor {
  border: 1px solid #e0e4e9;
  border-radius: 4px;
  background: white;
  overflow: hidden;
}
.rich-toolbar {
  display: flex;
  align-items: center;
  gap: 1px;
  height: 31px;
  min-height: 31px;
  background: #f6f7f9;
  border-bottom: 1px solid #e2e5e9;
  padding: 0 4px;
  color: #75818e;
}
.rich-toolbar > button {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 29px;
  min-width: 24px;
  font-size: 14px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.rich-toolbar > button:hover,
.rich-toolbar > button[aria-pressed="true"],
.rich-tool-picker:hover {
  background: #e5f2ef;
  color: #059c90;
}
.rich-tool-picker {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 25px;
  height: 29px;
  flex-shrink: 0;
  margin: 0;
  font-size: 12px;
  font-weight: 400;
  cursor: pointer;
}
.rich-color-picker > span {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.rich-toolbar .rich-tool-picker > select,
.rich-toolbar .rich-tool-picker > input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  padding: 0;
  border: 0;
  opacity: 0;
  cursor: pointer;
}
.rich-tool-picker:has(:focus-visible) {
  outline: 2px solid #0ca397;
  outline-offset: -2px;
}
.rich-editable {
  padding: 8px 10px;
  min-height: 78px;
  font-size: 14px;
  line-height: 21px;
  outline: 0;
  word-break: break-word;
}
.rich-editable:focus {
  box-shadow: inset 0 0 0 1px #3cb6a8;
}
.rich-editable :deep(p) {
  min-height: 20px;
}
.rich-editable :deep(a) {
  color: inherit;
}
.rich-editable :deep(img) {
  max-width: 100%;
  height: auto;
}
.rich-upload-error {
  padding: 6px 10px;
}
.rich-editable :deep(ul),
.rich-editable :deep(ol) {
  padding-left: 20px;
  margin: 3px 0;
}

.rich-full-editor .rich-toolbar {
  flex-wrap: wrap;
  height: auto;
  padding: 3px 4px;
}
.rich-block-picker {
  position: relative;
  min-width: 58px;
  height: 29px;
  display: grid;
  place-items: center;
  margin: 0;
  font-size: 12px;
  font-weight: 400;
}
.rich-block-picker select {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
}
.rich-block-picker:has(:focus-visible) {
  outline: 2px solid #0ca397;
  outline-offset: -2px;
}
.rich-clear-mark {
  text-decoration: underline;
  position: relative;
}
.rich-clear-mark::after {
  content: "×";
  font-size: 10px;
  position: absolute;
  right: -7px;
  bottom: -3px;
}
.rich-background-tool :deep(.option-color-bar) {
  width: 24px;
  height: 24px;
  border-radius: 2px;
  padding: 0;
}
.rich-background-tool :deep(.option-color-bar::after) {
  content: "A";
  color: #525967;
}
.rich-editable :deep(blockquote) {
  margin: 0 0 0 2em;
  padding: 0;
  border: 0;
}
.rich-image-tools {
  position: fixed;
  display: flex;
  flex-wrap: wrap;
  width: 320px;
  box-sizing: border-box;
  align-items: center;
  gap: 3px;
  max-width: calc(100vw - 16px);
  padding: 5px;
  border: 1px solid #dadee5;
  border-radius: 4px;
  background: white;
  box-shadow: 0 3px 12px #131d2e26;
}
.rich-image-tools button {
  height: 28px;
  min-width: 28px;
  padding: 0 6px;
  background: transparent;
  border: 0;
  color: #525967;
  cursor: pointer;
}
.rich-image-tools button:hover,
.rich-image-tools button[aria-pressed="true"] {
  color: #00a49a;
  background: #e8f7f5;
}
.rich-image-tools button:disabled {
  opacity: 0.4;
  cursor: default;
}
.rich-color-tool {
  display: inline-flex;
}
.rich-color-tool :deep(.option-color-text) {
  width: 26px;
  height: 26px;
  border: 0;
  gap: 0;
  padding: 0;
}
.rich-color-tool :deep(.option-color-text svg) {
  display: none;
}
.rich-image-tools-break {
  flex-basis: 100%;
}
.rich-image-preview {
  display: block;
  max-width: 100%;
  max-height: 75vh;
  margin: auto;
  object-fit: contain;
}
</style>
