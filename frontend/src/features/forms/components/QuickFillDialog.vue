<script setup lang="ts">
import { saveFiles } from "../../../repositories/fileRepository";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import FieldControl from "./FieldControl.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import { copy, type FormSchema, type FormValues } from "../../../domain/form";
import { displayValue } from "../../../domain/relations";
import {
  normalizeQuickFill,
  prepareQuickFill,
  quickFillEmpty,
  quickFillFields,
  quickFillVisible,
  type QuickFillConfig,
  type QuickFillSource,
  type QuickFillExtraction,
} from "../../../domain/quickFill";
import { localQuickFillExtractor } from "../../../services/quickFillExtractor";
const props = defineProps<{
  open: boolean;
  config: QuickFillConfig;
  schema: FormSchema;
  values: FormValues;
  formId: string;
  preview?: boolean;
}>();
const emit = defineEmits<{ close: []; apply: [values: FormValues] }>();
const data = useRuntimeData(),
  source = ref<QuickFillSource>({ text: "", attachments: [] });
const extraction = ref<QuickFillExtraction>(),
  proposed = ref<FormValues>({}),
  selected = ref<string[]>([]),
  rowErrors = ref<Record<string, string>>({});
const step = ref<"input" | "review" | "confirm">("input"),
  busy = ref(false),
  uploading = ref(false),
  error = ref(""),
  acknowledged = ref(false);
const plan = ref<ReturnType<typeof prepareQuickFill>>(),
  baseline = ref<FormValues>({}),
  fingerprint = ref("");
let controller: AbortController | undefined;
let uploadEpoch = 0;
const fields = computed(() =>
  quickFillFields(props.schema).filter((f) =>
    props.config.fields.some((c) => c.fieldId === f.id),
  ),
);
const context = computed(() => ({
  ...baseline.value,
  ...Object.fromEntries(selected.value.map((id) => [id, proposed.value[id]])),
}));
const needsAcknowledgment = computed(() =>
  plan.value?.changes.some((c) => c.overwrite || c.indirect),
);
const { confirmDiscard, requestClose, discard } = useDraftDismiss(
  () => props.open,
  () => ({
    source: source.value,
    proposed: proposed.value,
    selected: selected.value,
  }),
  () => emit("close"),
);
const currentFingerprint = () =>
  JSON.stringify([props.values, props.schema, props.config]);
