<script setup lang="ts">
import { computed, ref } from "vue";
import type { FrontendRequest } from "@platform/contracts";
import { copy, type FormField } from "../../../domain/form";
import {
  newFrontendRequest,
  requestOutputTypes,
  requestParameterIssues,
  validateResponsePath,
} from "../../../domain/frontendRequests";
import { bindingReferences } from "../../../domain/extensions";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import RequestValueInput from "./RequestValueInput.vue";
const props = defineProps<{
  modelValue: FrontendRequest;
  fields: FormField[];
  outputs: (FormField & { parentId?: string })[];
}>();
const emit = defineEmits<{ "update:modelValue": [request: FrontendRequest] }>();
const mode = ref<"parameters" | "outputs">("parameters"),
  open = ref(false),
  error = ref("");
const draft = ref(newFrontendRequest());
const dismiss = useDraftDismiss(
  () => open.value,
  () => draft.value,
  () => (open.value = false),
);
const hasDetails = computed(() =>
  draft.value.outputs.some(
    (mapping) =>
      props.outputs.find((field) => field.id === mapping.fieldId)?.parentId,
  ),
);
const availableOutputs = computed(() =>
  props.outputs.filter((field) => requestOutputTypes.has(field.type)),
);
function edit(next: typeof mode.value) {
  mode.value = next;
  draft.value = copy(props.modelValue);
  error.value = "";
  open.value = true;
  if (next === "parameters") {
    if (!draft.value.headers.length)
      draft.value.headers.push({
        name: "",
        value: { source: "template", value: "" },
      });
    if (draft.value.method === "POST" && !draft.value.body.length)
      draft.value.body.push({
        name: "",
        value: { source: "template", value: "" },
      });
  }
  dismiss.markSaved();
}
function patch(part: Partial<FrontendRequest>) {
  emit("update:modelValue", { ...props.modelValue, ...part });
}
function apply() {
  if (mode.value === "parameters") {
    draft.value.headers = draft.value.headers.filter(
      (row) => row.name || row.value.value,
    );
    draft.value.body = draft.value.body.filter(
      (row) => row.name || row.value.value,
    );
    error.value = requestParameterIssues(draft.value)[0]?.message || "";
  } else {
    error.value = "";
    const seen = new Set<string>();
    for (const row of draft.value.outputs) {
      if (
        !props.outputs.some(
          (field) =>
            field.id === row.fieldId && requestOutputTypes.has(field.type),
        ) ||
        !row.path.value.trim()
      ) {
        error.value = "请选择回填字段并填写解析路径";
        break;
      }
      if (seen.has(row.fieldId)) {
        error.value = "同一字段只能配置一个返回值";
        break;
      }
      seen.add(row.fieldId);
      if (!bindingReferences(row.path).length)
        try {
          validateResponsePath(draft.value.responseFormat, row.path.value);
        } catch {
          error.value = `请输入有效的${draft.value.responseFormat === "json" ? "JSON Path" : "XPath"}`;
          break;
        }
    }
  }
  if (error.value) return;
  patch(
    mode.value === "parameters"
      ? {
          headers: copy(draft.value.headers),
          body: copy(draft.value.body),
          bodyFormat: draft.value.bodyFormat,
        }
      : {
          outputs: copy(draft.value.outputs),
          subformFill: draft.value.subformFill,
        },
  );
  dismiss.markSaved();
  open.value = false;
}
</script>
<template>
  <div class="frontend-request-settings">
    <div class="form-group">
      <label>请求类型</label>
      <div class="request-radio-row">
        <label v-for="method in ['GET', 'POST']" :key="method"
          ><input
            type="radio"
            :checked="modelValue.method === method"
            name="frontend-request-method"
            @change="patch({ method: method as FrontendRequest['method'] })"
          />{{ method }}</label
        >
      </div>
    </div>
    <div class="form-group">
      <label class="request-url-label">URL</label
      ><RequestValueInput
        :model-value="modelValue.url"
        :fields="fields"
        label="请求URL"
        :rows="3"
        @update:model-value="patch({ url: $event })"
      />
    </div>
    <div class="form-group">
      <label>Header/Body</label
      ><button
        class="button request-settings-button"
        @click="edit('parameters')"
      >
        点击设置
      </button>
    </div>
    <div class="form-group">
      <label>返回值格式</label>
      <div class="request-radio-row">
        <label v-for="format in ['json', 'xml']" :key="format"
          ><input
            type="radio"
            name="frontend-response-format"
            :checked="modelValue.responseFormat === format"
            @change="
              patch({
                responseFormat: format as FrontendRequest['responseFormat'],
              })
            "
          />{{ format.toUpperCase() }}</label
        >
      </div>
    </div>
    <div class="form-group">
      <label>返回值设置</label
      ><button class="button request-settings-button" @click="edit('outputs')">
        点击设置
      </button>
    </div>
    <p class="field-hint">请求使用模拟返回数据，不会连接外部服务器。</p>
    <details class="request-simulation">
      <summary>模拟返回数据</summary>
      <label
        >状态码<input
          type="number"
          aria-label="模拟响应状态码"
          min="100"
          max="599"
          :value="modelValue.simulation.status"
          @input="
            patch({
              simulation: {
                ...modelValue.simulation,
                status: Number(($event.target as HTMLInputElement).value),
              },
            })
          " /></label
      ><textarea
        aria-label="模拟返回数据"
        :value="modelValue.simulation.response"
        rows="6"
        :placeholder="
          modelValue.responseFormat === 'json'
            ? '输入JSON返回示例'
            : '输入XML返回示例'
        "
        @input="
          patch({
            simulation: {
              ...modelValue.simulation,
              response: ($event.target as HTMLTextAreaElement).value,
            },
          })
        "
      />
    </details>
  </div>
  <BaseDialog
    :open="open"
    :title="mode === 'parameters' ? 'Header/Body设置' : '返回值设置'"
    width="600px"
    class-name="frontend-request-dialog"
    @close="dismiss.requestClose"
  >
    <template v-if="mode === 'parameters'">
      <section
        v-for="group in modelValue.method === 'POST'
          ? ['headers', 'body']
          : ['headers']"
        :key="group"
        class="request-parameter-group"
      >
        <label class="request-section-label">{{
          group === "headers" ? "Header" : "Body"
        }}</label>
        <div v-if="group === 'body'" class="request-radio-row">
          <label
            ><input
              v-model="draft.bodyFormat"
              type="radio"
              value="json"
            />JSON</label
          ><label
            ><input
              v-model="draft.bodyFormat"
              type="radio"
              value="form"
            />x-www-form-urlencoded</label
          >
        </div>
        <div
          v-for="(row, index) in draft[group as 'headers' | 'body']"
          :key="index"
          class="request-parameter-row"
        >
          <input
            v-model="row.name"
            :aria-label="`${group === 'headers' ? 'Header' : 'Body'}名称 ${index + 1}`"
            placeholder="name"
            maxlength="100"
          /><RequestValueInput
            v-model="row.value"
            :fields="fields"
            :label="`${group === 'headers' ? 'Header' : 'Body'}值 ${index + 1}`"
            placeholder="value"
          /><button
            class="icon-button"
            :aria-label="`删除${group === 'headers' ? 'Header' : 'Body'} ${index + 1}`"
            @click="draft[group as 'headers' | 'body'].splice(index, 1)"
          >
            <AppIcon name="trash" :size="14" />
          </button>
        </div>
        <button
          class="text-button"
          :disabled="draft[group as 'headers' | 'body'].length >= 50"
          @click="
            draft[group as 'headers' | 'body'].push({
              name: '',
              value: { source: 'template', value: '' },
            })
          "
        >
          <AppIcon name="add" :size="14" />{{
            group === "headers" ? "Header" : "Body"
          }}
        </button>
      </section>
    </template>
    <template v-else>
      <p class="field-hint">解析返回值并将其赋值给表单字段</p>
      <div
        v-for="(row, index) in draft.outputs"
        :key="index"
        class="request-mapping-row"
      >
        <select v-model="row.fieldId" :aria-label="`返回表单字段 ${index + 1}`">
          <option value="">选择表单字段</option>
          <option
            v-if="
              row.fieldId && !outputs.some((field) => field.id === row.fieldId)
            "
            :value="row.fieldId"
          >
            字段已移除或不在当前范围
          </option>
          <option
            v-for="field in availableOutputs"
            :key="field.id"
            :value="field.id"
          >
            {{ field.label }}
          </option></select
        ><RequestValueInput
          v-model="row.path"
          :fields="fields"
          :label="`返回值路径 ${index + 1}`"
          :placeholder="
            draft.responseFormat === 'json'
              ? '$.data.amount'
              : '/result/amount/text()'
          "
        /><button
          class="icon-button"
          :aria-label="`删除返回值 ${index + 1}`"
          @click="draft.outputs.splice(index, 1)"
        >
          <AppIcon name="trash" :size="14" />
        </button>
      </div>
      <button
        class="text-button"
        :disabled="draft.outputs.length >= 100"
        @click="
          draft.outputs.push({
            fieldId: '',
            path: { source: 'template', value: '' },
          })
        "
      >
        <AppIcon name="add" :size="14" />表单字段及对应返回值
      </button>
      <div v-if="hasDetails" class="form-group request-fill-mode">
        <label>子表单填充方式</label
        ><label class="checkbox-line"
          ><input
            v-model="draft.subformFill"
            type="radio"
            value="merge"
          />直接填充到对应子字段</label
        ><label class="checkbox-line"
          ><input
            v-model="draft.subformFill"
            type="radio"
            value="replace"
          />先清空子表单再填充</label
        >
      </div>
    </template>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div v-if="dismiss.confirmDiscard.value" class="config-discard">
      <p>修改尚未保存，是否放弃？</p>
      <button class="button" @click="dismiss.confirmDiscard.value = false">
        继续编辑</button
      ><button class="button danger" @click="dismiss.discard">放弃修改</button>
    </div>
    <template #footer
      ><button class="button" @click="dismiss.requestClose">取消</button
      ><button class="button primary" @click="apply">确定</button></template
    >
  </BaseDialog>
