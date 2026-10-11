<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FrontendEvent } from "@platform/contracts";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { useWorkspaceStore } from "../../../stores/workspace";
import {
  copy,
  createField,
  flattenFields,
  type FormSchema,
  type FormValues,
} from "../../../domain/form";
import {
  frontendEventFields,
  frontendEventScope,
  frontendEventIssues,
  frontendEventOutputFields,
  frontendTriggerFields,
  newFrontendEvent,
  runFrontendEvent,
} from "../../../domain/frontendEvents";
import {
  compatibleField,
  newInvocation,
  pluginRegistry,
  sampleValues,
  type ExtensionRun,
} from "../../../domain/extensions";
import BindingEditor from "../../extensions/components/BindingEditor.vue";
import SampleEditor from "../../extensions/components/SampleEditor.vue";
import RunTrace from "../../extensions/components/RunTrace.vue";
import ChoiceFieldControl from "./ChoiceFieldControl.vue";
import FrontendRequestSettings from "./FrontendRequestSettings.vue";
import { newFrontendRequest } from "../../../domain/frontendRequests";
import { newFrontendSelection } from "../../../domain/frontendSelections";
import FrontendSelectionSettings from "./FrontendSelectionSettings.vue";

const props = defineProps<{ schema: FormSchema; formId: string }>();
const store = useWorkspaceStore();
const open = ref(false),
  editing = ref(false),
  step = ref(0),
  error = ref("");
const config = ref<FrontendEvent>(newFrontendEvent());
const debugging = ref(false),
  debugConfig = ref<FrontendEvent>(),
  run = ref<ExtensionRun>();
const samples = ref<FormValues>({}),
  forceFailure = ref(false);
watch(
  [samples, forceFailure, () => debugConfig.value?.request?.simulation],
  () => {
    run.value = undefined;
  },
  { deep: true },
);
const events = computed(() => props.schema.settings.frontendEvents || []);
const fields = computed(() => frontendEventFields(props.schema, true));
const scope = computed(() => frontendEventScope(props.schema, config.value));
const definition = computed(() =>
  pluginRegistry.find((plugin) => plugin.id === config.value.plugin?.actionId),
);
const action = computed({
  get: () =>
    config.value.selection
      ? "select-data"
      : config.value.request
        ? "custom-request"
        : config.value.plugin!.actionId,
  set: changeAction,
});
const outputFields = computed(() =>
  frontendEventOutputFields(props.schema, config.value),
);
const triggerControl = createField("multiselect", {
  id: "frontend-trigger",
  placeholder: "请选择触发字段",
});
const debugScope = computed(() =>
  debugConfig.value
    ? frontendEventScope(props.schema, debugConfig.value)
    : props.schema,
);
const dismiss = useDraftDismiss(
  () => editing.value,
  () => config.value,
  () => (editing.value = false),
);
const fieldName = (id: string) =>
  fields.value.find((field) => field.id === id)?.pathLabel || "已移除字段";
const triggerSummary = (event: FrontendEvent) =>
  event.trigger === "submit"
    ? "表单提交触发"
    : event.fieldIds.map(fieldName).join("、");
