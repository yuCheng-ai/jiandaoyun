<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ocrTemplates, ocrTemplate, type OcrType } from "@platform/contracts";
import type { FormField, FormSchema } from "../../../domain/form";
import { configureOcr, matchOcrTargets, ocrTargets } from "../../../domain/ocr";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
const props = defineProps<{
  field: FormField;
  schema: FormSchema;
  applySchema?: (schema: FormSchema) => void;
}>();
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const open = ref(false),
  selected = ref<string[]>([]),
  mode = ref<"new" | "existing">("new"),
  mapped = ref<Record<string, string>>({}),
  error = ref("");
const template = computed(() => ocrTemplate(props.field.ocr?.type || ""));
const contents = computed(() => template.value?.contents || []);
const selectedContents = computed(() =>
  contents.value.filter((content) => selected.value.includes(content.id)),
);
const allSelected = computed(
  () =>
    selected.value.length === contents.value.length && !!contents.value.length,
);
let baseline = "";
function changeType(event: Event) {
  emit("update", {
    ocr: {
      type: (event.target as HTMLSelectElement).value as OcrType,
      mappings: [],
    },
  });
}
function start() {
  if (!template.value) return;
  const mappings = props.field.ocr?.mappings || [];
  selected.value = mappings.length
    ? mappings.map((item) => item.contentId)
    : contents.value.map((item) => item.id);
  mapped.value = Object.fromEntries(
    mappings.map((item) => [item.contentId, item.fieldId]),
  );
  mode.value = mappings.length ? "existing" : "new";
  baseline = JSON.stringify(props.schema);
  error.value = "";
  open.value = true;
}
function match() {
  if (!template.value) return;
  const matched = matchOcrTargets(
    props.schema,
    template.value.value,
    selected.value,
  );
  for (const item of matched)
    if (!mapped.value[item.contentId])
      mapped.value[item.contentId] = item.fieldId;
}
watch(
  [mode, selected],
  () => {
    error.value = "";
    if (mode.value === "existing") match();
  },
  { deep: true },
);
const dismiss = useDraftDismiss(
  () => open.value,
  () => ({ selected: selected.value, mode: mode.value, mapped: mapped.value }),
  () => {
    open.value = false;
  },
);
function finish() {
  try {
    if (JSON.stringify(props.schema) !== baseline)
      throw Error("表单已变化，请保留当前选择并重新打开设置");
    if (!props.applySchema) throw Error("当前编辑器无法添加或设置存储字段");
    const next = configureOcr(
      props.schema,
      props.field.id,
      template.value!.value,
      selected.value,
      mode.value,
      selected.value.map((contentId) => ({
        contentId,
        fieldId: mapped.value[contentId] || "",
      })),
    );
    props.applySchema(next);
    dismiss.markSaved();
    open.value = false;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>
<template>
  <div class="form-group">
    <label for="ocr-type"><span class="required">*</span>识别内容</label>
    <div class="select-wrap">
      <select id="ocr-type" :value="field.ocr?.type || ''" @change="changeType">
        <option value="">请选择识别内容</option>
        <option
          v-for="item in ocrTemplates"
          :key="item.value"
          :value="item.value"
        >
          {{ item.label }}
        </option></select
      ><AppIcon name="down" />
    </div>
    <button
      type="button"
      class="button full-width"
      :disabled="!template || !applySchema"
      @click="start"
    >
      识别规则设置
    </button>
  </div>
  <BaseDialog
    :open="open"
    title="识别规则设置"
    width="720px"
    @close="dismiss.requestClose"
  >
    <div class="ocr-rules">
      <section class="ocr-content-list">
        <p>1、选择要识别的内容</p>
        <label class="checkbox-line"
          ><input
            type="checkbox"
            :checked="allSelected"
            :indeterminate="!!selected.length && !allSelected"
            @change="
              selected = allSelected ? [] : contents.map((item) => item.id)
            "
          />全选</label
        >
        <label
          v-for="content in contents"
          :key="content.id"
          class="checkbox-line"
          ><input v-model="selected" type="checkbox" :value="content.id" />{{
            content.label
          }}</label
        >
        <label
          v-for="id in selected.filter(
            (id) => !contents.some((content) => content.id === id),
          )"
          :key="id"
          class="checkbox-line field-error"
          ><input
            v-model="selected"
            type="checkbox"
            :value="id"
          />识别内容已失效</label
        >
      </section>
      <section class="ocr-storage">
        <p>2、识别的内容如何存储</p>
        <div class="select-wrap">
          <select v-model="mode" aria-label="识别存储规则">
            <option value="new">存储到新字段</option>
            <option value="existing">存储到已有字段</option></select
          ><AppIcon name="down" />
        </div>
        <p v-if="mode === 'new'" class="hint">
          自动在表单中添加新的字段来存储识别出来的内容。
        </p>
        <div v-else class="ocr-mappings">
          <label v-for="content in selectedContents" :key="content.id"
            >{{ content.label }}
            <select
              v-model="mapped[content.id]"
              :aria-label="`${content.label}存储字段`"
            >
              <option value="">请选择字段</option>
              <option
                v-if="
                  mapped[content.id] &&
                  !ocrTargets(schema, content).some(
                    (item) => item.id === mapped[content.id],
                  )
                "
                :value="mapped[content.id]"
                disabled
              >
                字段已移除或类型不匹配
              </option>
              <option
                v-for="target in ocrTargets(schema, content)"
                :key="target.id"
                :value="target.id"
                :disabled="
                  selected.some(
                    (id) => id !== content.id && mapped[id] === target.id,
                  )
                "
              >
                {{ target.pathLabel }}
              </option>
            </select>
          </label>
        </div>
      </section>
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div
      v-if="dismiss.confirmDiscard.value"
      class="config-discard"
      tabindex="-1"
    >
      <p>修改尚未保存，是否放弃？</p>
      <button
        type="button"
        class="button"
        @click="dismiss.confirmDiscard.value = false"
      >
        继续编辑</button
      ><button type="button" class="button danger" @click="dismiss.discard">
        放弃修改
      </button>
    </div>
    <template #footer
      ><a
        class="ocr-help"
        href="https://hc.jiandaoyun.com/doc/12154"
        target="_blank"
        rel="noopener noreferrer"
        >如何设置识别规则？</a
      ><button type="button" class="button" @click="dismiss.requestClose">
        取消</button
      ><button
        type="button"
        class="button primary"
        :disabled="!selected.length"
        @click="finish"
      >
        完成
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.full-width {
  margin-top: 10px;
}
.ocr-rules {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  font-size: 13px;
}
.ocr-rules section {
  min-width: 0;
  max-height: 440px;
  overflow-y: auto;
}
.ocr-rules p {
  margin: 0 0 16px;
}
.ocr-content-list {
  padding-right: 12px;
  border-right: 1px solid var(--line);
}
.ocr-content-list .checkbox-line {
  min-height: 30px;
  margin-bottom: 6px;
}
.ocr-storage .hint {
  margin-top: 8px;
  line-height: 1.6;
}
.ocr-mappings {
  margin-top: 16px;
}
.ocr-mappings label {
  display: block;
  margin-bottom: 12px;
}
.ocr-mappings select {
  width: 100%;
  margin-top: 6px;
}
.ocr-help {
  margin-right: auto;
  font-size: 13px;
}
@media (max-width: 600px) {
  .ocr-rules {
    grid-template-columns: 1fr;
  }
  .ocr-content-list {
    max-height: 200px !important;
    border-right: 0;
    padding: 0;
  }
  .ocr-storage {
    max-height: 250px !important;
  }
}
</style>
