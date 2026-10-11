<script setup lang="ts">
import { computed, ref, watch } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import DataFilterEditor from "../../forms/components/DataFilterEditor.vue";
import FieldControl from "../../forms/components/FieldControl.vue";
import SampleEditor from "./SampleEditor.vue";
import { sampleValues } from "../../../domain/extensions";
import { useWorkspaceStore } from "../../../stores/workspace";
import { restoreButtonDraft } from "../../../domain/extensionDraftAdapters";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { copy, type FormValues, type FormSchema } from "../../../domain/form";
import { runtimeDefaults } from "../../../domain/relations";
import {
  newButton,
  buttonPositions,
  buttonActions,
  buttonSources,
  buttonTargets,
  buttonIssues,
  prepareButton,
  type CustomButton,
  type ButtonResult,
} from "../../../domain/buttons";
const props = defineProps<{
  open: boolean;
  modelValue?: CustomButton;
  schema: FormSchema;
  formId: string;
}>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore(),
  config = ref(newButton()),
  step = ref(0),
  error = ref(""),
  sample = ref<FormValues>({}),
  trial = ref<ButtonResult>(),
  saving = ref(false);
const sources = computed(() => buttonSources(props.schema));
const destinations = computed(() =>
  store.data.forms.filter((f) => !f.archived && f.published),
);
const destination = computed(() =>
  config.value.action === "openForm"
    ? destinations.value.find((f) => f.id === config.value.targetFormId)
        ?.published?.schema
    : props.schema,
);
const targets = computed(() =>
  destination.value ? buttonTargets(destination.value) : [],
);
const constantContext = computed(() => ({
  ...(destination.value
    ? runtimeDefaults(destination.value.fields, store.data)
    : {}),
  ...Object.fromEntries(
    config.value.mappings
      .filter((m) => m.source === "constant")
      .map((m) => [m.targetId, m.value]),
  ),
}));
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    config.value = copy(props.modelValue || newButton());
    step.value = 0;
    error.value = "";
    sample.value = sampleValues(props.schema);
    trial.value = undefined;
  },
  { immediate: true },
);
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => props.open,
    () => config.value,
    () => emit("close"),
    {
      key: () => `button:${props.formId}:${props.modelValue?.id || "new"}`,
      title: () => `自定义按钮 · ${config.value.name || "未命名按钮"}`,
      context: () => ({
        schema: props.schema,
        original: props.modelValue || null,
        member: store.data.organization.currentUserId,
      }),
      restore: (value) => {
        config.value = restoreButtonDraft(value, props.modelValue?.id);
        step.value = 0;
        error.value = "";
        sample.value = sampleValues(props.schema);
        trial.value = undefined;
        confirmDiscard.value = false;
      },
    },
  );