function edit(event?: FrontendEvent) {
  config.value = event ? copy(event) : newFrontendEvent();
  step.value = 0;
  error.value = "";
  editing.value = true;
}
function changeAction(id: string) {
  const {
    plugin: _plugin,
    request: _request,
    selection: _selection,
    ...base
  } = config.value;
  config.value =
    id === "select-data"
      ? {
          ...base,
          trigger: "field",
          fieldIds: base.fieldIds
            .filter((id) =>
              frontendTriggerFields(props.schema).some(
                (field) => field.id === id && field.type === "button",
              ),
            )
            .slice(0, 1),
          selection: newFrontendSelection(),
        }
      : id === "custom-request"
        ? { ...base, request: newFrontendRequest() }
        : { ...base, plugin: newInvocation(id) };
}
function changeTrigger() {
  config.value.fieldIds = [];
}
function next() {
  error.value = config.value.name.trim() ? "" : "请填写事件名称";
  if (!error.value) step.value = 1;
}
function save(debug = false) {
  const issue = frontendEventIssues(config.value, props.schema, store.data)[0];
  error.value = issue?.message || "";
  if (issue) {
    step.value = issue.step;
    return;
  }
  if (
    config.value.trigger === "submit" &&
    events.value.some(
      (event) => event.trigger === "submit" && event.id !== config.value.id,
    )
  ) {
    error.value = "每张表单只能配置一个提交触发事件";
    return;
  }
  if (
    !events.value.some((event) => event.id === config.value.id) &&
    events.value.length >= 100
  ) {
    error.value = "前端事件最多配置100个";
    return;
  }
  const saved = { ...copy(config.value), name: config.value.name.trim() };
  props.schema.settings.frontendEvents = events.value.some(
    (event) => event.id === saved.id,
  )
    ? events.value.map((event) => (event.id === saved.id ? saved : event))
    : [...events.value, saved];
  dismiss.markSaved();
  editing.value = false;
  if (debug) trial(saved);
}
function trial(event: FrontendEvent) {
  debugConfig.value = copy(event);
  samples.value = sampleValues(frontendEventScope(props.schema, event));
  forceFailure.value = false;
  run.value = undefined;
  debugging.value = true;
}
function test() {
  if (!debugConfig.value) return;
  const parentId = fields.value.find(
    (field) => field.id === debugConfig.value!.fieldIds[0],
  )?.parentId;
  const values = copy(samples.value);
  if (parentId) values[parentId] = [copy(samples.value)];
  run.value = runFrontendEvent(
    debugConfig.value,
    props.schema,
    values,
    store.data,
    parentId ? { subformId: parentId, index: 0 } : undefined,
    forceFailure.value,
  );
}
function move(id: string, offset: number) {
  const next = [...events.value],
    index = next.findIndex((event) => event.id === id),
    target = index + offset;
  if (index < 0 || target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target]!, next[index]!];
  props.schema.settings.frontendEvents = next;
}
let dragging = "";
function drop(id: string) {
  const next = [...events.value],
    from = next.findIndex((event) => event.id === dragging),
    to = next.findIndex((event) => event.id === id);
  if (from < 0 || to < 0 || from === to) return;
  const [event] = next.splice(from, 1);
  next.splice(to, 0, event!);
  props.schema.settings.frontendEvents = next;
  dragging = "";
}
</script>

