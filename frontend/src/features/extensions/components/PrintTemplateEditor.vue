<script setup lang="ts">
import { ref, watch, computed } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import { copy, type FormSchema } from "../../../domain/form";
import {
  newPrintTemplate,
  printFieldChoices,
  expandedPrintFieldIds,
  printTemplateIssues,
  type PrintTemplate,
} from "../../../domain/presentation";
import { sampleValues } from "../../../domain/extensions";
import { useWorkspaceStore } from "../../../stores/workspace";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import PresentationFields from "./PresentationFields.vue";
import SampleEditor from "./SampleEditor.vue";
import PrintDocument from "../../forms/components/PrintDocument.vue";
import RequestValueInput from "../../forms/components/RequestValueInput.vue";
import { titleFields } from "../../../domain/collaboration";
import type { ValueBinding } from "@platform/contracts";
const props = defineProps<{
  open: boolean;
  modelValue?: PrintTemplate;
  schema: FormSchema;
  formId: string;
  title: string;
}>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore(),
  config = ref(newPrintTemplate(props.schema, props.title)),
  values = ref(sampleValues(props.schema)),
  errors = ref<string[]>([]),
  tab = ref("layout"),
  saving = ref(false);
watch(
  () => props.open,
  (open) => {
    if (open) {
      config.value = copy(
        props.modelValue || newPrintTemplate(props.schema, props.title),
      );
      config.value.fileName ||= { mode: "default", value: "" };
      values.value = sampleValues(props.schema);
      errors.value = [];
      tab.value = "layout";
    }
  },
  { immediate: true },
);
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => props.open,
    () => config.value,
    () => emit("close"),
  );
