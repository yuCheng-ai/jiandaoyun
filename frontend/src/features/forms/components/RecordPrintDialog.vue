<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import {
  newPrintTemplate,
  type PrintTemplate,
} from "../../../domain/presentation";
import type { FormSchema } from "../../../domain/form";
import type { FormEntry } from "../../../domain/workspace";
import PrintDocument from "./PrintDocument.vue";
import { printRecord } from "../printRecord";
import { buildRecordPdf, recordPrintFilename } from "../../../domain/recordPdf";
import { useRuntimeData } from "../../../composables/useRuntimeData";
const props = defineProps<{
  open: boolean;
  schema: FormSchema;
  title: string;
  entry: FormEntry;
  templates: PrintTemplate[];
}>();
const emit = defineEmits<{ close: [] }>();
const runtimeData = useRuntimeData();
const selected = ref(""),
  container = ref<HTMLElement>(),
  status = ref(""),
  busy = ref<"" | "print" | "pdf">(""),
  download = ref<{ url: string; filename: string }>();
let operation = 0;
function resetOutput() {
  operation++;
  busy.value = "";
  status.value = "";
  const url = download.value?.url;
  download.value = undefined;
  if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
}
onBeforeUnmount(resetOutput);
const standard = computed(() => ({
  ...newPrintTemplate(props.schema, props.title),
  id: "standard",
  name: "标准布局",
}));
const available = computed(() => props.templates.filter((t) => !t.archived));
const template = computed(
  () => available.value.find((t) => t.id === selected.value) || standard.value,
);
watch(
  () => props.open,
  (open) => {
    resetOutput();
    if (open) {
      selected.value = available.value[0]?.id || "";
    }
  },
  { immediate: true },
);
watch([selected, () => props.entry], resetOutput);
async function print() {
  if (busy.value) return;
  const page = container.value?.querySelector<HTMLElement>(".print-paper");
  if (!page) return;
  const token = ++operation;
  busy.value = "print";
  try {
    await printRecord(page, template.value);
    if (token === operation)
      status.value = "已请求打开浏览器打印窗口；也可直接下载 PDF。";
  } catch (error) {
    if (token === operation)
      status.value =
        error instanceof Error ? error.message : "无法打开打印预览";
  } finally {
    if (token === operation) busy.value = "";
  }
}
async function downloadPdf() {
  if (busy.value) return;
  resetOutput();
  const token = operation;
  busy.value = "pdf";
  status.value = "正在生成 PDF，首次使用需要加载中文字体…";
  try {
    // Build synchronously from the displayed record and its scoped runtime data.
    const input = {
      schema: props.schema,
      template: template.value,
      title: props.title,
      entry: props.entry,
      data: runtimeData.value,
    };
    const definition = buildRecordPdf(input);
    const filename = recordPrintFilename(input);
    const { createRecordPdfBlob } = await import("../exportRecordPdf");
    const blob = await createRecordPdfBlob(definition);
    if (token !== operation || !props.open) return;
    download.value = { url: URL.createObjectURL(blob), filename };
    const link = document.createElement("a");
    link.href = download.value.url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    status.value = "PDF 已生成并发起下载。若未出现文件，可点击再次下载。";
  } catch (error) {
    if (token === operation)
      status.value =
        error instanceof Error ? error.message : "PDF 生成失败，请重试。";
  } finally {
    if (token === operation) busy.value = "";
  }
}
</script>
<template>
  <BaseDialog
    :open="open"
    title="记录打印预览"
    width="980px"
    @close="emit('close')"
    ><div class="print-record-toolbar">
      <label
        >打印模板<select v-model="selected" :disabled="!!busy">
          <option value="">标准布局</option>
          <option v-for="t in available" :key="t.id" :value="t.id">
            {{ t.name }}
          </option>
        </select></label
      ><span
        >记录版本 V{{ entry.definitionVersion }} · {{ template.paper }}
        {{ template.orientation === "portrait" ? "纵向" : "横向" }}</span
      >
    </div>
    <p class="field-hint">
      模板和字段取自此记录提交时的版本。PDF
      支持中文和跨页明细，可直接下载后打印。
    </p>
    <div ref="container" class="record-print-preview">
      <PrintDocument
        :template="template"
        :schema="schema"
        :values="entry.values"
        :title="title"
        :entry="entry"
      />
    </div>
    <p v-if="status" role="status" class="field-hint">{{ status }}</p>
    <a
      v-if="download"
      class="print-pdf-download"
      aria-label="再次下载 PDF"
      :href="download.url"
      :download="download.filename"
      >{{ download.filename }} · 再次下载 PDF</a
    >
    <template #footer
      ><button class="button" @click="emit('close')">关闭预览</button
      ><button class="button" :disabled="!!busy" @click="print">
        <AppIcon name="print" />{{
          busy === "print" ? "正在准备" : "打印"
        }}</button
      ><button class="button primary" :disabled="!!busy" @click="downloadPdf">
        <AppIcon name="download" />{{
          busy === "pdf" ? "正在生成 PDF" : "下载 PDF"
        }}
      </button></template
    ></BaseDialog
  >
</template>