<template>
  <div class="form-group">
    <label>前端事件</label
    ><button
      type="button"
      class="button full-width"
      aria-label="前端事件设置"
      @click="open = true"
    >
      设置
    </button>
  </div>
  <BaseDialog
    :open="open"
    title="前端事件"
    width="100vw"
    class-name="frontend-events-dialog"
    @close="open = false"
  >
    <div class="frontend-events-content">
      <button
        class="button primary"
        :disabled="events.length >= 100"
        @click="edit()"
      >
        <AppIcon name="add" />添加前端事件
      </button>
      <p class="field-hint">
        填写或编辑数据时，字段值的变动可以触发自动操作。<a
          href="https://hc.jiandaoyun.com/open/12115"
          target="_blank"
          rel="noopener"
          >了解更多</a
        >
      </p>
      <div
        v-for="(event, index) in events"
        :key="event.id"
        class="frontend-event-row"
        draggable="true"
        @dragstart="dragging = event.id"
        @dragend="dragging = ''"
        @dragover.prevent
        @drop.prevent="drop(event.id)"
      >
        <AppIcon name="menu" :size="16" class="event-drag" />
        <div class="event-summary">
          <strong>{{ event.name }}</strong>
          <p>
            {{ triggerSummary(event) }} →
            {{
              event.selection
                ? "选择数据填充"
                : event.request
                  ? "自定义请求"
                  : pluginRegistry.find(
                      (plugin) => plugin.id === event.plugin?.actionId,
                    )?.name || "动作已不可用"
            }}
          </p>
        </div>
        <button
          class="switch"
          :class="{ on: event.enabled }"
          role="switch"
          :aria-label="`启用事件 ${event.name}`"
          :aria-checked="event.enabled"
          @click="event.enabled = !event.enabled"
        >
          <span />
        </button>
        <div class="event-actions">
          <button class="text-button" @click="edit(event)">编辑</button
          ><button
            v-if="!event.selection"
            class="text-button"
            @click="trial(event)"
          >
            调试</button
          ><button
            class="text-button"
            :aria-label="`删除事件 ${event.name}`"
            @click="
              schema.settings.frontendEvents = events.filter(
                (item) => item.id !== event.id,
              )
            "
          >
            删除</button
          ><button
            class="icon-button"
            :disabled="index === 0"
            :aria-label="`上移事件 ${event.name}`"
            @click="move(event.id, -1)"
          >
            <AppIcon name="up" :size="14" /></button
          ><button
            class="icon-button"
            :disabled="index === events.length - 1"
            :aria-label="`下移事件 ${event.name}`"
            @click="move(event.id, 1)"
          >
            <AppIcon name="down" :size="14" />
          </button>
        </div>
      </div>
    </div>
  </BaseDialog>
  <BaseDialog
    :open="editing"
    title="前端事件"
    width="700px"
    class-name="frontend-event-editor"
    @close="dismiss.requestClose"
  >
    <div class="event-steps" :class="{ complete: step === 1 }">
      <span :class="{ active: step === 0, completed: step === 1 }"
        ><b
          ><AppIcon v-if="step === 1" name="check" :size="14" /><template v-else
            >1</template
          ></b
        >名称信息</span
      ><span :class="{ active: step === 1 }"><b>2</b>触发与执行</span>
    </div>
    <div class="event-config-content">
      <template v-if="step === 0">
        <div class="form-group">
          <label for="frontend-event-name"
            >事件名称<span class="required">*</span></label
          ><input
            id="frontend-event-name"
            v-model="config.name"
            maxlength="100"
          />
        </div>
        <div class="form-group">
          <label for="frontend-event-description">事件说明</label
          ><textarea
            id="frontend-event-description"
            v-model="config.description"
            rows="4"
            maxlength="1000"
          />
        </div>
      </template>
      <template v-else>
        <div class="form-group event-action-group">
          <label>触发动作</label>
          <div class="event-trigger-row">
            <div class="select-wrap">
              <select
                v-model="config.trigger"
                aria-label="触发动作"
                :disabled="!!config.selection"
                @change="changeTrigger"
              >
                <option value="field">字段触发</option>
                <option value="submit">表单提交触发</option></select
              ><AppIcon name="down" :size="13" />
            </div>
            <ChoiceFieldControl
              v-if="config.trigger === 'field'"
              :field="
                config.selection
                  ? {
                      ...triggerControl,
                      type: 'select',
                      placeholder: '请选择触发按钮',
                    }
                  : triggerControl
              "
              :choices="
                frontendTriggerFields(schema)
                  .filter(
                    (field) => !config.selection || field.type === 'button',
                  )
                  .map((field) => ({
                    id: field.id,
                    label: field.pathLabel,
                  }))
              "
              :model-value="
                config.selection ? config.fieldIds[0] || '' : config.fieldIds
              "
              label="触发字段"
              @update:model-value="
                config.fieldIds = config.selection
                  ? $event
                    ? [$event as string]
                    : []
                  : ($event as string[])
              "
            />
          </div>
        </div>
        <div class="form-group event-action-group">
          <label for="frontend-event-action">执行动作</label>
          <div class="select-wrap">
            <select id="frontend-event-action" v-model="action">
              <option value="custom-request">自定义请求</option>
              <option value="select-data">选择数据填充</option>
              <option
                v-for="plugin in pluginRegistry"
                :key="plugin.id"
                :value="plugin.id"
              >
                调用插件 · {{ plugin.name }}
              </option></select
            ><AppIcon name="down" :size="13" />
          </div>
          <p v-if="definition?.mode === 'simulation'" class="field-hint">
            外部动作使用模拟响应，不会发送请求或消息。
          </p>
        </div>
        <FrontendSelectionSettings
          v-if="config.selection"
          v-model="config.selection"
          :inputs="scope.fields"
          :outputs="outputFields"
          :row-scoped="
            !!fields.find((field) => field.id === config.fieldIds[0])?.parentId
          "
        />
        <FrontendRequestSettings
          v-else-if="config.request"
          v-model="config.request"
          :fields="scope.fields"
          :outputs="outputFields"
        />
        <template v-else-if="config.plugin">
          <div
            v-for="input in definition?.inputs || []"
            :key="input.key"
            class="form-group"
          >
            <label>{{ input.label }}</label
            ><BindingEditor
              v-model="config.plugin.inputs[input.key]!"
              :fields="scope.fields"
              :label="input.label"
              :type="input.type"
              :hint="input.hint"
            />
          </div>
          <div class="form-group">
            <label>字段存储关系</label>
            <div
              v-for="(mapping, index) in config.plugin.outputs"
              :key="index"
              class="event-output-row"
            >
              <div class="select-wrap">
                <select
                  v-model="mapping.outputKey"
                  :aria-label="`返回值 ${index + 1}`"
                >
                  <option value="">选择返回值</option>
                  <option
                    v-for="output in definition?.outputs || []"
                    :key="output.key"
                    :value="output.key"
                  >
                    {{ output.label }}
                  </option></select
                ><AppIcon name="down" :size="13" />
              </div>
              <span>→</span>
              <div class="select-wrap">
                <select
                  v-model="mapping.fieldId"
                  :aria-label="`回填字段 ${index + 1}`"
                >
                  <option value="">选择表单字段</option>
                  <option
                    v-if="
                      mapping.fieldId &&
                      !scope.fields.some(
                        (field) => field.id === mapping.fieldId,
                      )
                    "
                    :value="mapping.fieldId"
                  >
                    字段已移除或不在当前范围
                  </option>
                  <option
                    v-for="field in scope.fields.filter(
                      (field) =>
                        compatibleField(
                          field,
                          definition?.outputs.find(
                            (output) => output.key === mapping.outputKey,
                          )?.type || 'text',
                          true,
                        ) &&
                        (!fields.find((item) => item.id === config.fieldIds[0])
                          ?.parentId ||
                          fields.find((item) => item.id === field.id)
                            ?.parentId),
                    )"
                    :key="field.id"
                    :value="field.id"
                  >
                    {{ field.label }}
                  </option></select
                ><AppIcon name="down" :size="13" />
              </div>
              <button
                class="icon-button"
                :aria-label="`删除回填 ${index + 1}`"
                @click="config.plugin.outputs.splice(index, 1)"
              >
                <AppIcon name="trash" :size="14" />
              </button>
            </div>
            <button
              class="text-button"
              @click="
                config.plugin.outputs.push({
                  outputKey: definition?.outputs[0]?.key || '',
                  fieldId: '',
                })
              "
            >
              <AppIcon name="add" :size="14" />添加字段
            </button>
          </div>
        </template>
      </template>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <div
        v-if="dismiss.confirmDiscard.value"
        class="config-discard"
        tabindex="-1"
      >
        <p>修改尚未保存，是否放弃？</p>
        <button class="button" @click="dismiss.confirmDiscard.value = false">
          继续编辑</button
        ><button class="button danger" @click="dismiss.discard">
          放弃修改
        </button>
      </div>
    </div>
    <template #footer
      ><a
        class="event-help"
        href="https://hc.jiandaoyun.com/open/12116"
        target="_blank"
        rel="noopener"
        >如何添加前端事件？</a
      ><template v-if="step === 0"
        ><button class="button" @click="dismiss.requestClose">取消</button
        ><button class="button primary" @click="next">下一步</button></template
      ><template v-else
        ><button
          class="button"
          @click="
            step = 0;
            error = '';
          "
        >
          上一步</button
        ><button
          class="button"
          :class="{ primary: !!config.selection }"
          @click="save()"
        >
          保存</button
        ><button
          v-if="!config.selection"
          class="button primary"
          @click="save(true)"
        >
          保存并调试
        </button></template
      ></template
    >
  </BaseDialog>
  <BaseDialog
    :open="debugging"
    :title="`前端事件调试 · ${debugConfig?.name || ''}`"
    width="700px"
    @close="debugging = false"
  >
    <p class="field-hint">
      测试副本不会修改原始记录。{{
        debugConfig?.request ||
        pluginRegistry.find(
          (plugin) => plugin.id === debugConfig?.plugin?.actionId,
        )?.mode === "simulation"
          ? "外部响应为模拟数据。"
          : "动作在本地执行。"
      }}
    </p>
    <SampleEditor v-model="samples" :schema="debugScope" :form-id="formId" />
    <div v-if="debugConfig?.request" class="form-group">
      <label>模拟返回数据</label
      ><textarea
        v-model="debugConfig.request.simulation.response"
        aria-label="调试模拟返回数据"
        rows="6"
      />
    </div>
    <label class="checkbox-line"
      ><input v-model="forceFailure" type="checkbox" />模拟执行失败</label
    >
    <RunTrace
      v-if="run"
      :run="run"
      :fields="flattenFields(schema.fields)"
      @locate="
        debugging = false;
        edit(debugConfig);
        step = 1;
      "
    />
    <template #footer
      ><button class="button" @click="debugging = false">关闭</button
      ><button class="button primary" @click="test">试运行</button></template
    >
  </BaseDialog>
