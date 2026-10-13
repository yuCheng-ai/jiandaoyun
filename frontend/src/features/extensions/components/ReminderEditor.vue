<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import IdentityInput from "../../../components/organization/IdentityInput.vue";
import DataFilterEditor from "../../forms/components/DataFilterEditor.vue";
import SampleEditor from "./SampleEditor.vue";
import RunTrace from "./RunTrace.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { useWorkspaceStore } from "../../../stores/workspace";
import { copy, type FormSchema, type FormValues } from "../../../domain/form";
import {
  pushEvents,
  sampleValues,
  type ConfigIssue,
  type ExtensionRun,
  type PushEvent,
} from "../../../domain/extensions";
import {
  newReminder,
  reminderChannels,
  reminderFields,
  reminderIssues,
  reminderRecipients,
  recipientFieldTypes,
  renderReminderText,
  reminderDueAt,
  runReminder,
  type ReminderConfig,
} from "../../../domain/reminders";

const props = defineProps<{
  open: boolean;
  modelValue?: ReminderConfig;
  schema: FormSchema;
  formId: string;
}>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore(),
  config = ref(newReminder()),
  step = ref(0),
  issues = ref<ConfigIssue[]>([]),
  values = ref<FormValues>({}),
  result = ref<ExtensionRun>(),
  failure = ref(false),
  event = ref<PushEvent>("data_create"),
  testTime = ref(""),
  tested = ref(""),
  saving = ref(false),
  saveError = ref("");
const fields = computed(() => reminderFields(props.schema));
const recipientFields = computed(() =>
  fields.value.filter((f) => recipientFieldTypes.includes(f.type)),
);
const recipients = computed(() =>
  reminderRecipients(config.value, values.value, store.data),
);
const due = computed(() => reminderDueAt(config.value, values.value));
const fingerprint = computed(() =>
  JSON.stringify([
    config.value,
    values.value,
    props.schema,
    event.value,
    failure.value,
    testTime.value,
    store.data.organization,
  ]),
);
const stale = computed(
  () => result.value && fingerprint.value !== tested.value,
);
const steps = ["什么时候提醒", "提醒谁", "说些什么", "试运行与保存"];
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    config.value = copy(props.modelValue || newReminder());
    step.value = 0;
    issues.value = [];
    saveError.value = "";
    tested.value = "";
    values.value = sampleValues(props.schema);
    result.value = undefined;
    failure.value = false;
    event.value = config.value.events[0] || "data_create";
    const now = new Date();
    testTime.value = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  },
  { immediate: true },
);
function next() {
  issues.value = reminderIssues(config.value, props.schema).filter(
    (i) => i.step === step.value,
  );
  if (!issues.value.length) step.value++;
}
function locate(issue: ConfigIssue) {
  step.value = issue.step;
  issues.value = [issue];
  nextTick(() => document.getElementById(issue.target)?.focus());
}
function insert(key: "title" | "message", e: Event) {
  const select = e.target as HTMLSelectElement;
  if (select.value) config.value[key] += "{{" + select.value + "}}";
  select.value = "";
}
async function trial() {
  const now = new Date(testTime.value);
  if (config.value.trigger === "date" && !Number.isFinite(now.getTime())) {
    issues.value = [
      {
        step: 3,
        target: "reminder-test-time",
        message: "请选择有效的测试检查时间",
      },
    ];
    return;
  }
  issues.value = [];
  const nextRun = runReminder(
    config.value,
    props.schema,
    values.value,
    store.data,
    {
      event: config.value.trigger === "event" ? event.value : undefined,
      now: config.value.trigger === "date" ? now : undefined,
      forceFailure: failure.value,
    },
  );
  if (result.value?.status === "failed") nextRun.retryOf = result.value.id;
  result.value = nextRun;
  tested.value = fingerprint.value;
  await store.recordExtensionRun(nextRun, props.formId);
}
async function save() {
  if (saving.value) return;
  saveError.value = "";
  issues.value = reminderIssues(config.value, props.schema);
  if (issues.value.length) {
    locate(issues.value[0]!);
    return;
  }
  saving.value = true;
  try {
    if (await store.saveReminder(props.formId, copy(config.value))) {
      markSaved();
      store.notify("提醒已保存，发布新版本后生效");
      emit("close");
    } else
      saveError.value =
        store.storageError || "保存未完成，提醒配置已保留，请重试。";
  } catch {
    saveError.value = "保存失败，提醒配置已保留，请重试。";
  } finally {
    saving.value = false;
  }
}
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => props.open,
    () => config.value,
    () => emit("close"),
  );
