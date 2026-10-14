<script setup lang="ts">
import { automationEvents, type AutomationEvent } from "../../../domain/events";
import { computed, nextTick, ref, watch } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import DataFilterEditor from "../../forms/components/DataFilterEditor.vue";
import SampleEditor from "./SampleEditor.vue";
import RunTrace from "./RunTrace.vue";
import AutomationStepEditor from "./AutomationStepEditor.vue";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { copy, type FormValues, type FormSchema } from "../../../domain/form";
import { buttonSources } from "../../../domain/buttons";
import {
  sampleValues,
  type ExtensionRun,
  type ConfigIssue,
} from "../../../domain/extensions";
import {
  newAutomation,
  newAutomationStep,
  automationIssues,
  prepareAutomation,
  type AutomationConfig,
} from "../../../domain/automation";
const props = defineProps<{
  open: boolean;
  modelValue?: AutomationConfig;
  schema: FormSchema;
  formId: string;
}>();
const emit = defineEmits<{ close: [] }>();
const runtimeData = useRuntimeData();
const config = ref(newAutomation()),
  step = ref(0),
  error = ref(""),
  sample = ref<FormValues>({}),
  trial = ref<ExtensionRun>(),
  trialEvent = ref<AutomationEvent>("data_create");
const sources = computed(() => buttonSources(props.schema));
watch(
  () => config.value.events,
  (events) => {
    if (!events.includes(trialEvent.value))
      trialEvent.value = events[0] || "data_create";
  },
  { deep: true },
);
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    config.value = copy(props.modelValue || newAutomation());
    step.value = 0;
    error.value = "";
    sample.value = sampleValues(props.schema);
    trial.value = undefined;
    trialEvent.value = config.value.events[0] || "data_create";
  },
  { immediate: true },
);
const { confirmDiscard, requestClose, discard } = useDraftDismiss(
  () => props.open,
  () => config.value,
  () => emit("close"),
);
watch(
  [config, sample, trialEvent],
  () => {
    trial.value = undefined;
  },
  { deep: true },
);
async function locate(issue: ConfigIssue) {
  error.value = issue.message;
  step.value = issue.step;
  await nextTick();
  const el = document.getElementById(issue.target);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  el?.focus({ preventScroll: true });
}
async function next() {
  const issue = automationIssues(
    config.value,
    props.schema,
    runtimeData.value,
  ).find((i) => i.step <= step.value);
  if (issue) {
    await locate(issue);
    return;
  }
  error.value = "";
  step.value++;
}
function move(index: number, direction: number) {
  const next = [...config.value.steps],
    removed = next.splice(index, 1)[0]!;
  next.splice(index + direction, 0, removed);
  config.value.steps = next;
}
// 试算只更新当前对话框，不写入业务记录或执行日志。
function test() {
  const result = prepareAutomation(
    config.value,
    props.schema,
    sample.value,
    trialEvent.value,
    runtimeData.value,
    { formId: props.formId, trial: true },
  );
  trial.value = result.run;
}
</script>
<template>
  <BaseDialog
    :open="open"
    :title="modelValue ? '编辑智能助手' : '新建智能助手'"
    width="1080px"
    @close="requestClose"
  >
    <div v-if="confirmDiscard" class="config-discard" tabindex="-1">
      <span>配置尚未保存。</span
      ><button type="button" class="button" @click="confirmDiscard = false">
        继续编辑</button
      ><button type="button" class="button" @click="discard">放弃修改</button>
    </div>
    <div class="button-editor-steps">
      <span
        v-for="(label, i) in ['什么情况下触发', '依次执行什么', '试运行与保存']"
        :key="label"
        :class="{ active: step === i }"
        >{{ i + 1 }} · {{ label }}</span
      >
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div class="button-editor-body automation-editor">
      <section v-if="step === 0" class="button-config-fields">
        <label
          >助手名称<input
            id="automation-name"
            v-model="config.name"
            maxlength="50"
            placeholder="例如：订单提交后建立发货台账"
        /></label>
        <fieldset id="automation-events">
          <legend>触发事件</legend>
          <label
            v-for="(label, event) in automationEvents"
            :key="event"
            class="button-check"
            ><input v-model="config.events" type="checkbox" :value="event" />{{
              label
            }}</label
          >
        </fieldset>
        <p class="field-hint">
          支付事件在结果回填后触发，条件和动作可读取回填字段。每笔成功支付仅触发一次；部分退款和全额退款分别按本次操作触发。
        </p>
        <label class="button-check"
          ><input v-model="config.enabled" type="checkbox" />启用助手</label
        >
        <div id="automation-filters">
          <h4>哪些数据需要处理？</h4>
          <DataFilterEditor
            v-model="config.filters"
            :source-fields="sources"
            :local-fields="sources"
            hint="同时满足以下条件才执行；不设置则处理所选事件的所有数据。"
          />
        </div>
        <p class="field-hint">
          修改事件仅在字段值变化时触发。保存草稿与单纯审批流转不会触发助手。
        </p>
      </section>
      <section
        v-else-if="step === 1"
        id="automation-steps"
        class="button-config-fields"
        tabindex="-1"
      >
        <div class="automation-safety-note">
          动作按顺序执行，后续动作能查到前面产生的记录。任一步失败，整组目标变更撤回；触发记录仍正常保存。
        </div>
        <AutomationStepEditor
          v-for="(action, i) in config.steps"
          :key="action.id"
          :step="action"
          :schema="schema"
          :index="i"
          :total="config.steps.length"
          @move="move(i, $event)"
          @remove="config.steps.splice(i, 1)"
        />
        <button
          type="button"
          class="button"
          :disabled="config.steps.length >= 20"
          @click="config.steps.push(newAutomationStep())"
        >
          ＋ 添加下一步动作
        </button>
        <p class="field-hint">
          最多 20 个动作，单步更新最多 200 条，整组最多 500
          次变更。助手产生的数据不会再次触发其他扩展事件。
        </p>
      </section>
      <section v-else class="button-config-fields">
        <div class="automation-safety-note">
          试运行只展示预计变更，不保存测试日志或业务数据。
        </div>
        <label
          >模拟触发事件<select v-model="trialEvent">
            <option
              v-for="(label, event) in automationEvents"
              :key="event"
              :value="event"
            >
              {{ label }}
            </option>
          </select></label
        >
        <SampleEditor v-model="sample" :schema="schema" :form-id="formId" />
        <button type="button" class="button primary" @click="test">
          试运行整组动作
        </button>
        <RunTrace v-if="trial" :run="trial" @locate="locate" />
        <p class="field-hint">当前仅供配置预览，保存与自动执行尚未开放。</p>
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
        disabled
        title="暂未开放保存"
      >
        保存助手
      </button></template
    >
  </BaseDialog>
</template>