</template>

<style>
.frontend-events-dialog {
  position: fixed;
  inset: 45px 0 0;
  margin: 0;
  height: calc(100dvh - 45px);
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
}
.frontend-events-dialog .dialog-header {
  justify-content: center;
  position: relative;
}
.frontend-events-dialog .dialog-header > .icon-button {
  position: absolute;
  right: 16px;
}
.frontend-events-dialog .dialog-body {
  background: #f7f8fa;
}
.frontend-events-content {
  max-width: 1000px;
  margin: 40px auto;
  padding: 20px;
  background: white;
  min-height: 320px;
}
.frontend-event-row {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 18px 0;
  border-top: 1px solid #e4e9ed;
}
.event-drag {
  color: #97a3af;
  cursor: grab;
}
.event-summary {
  flex: 1;
  min-width: 0;
}
.event-summary strong {
  font-size: 14px;
}
.event-summary p {
  color: #708097;
  font-size: 12px;
  margin: 6px 0 0;
  overflow-wrap: anywhere;
}
.event-actions {
  display: flex;
  gap: 14px;
  align-items: center;
}
.frontend-event-editor {
  height: 600px;
  max-height: calc(100vh - 32px);
}
.frontend-event-editor .dialog-body {
  padding: 0;
}
.frontend-event-editor .dialog-header {
  height: 51px;
  padding: 12px 20px;
}
.frontend-event-editor .dialog-header > .icon-button {
  width: 24px;
  height: 24px;
  min-height: 24px;
}
.frontend-event-editor .dialog-header > .icon-button svg {
  width: 16px;
  height: 16px;
}
.frontend-event-editor .dialog-footer {
  padding: 12px 20px;
  min-height: 57px;
}
.frontend-event-editor .button {
  font-size: 14px;
}
.frontend-event-editor .dialog-footer .button {
  min-width: 0;
  height: 32px;
  padding: 0 12px;
  line-height: 30px;
}
.event-steps {
  display: flex;
  position: relative;
  justify-content: space-between;
  width: 400px;
  max-width: calc(100% - 40px);
  height: 25px;
  margin: 20px auto 10px;
  color: #8c98a6;
}
.event-steps::after {
  content: "";
  position: absolute;
  left: 104px;
  right: 116px;
  top: 12px;
  height: 1px;
  background: #e4e9ed;
}
.event-steps span {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.event-steps b {
  background: #e5e7eb;
  border-radius: 50%;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  font-weight: 400;
  font-size: 12px;
}
.event-steps .active {
  color: #1f2329;
}
.event-steps .active b {
  background: #0db3a6;
  color: white;
}
.event-steps .completed {
  color: #1f2329;
}
.event-steps .completed b {
  background: #0db3a6;
  color: white;
}
.event-steps.complete::after {
  background: #0db3a6;
}
.event-config-content {
  padding: 0 20px 20px;
}
.event-config-content .form-group {
  margin-bottom: 20px;
}
.event-config-content .form-group > label {
  margin-bottom: 0;
  height: 32px;
  line-height: 22px;
  font-size: 14px;
  font-weight: 400;
}
.event-config-content .event-action-group > label {
  height: 30px;
  font-size: 16px;
  font-weight: 600;
}
#frontend-event-description {
  height: 98px;
  min-height: 98px;
  resize: none;
}
.event-trigger-row {
  --input-width: 100%;
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}
.event-output-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16px minmax(0, 1.2fr) 24px;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.event-output-row > * {
  min-width: 0;
}
.event-help {
  margin-right: auto;
  font-size: 12px;
}
@media (max-width: 600px) {
  .frontend-events-content {
    margin: 0;
    padding: 16px;
  }
  .frontend-event-row {
    flex-wrap: wrap;
    gap: 10px;
  }
  .event-summary {
    min-width: 180px;
  }
  .event-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .event-trigger-row {
    grid-template-columns: 1fr;
  }
  .event-steps {
    width: auto;
  }
  .frontend-event-editor .dialog-footer {
    flex-wrap: wrap;
  }
  .event-help {
    width: 100%;
  }
}
</style>
