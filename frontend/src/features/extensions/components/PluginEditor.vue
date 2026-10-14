<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import BindingEditor from "./BindingEditor.vue";
import SampleEditor from "./SampleEditor.vue";
import RunTrace from "./RunTrace.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { copy, type FormSchema, type FormValues } from "../../../domain/form";

import {
  configurableFields,
  pluginRegistry,
  newInvocation,
  parseInvocation,
  validateInvocation,
  compatibleField,
  resolveBinding,
  runPlugin,
  sampleValues,
  type PluginInvocation,
  type ExtensionRun,
  type ConfigIssue,
} from "../../../domain/extensions";
import { useRuntimeData } from "../../../composables/useRuntimeData";
const props = defineProps<{
  open: boolean;
  modelValue?: PluginInvocation;
  legacy?: string;
  schema: FormSchema;
  formId: string;
  nodeId: string;
  saveConfig: (config: PluginInvocation) => boolean | Promise<boolean>;
  saveLabel?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const saving = ref(false),
  saveError = ref(""),
  pendingAction = ref("");
const runtimeData = useRuntimeData();
const step = ref(0),
  config = ref(newInvocation()),
  query = ref(""),
  errors = ref<ConfigIssue[]>([]),
  values = ref<FormValues>({}),
  result = ref<ExtensionRun>(),
  failure = ref(false),
  testedFingerprint = ref("");
const steps = ["选择动作", "输入参数", "结果回填", "试运行"];
const fields = computed(() => configurableFields(props.schema));
const definition = computed(() =>
  pluginRegistry.find((p) => p.id === config.value.actionId),
);
const definitions = computed(() =>
  pluginRegistry.filter((p) => (p.name + p.description).includes(query.value)),
);
const fingerprint = computed(() =>
  JSON.stringify({
    config: config.value,
    values: values.value,
    failure: failure.value,
    schema: props.schema,
  }),
);
const stale = computed(
  () => result.value && testedFingerprint.value !== fingerprint.value,
);
const resolved = computed(() =>
  Object.fromEntries(
    (definition.value?.inputs || []).map((p) => {
      try {
        return [
          p.label,
          resolveBinding(config.value.inputs[p.key]!, values.value, p.type),
        ];
      } catch {
        return [p.label, "尚未提供有效输入"];
      }
    }),
  ),
);
watch(
  () => props.open,
  (open) => {
    if (open) {
      config.value = parseInvocation(props.modelValue, props.legacy);
      step.value = config.value.actionId ? 1 : 0;
      values.value = sampleValues(props.schema);
      result.value = undefined;
      errors.value = [];
      failure.value = false;
      testedFingerprint.value = "";
      query.value = "";
      saveError.value = "";
      pendingAction.value = "";
    }
  },
  { immediate: true },
);
function choose(id: string) {
  if (id === config.value.actionId) {
    step.value = 1;
    return;
  }
  if (
    config.value.actionId &&
    JSON.stringify(config.value) !==
      JSON.stringify(newInvocation(config.value.actionId))
  ) {
    pendingAction.value = id;
    return;
  }
  changeAction(id);
}
function changeAction(id: string) {
  config.value = newInvocation(id);
  result.value = undefined;
  errors.value = [];
  step.value = 1;
  pendingAction.value = "";
  saveError.value = "";
  testedFingerprint.value = "";
}
function next() {
  errors.value = validateInvocation(config.value, props.schema).filter(
    (i) => i.step === step.value,
  );
  if (!errors.value.length) step.value = Math.min(3, step.value + 1);
}
function locate(issue: ConfigIssue) {
  step.value = issue.step;
  errors.value = [issue];
  nextTick(() => document.getElementById(issue.target)?.focus());
}
// 试算只更新当前对话框，不写入业务记录或执行日志。
function trial() {
  errors.value = [];
  const previous = result.value;
  result.value = runPlugin(
    config.value,
    props.schema,
    values.value,
    runtimeData.value,
    failure.value,
    props.nodeId,
  );
  if (previous?.status === "failed") result.value.retryOf = previous.id;
  testedFingerprint.value = fingerprint.value;
}
async function save() {
  if (saving.value) return;
  saveError.value = "";
  errors.value = validateInvocation(config.value, props.schema);
  if (errors.value.length) {
    locate(errors.value[0]!);
    return;
  }
  saving.value = true;
  try {
    if (await props.saveConfig(copy(config.value))) {
      markSaved();
      emit("close");
    } else saveError.value = "保存未完成，配置已保留，请重试。";
  } catch {
    saveError.value = "保存失败，配置已保留，请重试。";
  } finally {
    saving.value = false;
  }
}
function map(outputKey: string, fieldId: string) {
  config.value.outputs = config.value.outputs.filter(
    (m) => m.outputKey !== outputKey,
  );
  if (fieldId) config.value.outputs.push({ outputKey, fieldId });
}
const { confirmDiscard, requestClose, discard, markSaved } =
  useDraftDismiss(
    () => props.open,
    () => config.value,
    () => emit("close"),
  );
</script>
<template>
  <BaseDialog
    :open="open"
    :busy="saving"
    title="配置插件动作"
    width="1080px"
    @close="!saving && requestClose()"
  >
    <p v-if="saveError" class="field-error" role="alert">{{ saveError }}</p>
    <div v-if="pendingAction" class="config-discard" role="alert">
      <span>切换插件动作会清空当前输入参数和回填设置。</span>
      <button type="button" class="button" @click="pendingAction = ''">
        保留当前动作
      </button>
      <button type="button" class="button" @click="changeAction(pendingAction)">
        确认切换动作
      </button>
    </div>
    <div
      v-if="confirmDiscard"
      class="config-discard"
      role="alert"
      tabindex="-1"
    >
      <span>配置尚未保存，关闭后会丢失这次修改。</span
      ><button class="button" @click="confirmDiscard = false">继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </div>
    <div class="extension-editor">
      <nav class="config-steps" aria-label="插件配置步骤">
        <button
          v-for="(label, index) in steps"
          :key="label"
          :class="{ active: step === index, complete: step > index }"
          :aria-current="step === index ? 'step' : undefined"
          @click="step = index"
        >
          <span>{{ index + 1 }}</span
          >{{ label }}
        </button>
      </nav>
      <div class="extension-editor-grid">
        <section class="config-main">
          <div v-if="errors.length" class="config-errors" role="alert">
            <button
              v-for="error in errors"
              :key="error.target + error.message"
              @click="locate(error)"
            >
              <AppIcon name="warning" />{{ error.message }}
            </button>
          </div>
          <template v-if="step === 0"
            ><h3 id="action" tabindex="-1">这一步要做什么？</h3>
            <p class="field-hint">选择业务动作后，再匹配它需要的表单数据。</p>
            <input
              v-model="query"
              aria-label="搜索插件动作"
              placeholder="搜索动作，如通知、金额"
            />
            <div class="action-catalog">
              <button
                v-for="item in definitions"
                :key="item.id"
                :class="{ selected: config.actionId === item.id }"
                @click="choose(item.id)"
              >
                <AppIcon :name="item.icon" :size="25" /><span
                  ><strong>{{ item.name }}</strong
                  ><small>{{ item.description }}</small></span
                ><span class="mode-tag">{{
                  item.mode === "local" ? "本地运行" : "模拟连接"
                }}</span>
              </button>
              <p v-if="!definitions.length" class="field-hint">
                没有匹配的动作，请调整关键词。
              </p>
            </div></template
          >
          <template v-else-if="step === 1"
            ><h3>{{ definition?.name || "先选择动作" }} · 输入参数</h3>
            <p class="field-hint">选择数据来自哪个字段，或者直接填写固定值。</p>
            <div
              v-for="input in definition?.inputs"
              :key="input.key"
              :id="`input-${input.key}`"
              tabindex="-1"
              class="parameter-card"
            >
              <div class="parameter-heading">
                <strong>{{ input.label }}</strong
                ><span>{{
                  input.type === "number"
                    ? "数字"
                    : input.type === "json"
                      ? "JSON"
                      : input.type === "members"
                        ? "成员范围"
                        : "文本"
                }}</span>
              </div>
              <BindingEditor
                v-model="config.inputs[input.key]!"
                :fields="fields"
                :label="input.label"
                :type="input.type"
                :hint="input.hint"
              />
            </div>
            <button v-if="!definition" class="button" @click="step = 0">
              选择动作
            </button></template
          >
          <template v-else-if="step === 2"
            ><h3 id="output-mapping" tabindex="-1">把结果放在哪里？</h3>
            <p class="field-hint">
              按字段类型匹配。试运行只展示结果，正式流转时才写入当前记录。
            </p>
            <div
              v-for="output in definition?.outputs"
              :key="output.key"
              class="output-map"
            >
              <div>
                <strong>{{ output.label }}</strong
                ><small>{{ output.type === "number" ? "数字" : "文本" }}</small>
              </div>
              <AppIcon name="right" /><select
                :aria-label="`${output.label}回填字段`"
                :value="
                  config.outputs.find((m) => m.outputKey === output.key)
                    ?.fieldId || ''
                "
                @change="
                  map(output.key, ($event.target as HTMLSelectElement).value)
                "
              >
                <option value="">不回填</option>
                <option
                  v-if="
                    config.outputs.find((m) => m.outputKey === output.key)
                      ?.fieldId &&
                    !fields.some(
                      (f) =>
                        f.id ===
                        config.outputs.find((m) => m.outputKey === output.key)
                          ?.fieldId,
                    )
                  "
                  :value="
                    config.outputs.find((m) => m.outputKey === output.key)
                      ?.fieldId
                  "
                >
                  字段已删除
                </option>
                <option
                  v-for="field in fields.filter((f) =>
                    compatibleField(f, output.type, true),
                  )"
                  :key="field.id"
                  :value="field.id"
                  :disabled="
                    config.outputs.some(
                      (m) =>
                        m.outputKey !== output.key && m.fieldId === field.id,
                    )
                  "
                >
                  {{ field.label }}
                </option>
              </select>
            </div>
            <p v-if="definition?.mode === 'local'" class="field-hint">
              本地转换动作至少需要一个回填字段。没有兼容字段时，请先在表单中添加文本或数字字段。
            </p></template
          >
          <template v-else
            ><h3>先用一条数据试一试</h3>
            <SampleEditor v-model="values" :schema="schema" :form-id="formId" />
            <div class="trial-toolbar">
              <label id="test-scenario" tabindex="-1"
                >执行场景<select v-model="failure" aria-label="插件测试场景">
                  <option :value="false">正常执行</option>
                  <option :value="true">模拟执行失败</option>
                </select></label
              ><button class="button primary" @click="trial">
                <AppIcon name="launch" />{{
                  result?.status === "failed" ? "重新试运行" : "运行测试"
                }}
              </button>
            </div>
            <p v-if="stale" class="config-warning">
              配置或样本已变化，请重新运行以验证最新结果。
            </p>
            <RunTrace
              v-if="result"
              :run="result"
              :fields="fields"
              @locate="locate"
          /></template>
        </section>
        <aside class="config-preview">
          <span class="eyebrow">实时预览</span>
          <h3>{{ definition?.name || "选择一个业务动作" }}</h3>
          <p>
            {{ definition?.description || "每个动作都包含明确的输入与输出。" }}
          </p>
          <div class="preview-callout">
            <AppIcon
              :name="definition?.mode === 'local' ? 'calculator' : 'info'"
            /><span>{{
              definition?.mode === "local"
                ? "运算在本地执行，试运行不修改记录。"
                : "当前为本地模拟，不会向外部系统发送请求或消息。"
            }}</span>
          </div>
          <h4>输入示例</h4>
          <pre>{{ JSON.stringify(resolved, null, 2) }}</pre>
          <h4>结果去向</h4>
          <p v-if="!config.outputs.length" class="field-hint">
            尚未设置回填字段
          </p>
          <div
            v-for="mapping in config.outputs"
            :key="mapping.outputKey"
            class="preview-mapping"
          >
            <span>{{
              definition?.outputs.find((o) => o.key === mapping.outputKey)
                ?.label
            }}</span
            ><AppIcon name="right" /><strong>{{
              fields.find((f) => f.id === mapping.fieldId)?.label ||
              "字段已删除"
            }}</strong>
          </div>
          <p class="field-hint">
            字段改名不会影响绑定；删除或更改类型时会提示失效引用。
          </p>
        </aside>
      </div>
    </div>
    <template #footer
      ><button class="button" @click="requestClose">取消</button
      ><button v-if="step > 0" class="button" @click="step--">上一步</button
      ><button v-if="step < 3" class="button primary" @click="next">
        下一步</button
      ><button v-else class="button primary" :disabled="saving" @click="save">
        {{ saving ? "正在保存…" : saveLabel || "应用到节点" }}
      </button></template
    >
  </BaseDialog>
</template>
