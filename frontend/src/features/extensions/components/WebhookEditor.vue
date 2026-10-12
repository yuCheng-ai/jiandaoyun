<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import DataFilterEditor from "../../forms/components/DataFilterEditor.vue";
import SampleEditor from "./SampleEditor.vue";
import RunTrace from "./RunTrace.vue";
import {
  checkWebhookConnection,
  type ConnectionCheck,
  type ConnectionScenario,
} from "../../../domain/webhookSecurity";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { restoreWebhookDraft } from "../../../domain/editorDraftAdapters";
import { copy, type FormSchema, type FormValues } from "../../../domain/form";
import {
  configurableFields,
  newWebhook,
  pushEvents,
  validateWebhook,
  validEndpoint,
  webhookPayload,
  sampleValues,
  runWebhook,
  type WebhookConfig,
  type ConfigIssue,
  type PushEvent,
  type ExtensionRun,
} from "../../../domain/extensions";
import { useWorkspaceStore } from "../../../stores/workspace";
const props = defineProps<{
  open: boolean;
  modelValue?: WebhookConfig;
  schema: FormSchema;
  formId: string;
}>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore(),
  config = ref(newWebhook()),
  step = ref(0),
  errors = ref<ConfigIssue[]>([]),
  values = ref<FormValues>({}),
  event = ref<PushEvent>("data_create"),
  failure = ref(false),
  result = ref<ExtensionRun>(),
  testedFingerprint = ref(""),
  connection = ref<ConnectionCheck>(),
  connectionBusy = ref(false),
  connectionScenario = ref<ConnectionScenario>("success"),
  secretVisible = ref(false),
  rotatePending = ref(false),
  copyStatus = ref("");
let connectionRequest = 0;
const credential = computed(() =>
  store.data.webhookCredentials?.find(
    (c) => c.id === config.value.credentialRef,
  ),
);
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
      connection.value = undefined;
      connectionBusy.value = false;
      connectionRequest++;
      connectionScenario.value = "success";
      secretVisible.value = false;
      rotatePending.value = false;
      copyStatus.value = "";
      failure.value = false;
    }
  },
  { immediate: true },
);
watch(
  () => [
    config.value.url,
    config.value.credentialRef,
    connectionScenario.value,
  ],
  () => {
    connection.value = undefined;
    connectionBusy.value = false;
    connectionRequest++;
  },
);
function next() {
  errors.value = validateWebhook(
    config.value,
    props.schema,
    store.data.webhookCredentials || [],
  ).filter((i) => i.step === step.value);
  if (!errors.value.length) step.value = Math.min(3, step.value + 1);
}
function locate(issue: ConfigIssue) {
  step.value = issue.step;
  errors.value = [issue];
  nextTick(() => document.getElementById(issue.target)?.focus());
}
async function trial() {
  errors.value = [];
  const previous = result.value;
  result.value = runWebhook(
    config.value,
    props.schema,
    values.value,
    event.value,
    store.data,
    failure.value,
  );
  if (previous?.status === "failed") result.value.retryOf = previous.id;
  testedFingerprint.value = fingerprint.value;
  await store.recordExtensionRun(result.value, props.formId);
}
async function generateSecret() {
  if (!validEndpoint(config.value.url)) {
    locate({
      step: 1,
      target: "push-url",
      message: "请先填写完整的服务器地址",
    });
    return;
  }
  try {
    const next = await store.createWebhookCredential();
    if (!next) return;
    config.value.credentialRef = next.id;
    secretVisible.value = false;
    rotatePending.value = false;
    copyStatus.value = "";
    errors.value = errors.value.filter((e) => e.target !== "credential");
    store.notify("本地演示 Secret 已生成，请将相同 Secret 配置到接收端");
  } catch {
    store.notify(
      "当前环境无法生成 Secret，请在 localhost 或 HTTPS 环境中使用",
      "warning",
    );
  }
}
async function copySecret() {
  if (!credential.value) return;
  try {
    await navigator.clipboard.writeText(credential.value.secret);
    copyStatus.value = "已复制 Secret";
  } catch {
    copyStatus.value = "浏览器未允许复制，请显示 Secret 后选中文本复制";
  }
}
async function testConnection() {
  if (!validEndpoint(config.value.url)) {
    locate({
      step: 1,
      target: "push-url",
      message: "请填写完整的 HTTP 或 HTTPS 地址",
    });
    return;
  }
  if (!credential.value) {
    locate({
      step: 1,
      target: "credential",
      message: "请先生成 Secret，再进行连接测试",
    });
    return;
  }
  errors.value = [];
  const current = ++connectionRequest;
  connectionBusy.value = true;
  try {
    const result = await checkWebhookConnection(
      config.value.url,
      JSON.stringify(payload.value),
      credential.value,
      connectionScenario.value,
    );
    if (current === connectionRequest) connection.value = result;
  } catch {
    if (current === connectionRequest)
      store.notify(
        "本地签名计算失败，请检查当前浏览器是否支持 Web Crypto",
        "warning",
      );
  } finally {
    if (current === connectionRequest) connectionBusy.value = false;
  }
}

