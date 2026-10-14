<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import DataFilterEditor from "../../forms/components/DataFilterEditor.vue";
import SampleEditor from "./SampleEditor.vue";
import RunTrace from "./RunTrace.vue";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { copy, type FormSchema, type FormValues } from "../../../domain/form";
import {
  configurableFields,
  newWebhook,
  pushEvents,
  validateWebhook,
  webhookPayload,
  sampleValues,
  runWebhook,
  type WebhookConfig,
  type ConfigIssue,
  type PushEvent,
  type ExtensionRun,
} from "../../../domain/extensions";
import { useRuntimeData } from "../../../composables/useRuntimeData";
const props = defineProps<{
  open: boolean;
  modelValue?: WebhookConfig;
  schema: FormSchema;
  formId: string;
}>();
const emit = defineEmits<{ close: [] }>();
const runtimeData = useRuntimeData();
const config = ref(newWebhook()),
  step = ref(0),
  errors = ref<ConfigIssue[]>([]),
  values = ref<FormValues>({}),
  event = ref<PushEvent>("data_create"),
  failure = ref(false),
  result = ref<ExtensionRun>(),
  testedFingerprint = ref("");
const fields = computed(() => configurableFields(props.schema));
const fingerprint = computed(() =>
  JSON.stringify({
    config: {
      ...config.value,
      enabled: undefined,
      archived: undefined,
      note: undefined,
    },
    values: values.value,
    event: event.value,
    failure: failure.value,
    schema: props.schema,
  }),
);
const stale = computed(
  () => result.value && testedFingerprint.value !== fingerprint.value,
);
const payload = computed(() =>
  webhookPayload(config.value, values.value, event.value),
);
const steps = ["什么时候触发", "发到哪里", "发送什么", "测试与保存"];
watch(
  () => props.open,
  (open) => {
    if (open) {
      config.value = copy(props.modelValue || newWebhook());
      if (!props.modelValue)
        config.value.fieldIds = fields.value.map((f) => f.id);
      step.value = 0;
      errors.value = [];
      values.value = sampleValues(props.schema);
      event.value = config.value.events[0] || "data_create";
      result.value = undefined;
      failure.value = false;
    }
  },
  { immediate: true },
);
function next() {
  errors.value = validateWebhook(
    config.value,
    props.schema,
    runtimeData.value.webhookCredentials || [],
  ).filter((i) => i.step === step.value);
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
  result.value = runWebhook(
    config.value,
    props.schema,
    values.value,
    event.value,
    runtimeData.value,
    failure.value,
  );
  if (previous?.status === "failed") result.value.retryOf = previous.id;
  testedFingerprint.value = fingerprint.value;
}
const { confirmDiscard, requestClose, discard } = useDraftDismiss(
  () => props.open,
  () => config.value,
  () => emit("close"),
);
</script>
<template>
  <BaseDialog
    :open="open"
    :title="modelValue ? '编辑数据推送' : '新建数据推送'"
    width="1100px"
    @close="requestClose"
  >
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
      <nav class="config-steps" aria-label="数据推送配置步骤">
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
            ><h3>哪些变化需要同步？</h3>
            <label class="config-label"
              >推送名称<input
                id="push-name"
                v-model="config.name"
                maxlength="60"
                placeholder="例如：订单同步到财务系统"
            /></label>
            <fieldset id="events" tabindex="-1">
              <legend>触发事件</legend>
              <div class="event-options">
                <label v-for="(label, key) in pushEvents" :key="key"
                  ><input
                    type="checkbox"
                    :value="key"
                    v-model="config.events"
                  />{{ label }}</label
                >
              </div>
            </fieldset>
            <div id="filters" tabindex="-1" class="config-field">
              <h4>仅推送符合条件的数据 <span class="optional">可选</span></h4>
              <DataFilterEditor
                v-model="config.filters"
                :source-fields="fields"
                :local-fields="fields"
                hint="同时满足以下条件时触发。不设置条件则推送该事件的全部数据。"
              /></div
          ></template>
          <template v-else-if="step === 1"
            ><h3>发送到哪个系统？</h3>
            <label class="config-label"
              >服务器地址<input
                id="push-url"
                v-model.trim="config.url"
                placeholder="https://example.com/webhooks/orders"
                type="url"
            /></label>
            <div class="request-method">
              <span>POST</span>
              <p>以 JSON 格式发送到接收系统。</p>
            </div>
            <section
              id="credential"
              tabindex="-1"
              class="secret-setup"
              aria-label="Secret 设置"
            >
              <div class="secret-heading">
                <label for="webhook-secret">Secret</label
                ><span class="mode-tag">暂未开放</span>
              </div>
              <div class="secret-controls">
                <input
                  id="webhook-secret"
                  type="password"
                  readonly
                  autocomplete="off"
                  placeholder="尚未接入凭证管理"
                  aria-describedby="secret-hint"
                />
                <button class="button" disabled title="暂未开放凭证管理">
                  生成 Secret
                </button>
              </div>
              <p id="secret-hint" class="field-hint">
                双方保存同一个 Secret，用于校验每次推送的签名。Secret
                不随推送发送，也不会自动同步到接收端。
              </p>
              <ol class="receiver-setup" aria-label="接收端接入步骤">
                <li>由发送方配置 Secret，并交给接收服务的管理员。</li>
                <li>
                  在接收服务的 Webhook
                  配置或服务端环境变量中保存同一密钥，并实现验签。
                </li>
                <li>若接收方启用了 IP 白名单，另外放行发送服务器的出口 IP。</li>
              </ol>
            </section>
            <section class="connection-check" aria-label="服务器连接测试">
              <h4>服务器连接测试 <span class="optional">暂未开放</span></h4>
              <div class="connection-controls">
                <select disabled aria-label="连接测试场景">
                  <option value="success">接收端正常响应</option>
                  <option value="signature">接收端 Secret 不一致</option>
                  <option value="timeout">接收端响应超时</option></select
                ><button class="button" disabled title="暂未开放连接测试">
                  <AppIcon name="link" />测试签名与连接
                </button>
              </div>
              <p class="field-hint">凭证管理与连接测试尚未开放。</p>
            </section>
            <details class="webhook-protocol">
              <summary>每次推送如何验签？</summary>
              <ol>
                <li>接收 POST 请求，读取原始请求体、nonce 和 timestamp。</li>
                <li>
                  按 nonce:原始请求体:Secret:timestamp 拼接，使用 UTF-8 编码计算
                  SHA-1，再将十六进制结果与 X-JDY-Signature 比较。
                </li>
                <li>
                  验签失败则拒绝处理；通过后按 X-JDY-DeliverId 去重，并在 2
                  秒内返回 2xx。
                </li>
              </ol>
              <p>
                生成密钥不代表接收端已配置完成。连接测试用于检查一次请求与响应，后续每次推送仍需验签。
              </p>
              <a
                href="https://hc.jiandaoyun.com/open/11507"
                target="_blank"
                rel="noreferrer"
                >查看官方签名与响应规则 ↗</a
              >
            </details>
            <label class="config-label"
              >备注<textarea
                v-model="config.note"
                rows="3"
                placeholder="这项推送服务于什么业务？"
              /></label
          ></template>
          <template v-else-if="step === 2"
            ><h3 id="payload-fields" tabindex="-1">选择要发送的字段</h3>
            <p class="field-hint">
              右侧为实时 JSON 样例。使用稳定字段 ID，修改字段名称不会影响对接。
            </p>
            <div class="field-selection-tools">
              <button
                class="text-button"
                @click="config.fieldIds = fields.map((f) => f.id)"
              >
                全选</button
              ><button class="text-button" @click="config.fieldIds = []">
                清空</button
              ><span>已选择 {{ config.fieldIds.length }} 项</span>
            </div>
            <div class="payload-fields">
              <label v-for="f in fields" :key="f.id"
                ><input
                  type="checkbox"
                  :value="f.id"
                  v-model="config.fieldIds"
                /><span
                  ><strong>{{ f.label }}</strong
                  ><small>{{ f.id }}</small></span
                ></label
              ><label
                v-for="id in config.fieldIds.filter(
                  (id) => !fields.some((f) => f.id === id),
                )"
                :key="id"
                class="invalid-field"
                ><input
                  type="checkbox"
                  :value="id"
                  v-model="config.fieldIds"
                />已删除字段：{{ id }}</label
              >
            </div>
            <p v-if="!fields.length" class="config-warning">
              表单还没有可发送字段，请先在表单设计器添加字段。
            </p>
            <p class="field-hint">
              删除事件只发送记录标识，不携带已删除的数据内容。
            </p></template
          >
          <template v-else
            ><h3>确认这次会发送什么</h3>
            <SampleEditor v-model="values" :schema="schema" :form-id="formId" />
            <div class="trial-toolbar">
              <label
                >模拟事件<select v-model="event" aria-label="模拟推送事件">
                  <option
                    v-for="(label, key) in pushEvents"
                    :key="key"
                    :value="key"
                  >
                    {{ label }}
                  </option>
                </select></label
              ><label id="test-scenario" tabindex="-1"
                >响应场景<select v-model="failure" aria-label="推送测试场景">
                  <option :value="false">模拟接收成功</option>
                  <option :value="true">模拟服务器超时</option>
                </select></label
              ><button class="button primary" @click="trial">
                <AppIcon name="launch" />{{
                  result?.status === "failed" ? "重试本次推送" : "运行测试"
                }}
              </button>
            </div>
            <p v-if="stale" class="config-warning">
              配置或样本已变化，当前结果来自上一次测试。
            </p>
            <RunTrace
              v-if="result"
              :run="result"
              :fields="fields"
              @locate="locate"
            /><label class="enable-config"
              ><input type="checkbox" v-model="config.enabled" /><span
                ><strong>启用事件触发</strong
                ><small>事件触发尚未开放，当前配置仅用于预览。</small></span
              ></label
            ></template
          >
        </section>
        <aside class="config-preview">
          <span class="eyebrow">发送内容 · 实时预览</span>
          <h3>{{ config.name || "新的数据推送" }}</h3>
          <div class="preview-callout">
            <AppIcon name="info" /><span
              >这里只预览推送内容与响应样例，不会连接外部服务器。</span
            >
          </div>
          <div class="preview-endpoint">
            <span>POST</span
            ><code>{{ config.url || "等待配置服务器地址" }}</code>
          </div>
          <pre>{{ JSON.stringify(payload, null, 2) }}</pre>
          <details>
            <summary>字段对照表（{{ config.fieldIds.length }}）</summary>
            <dl class="field-dictionary">
              <template v-for="id in config.fieldIds" :key="id"
                ><dt>
                  {{ fields.find((f) => f.id === id)?.label || "字段已删除" }}
                </dt>
                <dd>{{ id }}</dd></template
              >
            </dl>
          </details>
          <p class="field-hint">
            op：事件类型 · opTime：触发时间<br />data：记录标识与所选业务字段
          </p>
        </aside>
      </div>
    </div>
    <template #footer
      ><button class="button" @click="requestClose">取消</button
      ><button v-if="step > 0" class="button" @click="step--">上一步</button
      ><button v-if="step < 3" class="button primary" @click="next">
        下一步</button
      ><button v-else class="button primary" disabled title="暂未开放保存">
        保存配置
      </button></template
    >
  </BaseDialog>
</template>