watch(
  () => props.open,
  (open) => {
    controller?.abort();
    uploadEpoch++;
    uploading.value = false;
    busy.value = false;
    if (!open) return;
    source.value = { text: "", attachments: [] };
    extraction.value = undefined;
    proposed.value = {};
    selected.value = [];
    rowErrors.value = {};
    step.value = "input";
    error.value = "";
    plan.value = undefined;
    acknowledged.value = false;
    baseline.value = copy(props.values);
    fingerprint.value = currentFingerprint();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  controller?.abort();
  uploadEpoch++;
});
function editValue(id: string, value: unknown) {
  proposed.value[id] = value;
  delete rowErrors.value[id];
  error.value = "";
  if (!selected.value.includes(id)) selected.value.push(id);
}
async function extract() {
  if (uploading.value) return;
  controller?.abort();
  controller = new AbortController();
  const task = controller;
  busy.value = true;
  error.value = "";
  try {
    const result = await localQuickFillExtractor.extract(
      props.config,
      props.schema,
      copy(source.value),
      task.signal,
    );
    if (task.signal.aborted || !props.open) return;
    extraction.value = result;
    const parsed = normalizeQuickFill(
      result,
      props.config,
      props.schema,
      baseline.value,
      data.value,
    );
    proposed.value = parsed.values;
    rowErrors.value = parsed.errors;
    selected.value = Object.keys(parsed.values).filter(
      (id) =>
        quickFillEmpty(baseline.value[id]) &&
        !quickFillEmpty(parsed.values[id]),
    );
    step.value = "review";
  } catch (e) {
    if (!task.signal.aborted) error.value = (e as Error).message;
  } finally {
    if (controller === task) busy.value = false;
  }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    files = Array.from(input.files || []);
  input.value = "";
  if (!files.length || uploading.value) return;
  const generation = uploadEpoch;
  error.value = "";
  if (source.value.attachments.length + files.length > 5) {
    error.value = "一次最多选择 5 张图片";
    return;
  }
  if (
    files.some(
      (f) =>
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          f.type,
        ) ||
        !f.size ||
        f.size > 5 * 1024 * 1024,
    )
  ) {
    error.value = "请选择 5 MB 以内的 PNG/JPEG/WebP/GIF 图片";
    return;
  }
  uploading.value = true;
  try {
    const stored = await saveFiles(files);
    const attachments = stored.map((value) => ({
      ...value,
      preview: value.preview || "",
    }));
    if (props.open && generation === uploadEpoch && step.value === "input")
      source.value.attachments.push(...attachments);
  } catch (cause) {
    if (generation === uploadEpoch)
      error.value =
        cause instanceof Error ? cause.message : "文件保存失败，请重试";
  } finally {
    if (generation === uploadEpoch) uploading.value = false;
  }
}
function makePlan() {
  if (fingerprint.value !== currentFingerprint())
    throw Error("表单内容或配置已变化，请关闭后重新解析");
  const unresolved = selected.value.find((id) => rowErrors.value[id]);
  if (unresolved) throw Error("请先修正已勾选字段的识别问题，或取消勾选");
  return prepareQuickFill(
    props.config,
    props.schema,
    baseline.value,
    proposed.value,
    selected.value,
    data.value,
    props.formId,
  );
}
function review() {
  error.value = "";
  try {
    plan.value = makePlan();
    if (!plan.value.changes.length)
      throw Error("所选内容与当前表单相同，无需回填");
    acknowledged.value = false;
    step.value = "confirm";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function apply() {
  error.value = "";
  try {
    const current = makePlan();
    if (JSON.stringify(current) !== JSON.stringify(plan.value)) {
      plan.value = current;
      acknowledged.value = false;
      throw Error("候选数据或联动结果已变化，请重新检查本次变更");
    }
    if (needsAcknowledgment.value && !acknowledged.value)
      throw Error("请确认覆盖和联动变化");
    emit("apply", copy(current.values));
    emit("close");
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>
<template>
  <BaseDialog
    :open="open"
    :title="preview ? '快捷填报预览' : 'AI 快捷填报'"
    width="850px"
    class-name="quick-fill-runtime-dialog"
    @close="requestClose"
  >
    <div class="quick-fill-dialog">
      <div v-if="confirmDiscard" class="config-discard" tabindex="-1">
        <span>本次输入和检查结果尚未回填。</span
        ><button class="button" @click="confirmDiscard = false">继续检查</button
        ><button class="button" @click="discard">放弃本次填报</button>
      </div>
      <div class="quick-fill-notice">
        <span class="mode-tag">本地规则演示</span>
        <p>
          未接入 AI 模型。按“字段名：内容”或 JSON
          匹配文字，不识别图片内文字；内容不会发送到外部服务。
        </p>
      </div>
      <ol class="quick-fill-steps">
        <li :class="{ active: step === 'input' }">1 输入内容</li>
        <li :class="{ active: step === 'review' }">2 检查字段</li>
        <li :class="{ active: step === 'confirm' }">3 确认回填</li>
      </ol>
      <p v-if="error" class="config-errors" role="alert">{{ error }}</p>
      <template v-if="step === 'input'">
        <label v-if="config.allowText" class="config-label"
          >需要填报的内容<textarea
            v-model="source.text"
            rows="8"
            maxlength="20000"
            placeholder="每行一个字段，例如：&#10;服务名称：设计服务&#10;金额：128.50"
          />
        </label>
        <div v-if="config.allowText" class="quick-fill-inline">
          <span class="field-hint">{{ source.text.length }} / 20,000 字</span
          ><button
            v-if="config.example"
            class="text-button"
            @click="source.text = config.example"
          >
            使用填报示例
          </button>
        </div>
        <label v-if="config.allowImages" class="config-label"
          >附上图片<input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            aria-label="选择填报图片"
            :disabled="uploading"
            @change="upload"
          /><span class="field-hint"
            >最多 5 张，每张 5
            MB；会回填到配置的图片或附件字段。当前仅保存文件信息，300 KB
            以内的图片可保留本地预览。</span
          ></label
        >
        <ul v-if="source.attachments.length" class="quick-fill-files">
          <li v-for="(file, index) in source.attachments" :key="index">
            <span>{{ file.name }}</span
            ><button
              class="text-button"
              :aria-label="`移除图片 ${file.name}`"
              @click="source.attachments.splice(index, 1)"
            >
              移除
            </button>
          </li>
        </ul>
      </template>
      <template v-else-if="step === 'review'">
        <p class="field-hint">
          只回填勾选项。已有内容默认不覆盖；无法匹配的结果可以手动选择或取消勾选。
        </p>
        <div v-if="!extraction?.suggestions.length" class="quick-fill-notice">
          没有匹配到字段。可以返回修改文字，或在下面手动填写。
        </div>
        <details
          v-if="extraction?.unmatched.length"
          class="quick-fill-unmatched"
        >
          <summary>未匹配内容（{{ extraction.unmatched.length }}）</summary>
          <p v-for="(line, index) in extraction.unmatched" :key="index">
            {{ line }}
          </p>
        </details>
        <article
          v-for="field in fields"
          :key="field.id"
          class="quick-fill-result"
          :class="{ selected: selected.includes(field.id) }"
        >
          <label class="quick-fill-check"
            ><input
              v-model="selected"
              type="checkbox"
              :value="field.id"
              :aria-label="`回填${field.label}`"
            /><strong>{{ field.label }}</strong
            ><span v-if="!quickFillEmpty(baseline[field.id])" class="mode-tag"
              >已有内容</span
            ></label
          >
          <template v-if="quickFillVisible(schema, field.id, context)">
            <p class="quick-fill-evidence">
              {{
                extraction?.suggestions.find((s) => s.fieldId === field.id)
                  ?.evidence || "未提取到内容，可手动填写"
              }}
            </p>
            <p
              v-if="
                config.fields.find((c) => c.fieldId === field.id)?.instruction
              "
              class="field-hint"
            >
              {{
                config.fields.find((c) => c.fieldId === field.id)?.instruction
              }}
            </p>
            <FieldControl
              :fields="schema.fields"
              :field="field"
              :model-value="proposed[field.id]"
              :values="context"
              :label="`检查${field.label}`"
              @update:model-value="editValue(field.id, $event)"
            />
            <p v-if="rowErrors[field.id]" class="field-error">
              {{ rowErrors[field.id] }}
            </p>
            <p v-if="!quickFillEmpty(baseline[field.id])" class="field-hint">
              当前值：{{ displayValue(field, baseline[field.id], data) }}
            </p>
          </template>
          <p v-else class="field-hint">
            当前条件下不可填写，请取消勾选或调整控制字段。
          </p>
        </article>
      </template>
      <template v-else>
        <h3>将修改 {{ plan?.changes.length }} 个字段</h3>
        <p class="field-hint">
          回填后仍可继续编辑，需要点击表单的“提交”才会保存记录。
        </p>
        <div class="quick-fill-diffs">
          <article v-for="change in plan?.changes" :key="change.id">
            <div>
              <strong>{{ change.label }}</strong
              ><span v-if="change.indirect" class="mode-tag">联动变化</span
              ><span v-else-if="change.overwrite" class="mode-tag"
                >覆盖已有值</span
              >
            </div>
            <p>
              <span>{{ change.before || "空值" }}</span
              ><b>→</b><span>{{ change.after || "清空" }}</span>
            </p>
          </article>
        </div>
        <label
          v-if="needsAcknowledgment"
          class="quick-fill-check quick-fill-ack"
          ><input
            v-model="acknowledged"
            type="checkbox"
          />我已检查并同意以上覆盖和联动变化</label
        >
      </template>
    </div>
    <template #footer
      ><button class="button" @click="requestClose">取消</button
      ><button
        v-if="step !== 'input'"
        class="button"
        @click="
          step = step === 'confirm' ? 'review' : 'input';
          error = '';
        "
      >
        上一步</button
      ><button
        v-if="step === 'input'"
        class="button primary"
        :disabled="busy || uploading"
        @click="extract"
      >
        {{
          uploading ? "正在读取图片…" : busy ? "正在解析…" : "解析并检查"
        }}</button
      ><button
        v-else-if="step === 'review'"
        class="button primary"
        :disabled="!selected.length"
        @click="review"
      >
        检查回填（{{ selected.length }}）</button
      ><button
        v-else
        class="button primary"
        :disabled="needsAcknowledgment && !acknowledged"
        @click="apply"
      >
        {{ preview ? "回填到预览" : "确认回填" }}
      </button></template
    >
  </BaseDialog>
</template>