const sizeLabel = computed(
  () =>
    `${config.value.paper} · ${config.value.orientation === "portrait" ? "纵向" : "横向"}`,
);
const fieldChoices = computed(() =>
  printFieldChoices(props.schema, store.data),
);
const fieldIds = computed({
  get: () => expandedPrintFieldIds(props.schema, config.value.fieldIds),
  set: (ids: string[]) => {
    config.value.fieldIds = ids;
  },
});
const fileName = computed(() => config.value.fileName!);
const fileNameBinding = computed({
  get: (): ValueBinding => ({
    source: "template",
    value: fileName.value.value,
  }),
  set: (binding: ValueBinding) => {
    fileName.value.value = binding.value;
  },
});
async function save() {
  if (saving.value) return;
  errors.value = printTemplateIssues(config.value, props.schema, store.data);
  if (errors.value.length) return;
  saving.value = true;
  try {
    if (await store.savePrintTemplate(props.formId, copy(config.value))) {
      markSaved();
      store.notify("打印模板已保存，发布新版本后生效");
      emit("close");
    } else
      errors.value = [
        store.storageError || "保存未完成，模板修改已保留，请重试。",
      ];
  } catch {
    errors.value = ["保存失败，模板修改已保留，请重试。"];
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <BaseDialog
    :open="open"
    :draft-key="draftKey"
    :busy="saving"
    :title="modelValue ? '编辑打印模板' : '新建打印模板'"
    width="1180px"
    @close="!saving && requestClose()"
  >
    <div v-if="confirmDiscard" class="config-discard" tabindex="-1">
      <span>模板尚未保存，关闭后会丢失修改。</span
      ><button class="button" @click="confirmDiscard = false">继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </div>
    <div class="print-designer">
      <section class="print-controls">
        <label class="config-label"
          >模板名称<input
            v-model="config.name"
            maxlength="80"
            placeholder="例如：报销审批单"
        /></label>
        <div class="presentation-tabs">
          <button :class="{ active: tab === 'layout' }" @click="tab = 'layout'">
            版式与内容</button
          ><button
            :class="{ active: tab === 'fields' }"
            @click="tab = 'fields'"
          >
            字段与顺序</button
          ><button
            :class="{ active: tab === 'sample' }"
            @click="tab = 'sample'"
          >
            预览数据
          </button>
        </div>
        <template v-if="tab === 'layout'">
          <label class="config-label"
            >打印标题<input
              v-model="config.title"
              maxlength="120"
              :placeholder="title" /></label
          ><label class="config-label"
            >标题说明<textarea
              v-model="config.subtitle"
              maxlength="300"
              rows="2"
              placeholder="可填写单位名称或单据说明"
            />
          </label>
          <div class="presentation-options">
            <label
              >纸张<select v-model="config.paper">
                <option>A4</option>
                <option>A5</option>
              </select></label
            ><label
              >方向<select v-model="config.orientation">
                <option value="portrait">纵向</option>
                <option value="landscape">横向</option>
              </select></label
            ><label
              >字段布局<select v-model.number="config.columns">
                <option :value="1">单列</option>
                <option :value="2">双列</option>
              </select></label
            ><label
              >字号<select v-model.number="config.fontSize">
                <option :value="12">12 px</option>
                <option :value="14">14 px</option>
                <option :value="16">16 px</option>
              </select></label
            >
          </div>
          <div class="presentation-checks">
            <label
              ><input
                type="checkbox"
                v-model="config.hideEmpty"
              />隐藏未填写字段</label
            ><label
              ><input
                type="checkbox"
                v-model="config.showMetadata"
              />显示记录编号、时间和版本</label
            ><label
              ><input
                type="checkbox"
                v-model="config.showHistory"
              />包含操作记录</label
            >
          </div>
          <label class="config-label"
            >页尾说明<textarea
              v-model="config.footer"
              maxlength="300"
              rows="2"
              placeholder="例如：经办人签字：________"
            />
          </label>
          <div class="config-label">
            <span>生成的文件名称</span>
            <div
              class="presentation-field-options"
              role="radiogroup"
              aria-label="生成的文件名称"
            >
              <label
                ><input
                  v-model="fileName.mode"
                  type="radio"
                  value="default"
                  name="print-filename"
                />默认名称</label
              >
              <label
                ><input
                  v-model="fileName.mode"
                  type="radio"
                  value="title"
                  name="print-filename"
                />数据标题名称</label
              >
              <label
                ><input
                  v-model="fileName.mode"
                  type="radio"
                  value="custom"
                  name="print-filename"
                />自定义名称</label
              >
            </div>
            <RequestValueInput
              v-if="fileName.mode === 'custom'"
              v-model="fileNameBinding"
              :fields="titleFields(schema)"
              label="自定义文件名称"
              placeholder="例如：发货单-单号"
            />
          </div>
        </template>
        <template v-else-if="tab === 'fields'"
          ><label class="config-label"
            >展示范围<select v-model="config.fieldMode">
              <option value="all">全部字段，随表单顺序</option>
              <option value="custom">指定字段和顺序</option>
            </select></label
          ><PresentationFields
            v-if="config.fieldMode === 'custom'"
            v-model="fieldIds"
            :schema="schema"
            :options="fieldChoices"
          />
          <p class="field-hint">
            选中的明细字段按行展示。字段改名不影响绑定；删除后会提示修复。
          </p></template
        >
        <SampleEditor
          v-else
          v-model="values"
          :schema="schema"
          :form-id="formId"
        />
        <ul v-if="errors.length" class="config-errors" role="alert">
          <li v-for="error in errors" :key="error">{{ error }}</li>
        </ul>
      </section>
      <section class="print-preview-panel" aria-label="打印实时预览">
        <div class="print-preview-label">
          <span>{{ sizeLabel }}</span
          ><span>内容预览 · 分页以打印对话框为准</span>
        </div>
        <PrintDocument
          :template="config"
          :schema="schema"
          :values="values"
          :title="title"
        />
      </section>
    </div>
    <template #footer
      ><button class="button" @click="requestClose">取消</button
      ><button class="button primary" @click="save">保存模板</button></template
    >
  </BaseDialog>
</template>