</template>
<style>
.event-config-content .form-group > .request-url-label {
  height: 26px;
}
.request-radio-row {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 32px;
}
.request-radio-row label {
  display: flex;
  align-items: center;
  gap: 4px !important;
  margin: 0 !important;
  font-size: 13px !important;
  font-weight: 400 !important;
}
.request-radio-row input {
  width: auto !important;
  accent-color: var(--teal);
}
.request-settings-button {
  width: 200px;
  max-width: 100%;
  height: 32px;
  padding: 0 12px;
}
.request-simulation summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--teal);
}
.request-simulation label {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 10px 0 !important;
}
.request-simulation input {
  max-width: 100px;
}
.request-simulation textarea {
  width: 100%;
  font-size: 13px;
  font-family: monospace;
}
.frontend-request-dialog {
  height: 450px;
}
.frontend-request-dialog .dialog-header {
  min-height: 51px;
  padding: 12px 20px;
}
.frontend-request-dialog .dialog-header h2 {
  font-size: 20px;
  line-height: 26px;
}
.frontend-request-dialog .dialog-header > .icon-button {
  width: 24px;
  height: 24px;
  min-height: 24px;
}
.frontend-request-dialog .dialog-body {
  padding: 20px;
}
.frontend-request-dialog .dialog-footer {
  min-height: 57px;
  padding: 12px 20px;
}
.frontend-request-dialog .dialog-footer button {
  height: 32px;
  min-width: 0;
  padding: 0 12px;
  font-size: 14px;
}
.request-section-label {
  display: block;
  margin-bottom: 12px;
  font-size: 14px;
}
.request-parameter-group + .request-parameter-group {
  border-top: 1px solid var(--border);
  margin-top: 59px;
  padding-top: 20px;
}
.request-parameter-row {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr) 24px;
  gap: 10px;
  margin: 12px 0;
}
.request-parameter-row > input {
  min-width: 0;
  font-size: 13px;
}
.request-mapping-row {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) 24px;
  gap: 10px;
  margin: 16px 0;
}
.request-mapping-row > select {
  min-width: 0;
  font-size: 13px;
}
.request-fill-mode {
  margin-top: 24px;
}
.request-fill-mode > label {
  margin-bottom: 12px;
}
@media (max-width: 650px) {
  .request-parameter-row,
  .request-mapping-row {
    grid-template-columns: minmax(0, 1fr) 24px;
    gap: 8px;
  }
  .request-parameter-row > input,
  .request-mapping-row > select {
    grid-column: 1/-1;
  }
  .request-radio-row {
    flex-wrap: wrap;
    gap: 12px;
  }
  .request-value-input select {
    width: 96px;
  }
}
</style>