async function save() {
  errors.value = validateWebhook(
    config.value,
    props.schema,
    store.data.webhookCredentials || [],
  );
  if (errors.value.length) {
    locate(errors.value[0]!);
    return;
  }
  if (await store.saveWebhook(props.formId, config.value)) {
    markSaved();
    store.notify("推送配置已保存；发布新版本后用于本地事件触发");
    emit("close");
  }
}
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => props.open,
    () => config.value,
    () => emit("close"),
    {
      key: () => `webhook:${props.formId}:${props.modelValue?.id || "new"}`,
      title: () => `数据推送 · ${config.value.name || "未命名推送"}`,
      context: () => ({
        schema: props.schema,
        original: props.modelValue || null,
        member: store.data.organization.currentUserId,
      }),
      restore: (value) => {
        const restored = restoreWebhookDraft(value, props.modelValue?.id);
        config.value = restored;
        step.value = 0;
        errors.value = [];
        result.value = undefined;
        connection.value = undefined;
        connectionBusy.value = false;
        connectionRequest++;
        secretVisible.value = false;
        rotatePending.value = false;
        confirmDiscard.value = false;
      },
    },
  );
</script>
<template>
  <BaseDialog
    :open="open"
    :busy="store.writePending"
    :draft-key="draftKey"
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
                ><span class="mode-tag">本地演示</span>
              </div>
              <div class="secret-controls">
                <input
                  id="webhook-secret"
                  :type="secretVisible ? 'text' : 'password'"
                  :value="credential?.secret || ''"
                  readonly
                  autocomplete="off"
                  placeholder="填写地址后，点击生成 Secret"
                  aria-describedby="secret-hint"
                />
                <button
                  v-if="credential"
                  class="button"
                  :aria-label="secretVisible ? '隐藏 Secret' : '显示 Secret'"
                  @click="secretVisible = !secretVisible"
                >
                  <AppIcon :name="secretVisible ? 'hidden' : 'eye'" />
                </button>
                <button
                  v-if="credential"
                  class="button"
                  aria-label="复制 Secret"
                  @click="copySecret"
                >
                  <AppIcon name="duplicate" />复制
                </button>
                <button
                  class="button"
                  :disabled="!validEndpoint(config.url)"
                  @click="
                    credential ? (rotatePending = true) : generateSecret()
                  "
                >
                  {{ credential ? "重新生成" : "生成 Secret" }}
                </button>
              </div>
              <p id="secret-hint" class="field-hint">
                双方保存同一个 Secret，用于校验每次推送的签名。Secret
                不随推送发送，也不会自动同步到接收端。
              </p>
              <ol class="receiver-setup" aria-label="接收端接入步骤">
                <li>在此生成 Secret，并复制给接收服务的管理员。</li>
                <li>
                  在接收服务的 Webhook
                  配置或服务端环境变量中保存同一密钥，并实现验签。
                </li>
                <li>若接收方启用了 IP 白名单，另外放行发送服务器的出口 IP。</li>
              </ol>
              <p
                v-if="!credential && config.credentialRef"
                class="config-warning"
              >
                旧演示凭证尚无 Secret，请在此重新生成。
              </p>
              <p v-if="credential" class="field-hint">
                生成于
                {{ new Date(credential.createdAt).toLocaleString("zh-CN") }} ·
                仅保存在当前浏览器，不能用于生产接入。
              </p>
              <p v-if="copyStatus" role="status" class="field-hint">
                {{ copyStatus }}
              </p>
              <div v-if="rotatePending" class="secret-rotation" role="alert">
                <p>
                  重新生成后，需要同步更新接收端
                  Secret。保存并发布后用于新记录；历史版本继续引用旧 Secret。
                </p>
                <button class="button" @click="rotatePending = false">
                  保留当前 Secret</button
                ><button class="button primary" @click="generateSecret">
                  确认重新生成
                </button>
              </div>
            </section>
            <section class="connection-check" aria-label="服务器连接测试">
              <h4>服务器连接测试 <span class="optional">本地模拟</span></h4>
              <div class="connection-controls">
                <select v-model="connectionScenario" aria-label="连接测试场景">
                  <option value="success">接收端正常响应</option>
                  <option value="signature">接收端 Secret 不一致</option>
                  <option value="timeout">接收端响应超时</option></select
                ><button
                  class="button"
                  :disabled="
                    !validEndpoint(config.url) || !credential || connectionBusy
                  "
                  @click="testConnection"
                >
                  <AppIcon name="link" />{{
                    connectionBusy ? "正在验签…" : "测试签名与连接"
                  }}
                </button>
              </div>
              <p class="field-hint">
                先生成
                Secret，再验证请求签名与响应流程。本次测试不会连接外部服务器。
              </p>
              <div
                v-if="connection"
                class="connection-result"
                :class="connection.status"
                role="status"
              >
                <AppIcon
                  :name="
                    connection.status === 'success' ? 'success' : 'warning'
                  "
                /><span>{{ connection.message }}</span>
              </div>
              <details v-if="connection" class="connection-request">
                <summary>查看测试请求（不含 Secret）</summary>
                <p class="field-hint">
                  URL 参数与请求头用于验签；消息体保留原始字符串。
                </p>
                <pre>{{ JSON.stringify(connection.request, null, 2) }}</pre>
              </details>
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
                ><strong>启用本地事件触发</strong
                ><small
                  >发布后，提交记录会产生模拟推送日志。不会发送真实网络请求。</small
                ></span
              ></label
            ></template
          >
        </section>
        <aside class="config-preview">
          <span class="eyebrow">发送内容 · 实时预览</span>
          <h3>{{ config.name || "新的数据推送" }}</h3>
          <div class="preview-callout">
            <AppIcon name="info" /><span
              >所有连接与响应均为本地模拟，测试不会发送业务数据。</span
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
      ><button v-else class="button primary" @click="save">
        保存配置
      </button></template
    >
  </BaseDialog>
</template>