</script>
<template>
  <BaseDialog
    :open="open"
    :draft-key="draftKey"
    :busy="saving"
    :title="modelValue ? '编辑推送提醒' : '新建推送提醒'"
    width="1100px"
    @close="!saving && requestClose()"
  >
    <p v-if="saveError" class="field-error" role="alert">{{ saveError }}</p>
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
    <div class="extension-editor reminder-editor">
      <nav class="config-steps" aria-label="提醒配置步骤">
        <button
          v-for="(label, i) in steps"
          :key="label"
          :class="{ active: step === i, complete: step > i }"
          :aria-current="step === i ? 'step' : undefined"
          @click="step = i"
        >
          <span>{{ i + 1 }}</span
          >{{ label }}
        </button>
      </nav>
      <div v-if="issues.length" class="config-warning" role="alert">
        <p v-for="issue in issues" :key="issue.target + issue.message">
          {{ issue.message }}
        </p>
      </div>
      <div class="extension-editor-grid">
        <div class="config-main">
          <template v-if="step === 0">
            <h3>什么变化需要提醒？</h3>
            <label class="config-label"
              >提醒名称<input
                id="reminder-name"
                v-model="config.name"
                placeholder="例如：合同到期前 3 天提醒负责人"
                maxlength="100"
            /></label>
            <label class="config-label"
              >触发方式<select id="reminder-trigger" v-model="config.trigger">
                <option value="event">数据变化时</option>
                <option value="date">指定日期到期时</option>
              </select></label
            >
            <fieldset v-if="config.trigger === 'event'">
              <legend>选择触发事件</legend>
              <div class="event-grid">
                <label
                  v-for="(label, key) in pushEvents"
                  :key="key"
                  class="event-choice"
                  :class="{ selected: config.events.includes(key) }"
                  ><input
                    v-model="config.events"
                    type="checkbox"
                    :value="key"
                  />{{ label }}</label
                >
              </div>
            </fieldset>
            <template v-else>
              <label class="config-label"
                >依据哪个日期？<select
                  id="reminder-date"
                  v-model="config.dateFieldId"
                >
                  <option value="">选择日期字段</option>
                  <option
                    v-if="
                      config.dateFieldId &&
                      !fields.some(
                        (f) =>
                          f.id === config.dateFieldId && f.type === 'datetime',
                      )
                    "
                    :value="config.dateFieldId"
                  >
                    日期字段已失效
                  </option>
                  <option
                    v-for="f in fields.filter((f) => f.type === 'datetime')"
                    :key="f.id"
                    :value="f.id"
                  >
                    {{ f.label }}
                  </option>
                </select></label
              >
              <div class="reminder-date-controls">
                <label class="config-label"
                  >相对天数<input
                    id="reminder-offset"
                    v-model.number="config.offsetDays"
                    type="number"
                    min="-365"
                    max="365"
                    step="1" /></label
                ><label class="config-label"
                  >提醒时刻<input
                    id="reminder-time"
                    v-model="config.time"
                    type="time"
                /></label>
              </div>
              <p class="field-hint">
                负数表示提前，0
                表示当天，正数表示延后。取字段中的日期，按当前浏览器时区的指定时刻提醒。
              </p>
              <p class="config-notice">
                保存并发布后，在提醒列表点击「检查到期提醒」。成功触发的同一记录、版本与日期不会重复提醒；页面关闭后不会在后台检查。
              </p>
            </template>
            <h4>只提醒符合条件的数据</h4>
            <div id="reminder-filters" tabindex="-1">
              <DataFilterEditor
                v-model="config.filters"
                :source-fields="fields"
                :local-fields="fields"
                :allow-field-source="false"
                source-placeholder="选择表单字段"
                hint="同时满足以下条件时提醒，不设置条件则检查所有记录。当前成员指运行检查的人。"
              />
            </div>
          </template>
          <template v-else-if="step === 1">
            <h3>谁需要收到这条消息？</h3>
            <label class="config-label"
              >接收人来源<select
                v-model="config.recipients.source"
                aria-label="提醒接收人来源"
              >
                <option value="fixed">指定成员、部门或角色</option>
                <option value="field">这条记录的成员或部门字段</option>
              </select></label
            >
            <div id="reminder-recipients" tabindex="-1">
              <IdentityInput
                v-if="config.recipients.source === 'fixed'"
                :model-value="config.recipients.ids"
                kind="mixed"
                multiple
                label="选择提醒接收人"
                @update:model-value="config.recipients.ids = $event as string[]"
              />
              <label v-else class="config-label"
                >接收人字段<select
                  id="reminder-recipient-field"
                  v-model="config.recipients.fieldId"
                >
                  <option value="">选择成员或部门字段</option>
                  <option
                    v-if="
                      config.recipients.fieldId &&
                      !recipientFields.some(
                        (f) => f.id === config.recipients.fieldId,
                      )
                    "
                    :value="config.recipients.fieldId"
                  >
                    接收人字段已失效
                  </option>
                  <option
                    v-for="f in recipientFields"
                    :key="f.id"
                    :value="f.id"
                  >
                    {{ f.label }}
                  </option>
                </select></label
              >
            </div>
            <p class="field-hint">
              部门包含下级部门，角色按当前成员关系解析，自动去重并排除停用、离职成员。右侧显示测试数据对应的接收人。
            </p>
            <label class="config-label"
              >消息通道<select v-model="config.channel" aria-label="消息通道">
                <option
                  v-for="(label, key) in reminderChannels"
                  :key="key"
                  :value="key"
                >
                  {{ label }} · 模拟
                </option>
              </select></label
            >
            <p class="config-notice">
              当前只验证消息配置和接收范围，不会发送邮件、企业消息或站内消息。
            </p>
          </template>
          <template v-else-if="step === 2">
            <h3>让接收人看懂需要做什么</h3>
            <label class="config-label"
              >消息标题<input
                id="reminder-title"
                v-model="config.title"
                placeholder="例如：合同即将到期，请及时处理"
                maxlength="200"
            /></label>
            <select
              aria-label="标题插入字段"
              value=""
              @change="insert('title', $event)"
            >
              <option value="">标题中插入字段…</option>
              <option v-for="f in fields" :key="f.id" :value="f.id">
                {{ f.label }}
              </option>
            </select>
            <label class="config-label"
              >消息内容<textarea
                id="reminder-message"
                v-model="config.message"
                rows="7"
                maxlength="4000"
                placeholder="说明需要关注的信息，并插入表单字段。"
              />
            </label>
            <select
              aria-label="消息插入字段"
              value=""
              @change="insert('message', $event)"
            >
              <option value="">内容中插入字段…</option>
              <option v-for="f in fields" :key="f.id" :value="f.id">
                {{ f.label }}
              </option>
            </select>
            <p class="field-hint">
              通过「插入字段」引用表单内容，重命名后仍然有效。消息预览使用人员姓名和选项名称，子表单显示明细行数。
            </p>
          </template>
          <template v-else>
            <h3>先用一条记录验证提醒</h3>
            <div id="reminder-sample" tabindex="-1">
              <SampleEditor
                v-model="values"
                :schema="schema"
                :form-id="formId"
              />
            </div>
            <label v-if="config.trigger === 'event'" class="config-label"
              >模拟事件<select v-model="event" aria-label="提醒模拟事件">
                <option
                  v-for="(label, key) in pushEvents"
                  :key="key"
                  :value="key"
                >
                  {{ label }}
                </option>
              </select></label
            >
            <label v-else class="config-label"
              >模拟检查时间<input
                id="reminder-test-time"
                v-model="testTime"
                type="datetime-local"
            /></label>
            <label class="config-label"
              >模拟通道结果<select id="reminder-scenario" v-model="failure">
                <option :value="false">通道正常响应</option>
                <option :value="true">通道失败</option>
              </select></label
            >
            <button class="button" @click="trial">
              {{ result ? "重新试运行" : "试运行提醒" }}
            </button>
            <p v-if="stale" class="config-warning">
              配置、样本或通讯录已变化，请重新试运行。
            </p>
            <RunTrace v-if="result" :run="result" @locate="locate" />
            <label class="reminder-enable"
              ><input
                v-model="config.enabled"
                type="checkbox"
              />发布后启用这条提醒</label
            >
          </template>
        </div>
        <aside class="reminder-preview" aria-label="提醒实时预览">
          <span class="eyebrow"
            >消息预览 · {{ reminderChannels[config.channel] }}</span
          >
          <h3>
            {{
              renderReminderText(config.title, schema, values, store.data) ||
              "消息标题"
            }}
          </h3>
          <p class="reminder-message">
            {{
              renderReminderText(config.message, schema, values, store.data) ||
              "插入字段后，在这里查看实际消息内容。"
            }}
          </p>
          <div class="reminder-preview-meta">
            <strong>预计接收人 · {{ recipients.length }} 人</strong>
            <p>
              {{ recipients.map((r) => r.name).join("、") || "尚无可用接收人" }}
            </p>
            <template v-if="config.trigger === 'date'"
              ><strong>样本对应提醒时间</strong>
              <p>
                {{ due?.toLocaleString("zh-CN") || "请配置日期并检查样本值" }}
              </p></template
            >
          </div>
          <p class="field-hint">
            试运行和事件触发均使用本地模拟，不发送真实消息。
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
        {{ saving ? "正在保存…" : "保存提醒" }}
      </button></template
    >
  </BaseDialog>
</template>