watch(
  [config, sample],
  () => {
    trial.value = undefined;
  },
  { deep: true },
);
function actionChange() {
  config.value.mappings = [];
  config.value.params = [];
  trial.value = undefined;
}
function next() {
  const issue = buttonIssues(config.value, props.schema, store.data).find(
    (i) => i.step <= step.value,
  );
  if (issue) {
    error.value = issue.message;
    step.value = issue.step;
    return;
  }
  error.value = "";
  step.value++;
}
function test() {
  trial.value = prepareButton(
    config.value,
    props.schema,
    sample.value,
    store.data,
    config.value.positions[0] || "fill",
    true,
  );
}
async function save() {
  if (saving.value) return;
  const issue = buttonIssues(config.value, props.schema, store.data)[0];
  if (issue) {
    error.value = issue.message;
    step.value = issue.step;
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    if (await store.saveButton(props.formId, copy(config.value))) {
      markSaved();
      store.notify("按钮已保存，发布新版本后生效");
      emit("close");
    } else
      error.value =
        store.storageError || "保存未完成，按钮配置已保留，请重试。";
  } catch {
    error.value = "保存失败，按钮配置已保留，请重试。";
  } finally {
    saving.value = false;
  }
}
function addMapping() {
  config.value.mappings.push({
    targetId: "",
    source: "constant",
    fieldId: "",
    value: "",
  });
}
function positionsLabel(c: CustomButton) {
  return c.positions.map((p) => buttonPositions[p]).join("、");
}
</script>
<template>
  <BaseDialog
    :open="open"
    :draft-key="draftKey"
    :busy="saving"
    :title="modelValue ? '编辑自定义按钮' : '新建自定义按钮'"
    width="920px"
    @close="!saving && requestClose()"
  >
    <div v-if="confirmDiscard" class="config-discard" tabindex="-1">
      <span>配置尚未保存。</span
      ><button type="button" class="button" @click="confirmDiscard = false">
        继续编辑</button
      ><button type="button" class="button" @click="discard">放弃修改</button>
    </div>
    <div class="button-editor-steps">
      <span
        v-for="(label, i) in ['显示在哪里', '点击做什么', '检查与保存']"
        :key="label"
        :class="{ active: step === i }"
        >{{ i + 1 }} · {{ label }}</span
      >
    </div>
    <p v-if="error" role="alert" class="field-error">{{ error }}</p>
    <div class="button-editor-body">
      <section v-if="step === 0" class="button-config-fields">
        <label
          >按钮名称<input
            v-model="config.name"
            maxlength="30"
            placeholder="例如：标记已处理"
        /></label>
        <fieldset>
          <legend>显示位置</legend>
          <label
            v-for="(name, value) in buttonPositions"
            :key="value"
            class="button-check"
            ><input
              v-model="config.positions"
              type="checkbox"
              :value="value"
            />{{ name }}</label
          >
        </fieldset>
        <div class="button-inline-checks">
          <label class="button-check"
            ><input v-model="config.primary" type="checkbox" />突出显示</label
          ><label class="button-check"
            ><input v-model="config.enabled" type="checkbox" />启用按钮</label
          >
        </div>
        <DataFilterEditor
          v-model="config.filters"
          :source-fields="sources"
          :local-fields="sources"
          hint="同时满足以下条件时才显示按钮；不设置则始终显示。"
          source-placeholder="选择条件字段"
        />
      </section>
      <section v-else-if="step === 1" class="button-config-fields">
        <label
          >点击动作<select v-model="config.action" @change="actionChange">
            <option
              v-for="(label, key) in buttonActions"
              :key="key"
              :value="key"
            >
              {{ label }}
            </option>
          </select></label
        >
        <template v-if="config.action === 'link'">
          <label
            >链接地址<input
              v-model="config.url"
              placeholder="https://example.com/orders"
          /></label>
          <p class="field-hint">
            参数会自动编码到链接中；点击时先显示完整地址，再由使用者确认打开。
          </p>
          <div
            v-for="(p, i) in config.params"
            :key="i"
            class="button-mapping-row"
          >
            <input
              v-model="p.name"
              :aria-label="`参数 ${i + 1} 名称`"
              placeholder="参数名称"
            /><select
              v-model="p.binding.source"
              :aria-label="`参数 ${i + 1} 来源`"
            >
              <option value="constant">固定值</option>
              <option value="field">表单字段</option></select
            ><select
              v-if="p.binding.source === 'field'"
              v-model="p.binding.fieldId"
              :aria-label="`参数 ${i + 1} 字段`"
            >
              <option value="">选择字段</option>
              <option v-for="f in sources" :key="f.id" :value="f.id">
                {{ f.label }}
              </option></select
            ><input
              v-else
              v-model="p.binding.value"
              :aria-label="`参数 ${i + 1} 固定值`"
              placeholder="参数值"
            /><button
              type="button"
              class="icon-button"
              :aria-label="`删除参数 ${i + 1}`"
              @click="config.params.splice(i, 1)"
            >
              <AppIcon name="trash" />
            </button>
          </div>
          <button
            type="button"
            class="text-button"
            @click="
              config.params.push({
                name: '',
                binding: { source: 'constant', fieldId: '', value: '' },
              })
            "
          >
            ＋ 添加链接参数
          </button>
        </template>
        <template v-else>
          <label v-if="config.action === 'openForm'"
            >目标表单<select
              v-model="config.targetFormId"
              @change="config.mappings = []"
            >
              <option value="">选择已发布表单</option>
              <option v-for="f in destinations" :key="f.id" :value="f.id">
                {{ f.title }} · V{{ f.published?.version }}
              </option>
            </select></label
          >
          <p class="field-hint">
            {{
              config.action === "update"
                ? "填写页更新当前内容；详情和列表更新已提交记录。只允许写入可编辑字段。"
                : "按目标表单最新发布版本带入数据，用户检查后手动提交。选择项按标识或唯一名称对应。"
            }}
          </p>
          <div
            v-for="(m, i) in config.mappings"
            :key="i"
            class="button-mapping-row"
          >
            <select
              v-model="m.targetId"
              :aria-label="`映射 ${i + 1} 目标字段`"
              @change="m.value = ''"
            >
              <option value="">选择目标字段</option>
              <option v-for="f in targets" :key="f.id" :value="f.id">
                {{ f.label }}
              </option>
            </select>
            <select v-model="m.source" :aria-label="`映射 ${i + 1} 值来源`">
              <option value="constant">固定值</option>
              <option value="field">表单字段</option>
            </select>
            <select
              v-if="m.source === 'field'"
              v-model="m.fieldId"
              :aria-label="`映射 ${i + 1} 来源字段`"
            >
              <option value="">选择来源字段</option>
              <option v-for="f in sources" :key="f.id" :value="f.id">
                {{ f.label }}
              </option>
            </select>
            <FieldControl
              v-else-if="targets.find((f) => f.id === m.targetId)"
              v-model="m.value"
              :field="targets.find((f) => f.id === m.targetId)!"
              :values="constantContext"
              :label="`映射 ${i + 1} 固定值`"
            />
            <span v-else class="field-hint">先选择目标字段</span>
            <button
              type="button"
              class="icon-button"
              :aria-label="`删除映射 ${i + 1}`"
              @click="config.mappings.splice(i, 1)"
            >
              <AppIcon name="trash" />
            </button>
          </div>
          <button
            type="button"
            class="text-button"
            :disabled="!destination"
            @click="addMapping"
          >
            ＋ 添加字段映射
          </button>
        </template>
        <label
          >确认提示 <span class="muted">可选</span
          ><textarea
            v-model="config.confirmation"
            rows="2"
            placeholder="例如：请确认本次变更，保存后会通知负责人。"
          />
        </label>
      </section>
      <section v-else class="button-config-fields">
        <div class="button-preview">
          <span class="field-hint">按钮外观</span
          ><button
            type="button"
            class="button"
            :class="{ primary: config.primary }"
            @click="test"
          >
            {{ config.name }}</button
          ><span
            >{{ positionsLabel(config) }} ·
            {{ buttonActions[config.action] }}</span
          >
        </div>
        <SampleEditor v-model="sample" :schema="schema" :form-id="formId" />
        <p class="field-hint">
          检查只计算结果，不更新记录或打开链接。运行时会再次检查字段和显示条件。
        </p>
        <button type="button" class="button" @click="test">检查操作结果</button>
        <div v-if="trial" class="button-trial-result" role="status">
          <strong>{{
            trial.status === "ready"
              ? "检查通过"
              : trial.status === "hidden"
                ? "当前条件下不显示"
                : "检查未通过"
          }}</strong>
          <p>{{ trial.message }}</p>
          <p v-if="trial.url" class="button-url-preview">{{ trial.url }}</p>
          <div class="button-change-list">
            <div v-for="c in trial.changes" :key="c.id">
              <strong>{{ c.label }}</strong
              ><span>{{ c.before }} → {{ c.after }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
    <template #footer
      ><button type="button" class="button" @click="requestClose">取消</button
      ><button
        v-if="step"
        type="button"
        class="button"
        @click="
          step--;
          error = '';
        "
      >
        上一步</button
      ><button
        v-if="step < 2"
        type="button"
        class="button primary"
        @click="next"
      >
        下一步</button
      ><button
        v-else
        type="button"
        class="button primary"
        :disabled="saving"
        @click="save"
      >
        {{ saving ? "正在保存…" : "保存按钮" }}
      </button></template
    >
  </BaseDialog>
</template>
