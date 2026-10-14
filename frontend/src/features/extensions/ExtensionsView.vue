<script setup lang="ts">
import "./extensions.css";
import { computed, provide, ref, onMounted, onBeforeUnmount } from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import DesignerHeader from "../../components/shared/DesignerHeader.vue";
import WebhookEditor from "./components/WebhookEditor.vue";
import SubmissionSettings from "./components/SubmissionSettings.vue";
import QuickFillSettings from "./components/QuickFillSettings.vue";
import PrintTemplates from "./components/PrintTemplates.vue";
import DetailSettings from "./components/DetailSettings.vue";
import CollaborationSettings from "./components/CollaborationSettings.vue";
import ButtonSettings from "./components/ButtonSettings.vue";
import ReminderSettings from "./components/ReminderSettings.vue";
import AutomationSettings from "./components/AutomationSettings.vue";
import AutomationEditor from "./components/AutomationEditor.vue";
import type { AutomationConfig } from "../../domain/automation";
import RunTrace from "./components/RunTrace.vue";
import { useNotices } from "../../stores/notices";
import { runtimeDataKey } from "../../composables/useRuntimeData";
import { usePageDesignerStore } from "../../stores/pageDesigner";
import { copy, uid } from "../../domain/form";
import { emptyWorkspace, newForm } from "../../domain/workspace";
import {
  configurableFields,
  pluginRegistry,
  pushEvents,
  validateWebhook,
  validateInvocation,
  type WebhookConfig,
  type ExtensionRun,
} from "../../domain/extensions";
const route = useRoute();
const router = useRouter();
const { notify } = useNotices();
// 未开放的扩展只展示默认配置，不读取或执行浏览器内的旧业务数据。
const runtimeData = computed(() => emptyWorkspace());
provide(runtimeDataKey, runtimeData);
const designer = usePageDesignerStore();
const appId = String(route.params.applicationId || "");
const formId = String(route.params.pageId || "");
const pageData = computed(() => {
  return designer.data?.draft.id === formId ? designer.data : undefined;
});
const previewForm = ref(newForm(appId, "表单"));
previewForm.value.id = formId;
const form = computed(() => ({
  ...previewForm.value,
  title: pageData.value ? designer.state.title : previewForm.value.title,
  // 配置预览不能改动提交设置共用的服务端编辑状态。
  schema: pageData.value
    ? copy(designer.state.schema)
    : previewForm.value.schema,
}));

onMounted(() => {
  // 提交设置与设计器共用服务端草稿，不再把设置保存到本地原型。
  void designer.load(formId);
});

function goToPublish() {
  router.push(`/applications/${appId}/pages/${formId}/publish`);
}

function goToFlow(nodeId?: string) {
  router.push({
    path: `/applications/${appId}/pages/${formId}/flow`,
    query: nodeId ? { node: nodeId } : {},
  });
}

const section = ref<
    | "push"
    | "quickFill"
    | "plugins"
    | "logs"
    | "submission"
    | "print"
    | "detail"
    | "reminders"
    | "automation"
    | "buttons"
    | "collaboration"
  >("submission"),
  query = ref(""),
  archived = ref(false),
  editorOpen = ref(false),
  editing = ref<WebhookConfig>(),
  run = ref<ExtensionRun>(),
  logStatus = ref("all");
const automationOpen = ref(false),
  editingAutomation = ref<AutomationConfig>();
function editAutomation(config?: AutomationConfig) {
  editingAutomation.value = config;
  automationOpen.value = true;
}
const sectionInfo = computed(
  () =>
    ({
      quickFill: {
        group: "填写体验",
        title: "AI 快捷填报",
        description: "将输入内容整理成字段值，检查后再回填到表单。",
      },
      collaboration: {
        group: "查看与交付",
        title: "数据协作",
        description: "为记录设置清晰的标题，并在表格中快速完成小修改。",
      },
      buttons: {
        group: "填写体验",
        title: "自定义按钮",
        description: "在需要的地方放置操作，让数据填写和后续处理更顺手。",
      },
      automation: {
        group: "业务自动化",
        title: "智能助手 Pro",
        description: "数据变化后，按条件和顺序完成跨表新增、更新与检查。",
      },
      reminders: {
        group: "业务自动化",
        title: "推送提醒",
        description: "按数据变化或指定日期，提醒需要关注这条记录的人。",
      },
      push: {
        group: "外部连接",
        title: "数据推送",
        description: "数据发生变化时，将需要的信息同步给其他系统。",
      },
      plugins: {
        group: "业务自动化",
        title: "流程插件",
        description: "在指定流程步骤执行动作，并将结果交给后续节点。",
      },
      logs: {
        group: "运行与排错",
        title: "执行记录",
        description: "查看每次动作的输入、输出与失败原因。",
      },
      submission: {
        group: "填写体验",
        title: "提交提示",
        description: "让填写者清楚知道提交结果，并决定是否继续填写。",
      },
      print: {
        group: "查看与交付",
        title: "打印模板",
        description: "选择字段和版式，让每条记录都能清晰地打印和留存。",
      },
      detail: {
        group: "查看与交付",
        title: "数据详情",
        description: "安排记录的展示内容、顺序和布局，方便日常查看。",
      },
    })[section.value],
);
async function saveSubmission() {
  if (!pageData.value || !designer.dirty) return;
  if (await designer.save()) notify("提交提示已保存，发布新版本后生效");
}
const configs = computed(() =>
  (form.value?.extensions?.webhooks || []).filter(
    (c) =>
      c.archived === archived.value && (c.name + c.url).includes(query.value),
  ),
);
const nodes = computed(
  () =>
    form.value?.workflow.nodes.filter(
      (n) =>
        n.data.kind === "plugin" &&
        (
          n.data.label +
          (pluginRegistry.find((p) => p.id === n.data.plugin)?.name || "")
        ).includes(query.value),
    ) || [],
);
const runs = computed(() =>
  (runtimeData.value.extensionRuns || []).filter(
    (r) =>
      r.formId === formId &&
      (logStatus.value === "all" || r.status === logStatus.value) &&
      r.name.includes(query.value),
  ),
);
function eventNames(config: WebhookConfig) {
  return config.events.map((e) => pushEvents[e]).join("、");
}
function open(config?: WebhookConfig) {
  editing.value = config ? copy(config) : undefined;
  editorOpen.value = true;
}
function duplicate(config: WebhookConfig) {
  const next = copy(config);
  next.id = uid("push");
  next.name += " 副本";
  next.enabled = false;
  next.credentialRef = "";
  open(next);
}
function beforeUnload(e: BeforeUnloadEvent) {
  if (designer.dirty) e.preventDefault();
}
const leaveTo = ref("");
let leaveApproved = false;
function guard(to: { fullPath: string }) {
  if (designer.busy) return false;
  if (!designer.dirty || leaveApproved) return true;
  leaveTo.value = to.fullPath;
  return false;
}
onBeforeRouteLeave(guard);
onBeforeRouteUpdate(guard);
function leave() {
  leaveApproved = true;
  void router.push(leaveTo.value);
}
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => window.removeEventListener("beforeunload", beforeUnload));
</script>
<template>
  <div class="application extension-page">
    <DesignerHeader
      :title="pageData?.draft.title || '表单'"
      :app-id="appId"
      :form-id="formId"
      active="extensions"
      readonly-title
      @help="notify('提交提示保存并发布后生效；其他扩展页面仍为配置演示。')"
    />
    <main class="extension-shell">
      <aside class="extension-nav">
        <h2>扩展功能</h2>
        <p>让数据连接业务</p>
        <input
          v-if="!['submission', 'detail'].includes(section)"
          v-model="query"
          aria-label="搜索扩展配置"
          placeholder="搜索配置名称"
        /><span class="nav-group-label">外部连接</span
        ><button
          :class="{ active: section === 'push' }"
          @click="section = 'push'"
        >
          <AppIcon name="link" />数据推送<span>{{
            (form.extensions?.webhooks || []).filter((c) => !c.archived).length
          }}</span></button
        ><span class="nav-group-label">业务自动化</span
        ><button
          :class="{ active: section === 'automation' }"
          @click="section = 'automation'"
        >
          <AppIcon name="condition" />智能助手 Pro<span>{{
            (form.extensions?.automations || []).filter((c) => !c.archived)
              .length
          }}</span></button
        ><button
          :class="{ active: section === 'reminders' }"
          @click="section = 'reminders'"
        >
          <AppIcon name="bell" />推送提醒<span>{{
            (form.extensions?.reminders || []).filter((c) => !c.archived).length
          }}</span></button
        ><button
          :class="{ active: section === 'plugins' }"
          @click="section = 'plugins'"
        >
          <AppIcon name="plugin" />流程插件<span>{{
            form.workflow.nodes.filter((n) => n.data.kind === "plugin").length
          }}</span></button
        ><button @click="goToFlow()">
          <AppIcon name="condition" />流程编排<AppIcon name="right" /></button
        ><span class="nav-group-label">填写体验</span
        ><button
          :class="{ active: section === 'quickFill' }"
          @click="section = 'quickFill'"
        >
          <AppIcon name="edit" />AI 快捷填报</button
        ><button
          :class="{ active: section === 'buttons' }"
          @click="section = 'buttons'"
        >
          <AppIcon name="button" />自定义按钮</button
        ><button
          :class="{ active: section === 'submission' }"
          @click="section = 'submission'"
        >
          <AppIcon name="success" />提交提示</button
        ><span class="nav-group-label">查看与交付</span
        ><button
          :class="{ active: section === 'collaboration' }"
          @click="section = 'collaboration'"
        >
          <AppIcon name="table" />数据协作</button
        ><button
          :class="{ active: section === 'detail' }"
          @click="section = 'detail'"
        >
          <AppIcon name="document" />数据详情</button
        ><button
          :class="{ active: section === 'print' }"
          @click="section = 'print'"
        >
          <AppIcon name="print" />打印模板</button
        ><span class="nav-group-label">运行与排错</span
        ><button
          :class="{ active: section === 'logs' }"
          @click="section = 'logs'"
        >
          <AppIcon name="time" />执行记录
        </button>
        <div class="extension-nav-foot">
          <AppIcon name="desktop" /><span
            >扩展功能<br /><small>提交提示已接入表单发布</small></span
          >
        </div>
      </aside>
      <section class="extension-content">
        <header class="extension-page-header">
          <div>
            <span class="eyebrow">{{ sectionInfo.group }}</span>
            <h1>{{ sectionInfo.title }}</h1>
            <p>{{ sectionInfo.description }}</p>
          </div>
          <button
            v-if="section === 'push'"
            class="button primary"
            disabled
            @click="open()"
          >
            <AppIcon name="add" />新建数据推送</button
          ><button
            v-else-if="section === 'plugins'"
            class="button primary"
            disabled
          >
            <AppIcon name="add" />添加插件动作
          </button>
        </header>
        <div v-if="section === 'submission'" class="extension-version">
          <AppIcon name="info" /><span
            >保存设置后，发布新版本即可应用到正式填写页。</span
          >
          <button class="text-button" @click="goToPublish">
            前往发布<AppIcon name="right" />
          </button>
        </div>
        <div v-else class="extension-version" role="status">
          <AppIcon name="info" />
          <span
            >此功能暂未开放。当前页面仅供查看配置效果，不能保存或执行。</span
          >
        </div>
        <fieldset
          class="extension-configuration"
          :disabled="section !== 'submission'"
        >
          <QuickFillSettings v-if="section === 'quickFill'" :form="form" />
          <template v-else-if="section === 'push'"
            ><div class="extension-list-tools">
              <span>{{ configs.length }} 项配置</span
              ><label
                ><input type="checkbox" v-model="archived" />查看已归档</label
              >
            </div>
            <div v-if="!configs.length" class="extension-empty">
              <div class="extension-empty-icon">
                <AppIcon name="link" :size="32" />
              </div>
              <h2>
                {{
                  query
                    ? "没有匹配的配置"
                    : archived
                      ? "没有已归档的推送"
                      : "让每一次数据变化，都有去向"
                }}
              </h2>
              <p>
                选择触发事件、配置接收地址，发送内容会实时预览。<br />先用一条示例数据验证，再保存配置。
              </p>
              <div class="empty-path">
                <span>选择事件</span><AppIcon name="right" /><span
                  >匹配字段</span
                ><AppIcon name="right" /><span>测试结果</span>
              </div>
              <button v-if="!archived" class="button primary" @click="open()">
                创建第一条数据推送
              </button>
            </div>
            <div v-else class="push-config-list">
              <article
                v-for="config in configs"
                :key="config.id"
                class="push-config-card"
              >
                <div class="config-card-title">
                  <span class="extension-card-icon"
                    ><AppIcon name="link" :size="20"
                  /></span>
                  <div>
                    <h3>{{ config.name }}</h3>
                    <p>
                      {{ eventNames(config) }} ·
                      {{ config.fieldIds.length }} 个字段
                    </p>
                  </div>
                  <span
                    class="status-pill"
                    :class="{ enabled: config.enabled }"
                    >{{
                      config.archived
                        ? "已归档"
                        : config.enabled
                          ? "启用 · 本地模拟"
                          : "已停用"
                    }}</span
                  >
                </div>
                <div class="config-card-url">
                  <span>POST</span><code>{{ config.url }}</code>
                </div>
                <p
                  v-if="
                    validateWebhook(
                      config,
                      form.schema,
                      runtimeData.webhookCredentials || [],
                    ).length
                  "
                  class="config-warning"
                >
                  <AppIcon name="warning" />{{
                    validateWebhook(
                      config,
                      form.schema,
                      runtimeData.webhookCredentials || [],
                    )[0]?.message
                  }}
                </p>
                <div class="config-card-footer">
                  <span>{{
                    config.note || "按配置事件触发，失败可查看执行记录"
                  }}</span
                  ><button class="text-button" @click="open(config)">
                    编辑与测试</button
                  ><button v-if="!config.archived" class="text-button" disabled>
                    {{ config.enabled ? "停用" : "启用" }}</button
                  ><button
                    v-if="!config.archived"
                    class="text-button"
                    @click="duplicate(config)"
                  >
                    复制</button
                  ><button class="text-button" disabled>
                    {{ config.archived ? "恢复" : "归档" }}
                  </button>
                </div>
              </article>
            </div></template
          >
          <template v-else-if="section === 'plugins'"
            ><p v-if="form.kind !== 'workflow'" class="config-warning">
              插件动作尚未开放，当前仅展示配置入口。
            </p>
            <div v-if="!nodes.length" class="extension-empty">
              <div class="extension-empty-icon">
                <AppIcon name="plugin" :size="32" />
              </div>
              <h2>为流程加入自动处理的一步</h2>
              <p>
                计算金额、组合文本，或连接外部系统。<br />动作与节点连线由流程设计决定。
              </p>
              <button class="button primary" disabled>选择要执行的动作</button>
            </div>
            <div class="push-config-list">
              <article
                v-for="node in nodes"
                :key="node.id"
                class="push-config-card"
              >
                <div class="config-card-title">
                  <AppIcon name="plugin" :size="24" />
                  <div>
                    <h3>{{ node.data.label }}</h3>
                    <p>
                      {{
                        pluginRegistry.find((p) => p.id === node.data.plugin)
                          ?.description || "等待选择动作"
                      }}
                    </p>
                  </div>
                  <span class="mode-tag">{{
                    pluginRegistry.find((p) => p.id === node.data.plugin)
                      ?.mode === "local"
                      ? "本地运行"
                      : "模拟连接"
                  }}</span>
                </div>
                <p
                  v-if="
                    node.data.pluginConfig &&
                    validateInvocation(node.data.pluginConfig, form.schema)
                      .length
                  "
                  class="config-warning"
                >
                  {{
                    validateInvocation(node.data.pluginConfig, form.schema)[0]
                      ?.message
                  }}
                </p>
                <div class="config-card-footer">
                  <span
                    >{{
                      node.data.pluginConfig?.outputs.length || 0
                    }}
                    个结果回填</span
                  ><button class="text-button" disabled>配置与试运行</button
                  ><button class="text-button" @click="goToFlow(node.id)">
                    在流程中定位<AppIcon name="right" />
                  </button>
                </div>
              </article></div
          ></template>
          <SubmissionSettings
            v-else-if="section === 'submission' && pageData"
            :schema="designer.state.schema"
            :dirty="designer.dirty"
            :busy="designer.busy"
            :error="designer.error"
            @save="saveSubmission"
          />
          <div v-else-if="section === 'submission'" class="extension-empty">
            <p role="status">{{ designer.error || "正在读取提交设置…" }}</p>
            <button
              v-if="designer.error"
              class="button"
              @click="designer.load(formId)"
            >
              重新加载
            </button>
          </div>
          <PrintTemplates
            v-else-if="section === 'print'"
            :form="form"
            :query="query"
          />
          <CollaborationSettings
            v-else-if="section === 'collaboration'"
            :form="form"
          />
          <DetailSettings v-else-if="section === 'detail'" :form="form" />
          <ButtonSettings
            v-else-if="section === 'buttons'"
            :form="form"
            :query="query"
          />
          <AutomationSettings
            v-else-if="section === 'automation'"
            :form="form"
            :query="query"
            @edit="editAutomation"
            @logs="section = 'logs'"
          />
          <ReminderSettings
            v-else-if="section === 'reminders'"
            :form="form"
            :query="query"
          />
          <template v-else
            ><div class="extension-list-tools">
              <span>执行记录</span
              ><select v-model="logStatus" aria-label="执行状态筛选">
                <option value="all">全部状态</option>
                <option value="success">成功</option>
                <option value="failed">失败</option>
                <option value="skipped">未触发</option>
              </select>
            </div>
            <div v-if="!runs.length" class="extension-empty">
              <AppIcon name="time" :size="36" />
              <h2>暂无执行记录</h2>
              <p>扩展执行尚未开放。</p>
            </div>
            <div v-else class="extension-log-table">
              <table>
                <thead>
                  <tr>
                    <th>动作 / 来源</th>
                    <th>时间</th>
                    <th>状态</th>
                    <th>结果</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in runs" :key="item.id">
                    <td>
                      <strong>{{ item.name }}</strong
                      ><small
                        >{{
                          item.origin === "schedule"
                            ? "日期检查"
                            : item.origin === "record"
                              ? "表单事件"
                              : "试运行"
                        }}
                        ·
                        {{ item.mode === "simulation" ? "模拟连接" : "本地运算"
                        }}{{ item.retryOf ? " · 重试" : "" }}</small
                      >
                    </td>
                    <td>{{ new Date(item.time).toLocaleString("zh-CN") }}</td>
                    <td>
                      <span class="status-pill" :class="item.status">{{
                        item.status === "success"
                          ? "成功"
                          : item.status === "failed"
                            ? "失败"
                            : "未触发"
                      }}</span>
                    </td>
                    <td>
                      {{ item.error?.message || item.steps.at(-1)?.detail }}
                    </td>
                    <td>
                      <button class="text-button" @click="run = item">
                        查看详情
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div></template
          >
        </fieldset>
      </section>
    </main>
    <BaseDialog
      :open="!!leaveTo"
      title="提交设置尚未保存"
      width="420px"
      @close="leaveTo = ''"
    >
      <p>离开后，本次未保存的设置会丢失。</p>
      <template #footer>
        <button class="button" @click="leaveTo = ''">继续编辑</button>
        <button class="button danger" @click="leave">放弃修改并离开</button>
      </template>
    </BaseDialog>
    <AutomationEditor
      v-if="automationOpen"
      :open="automationOpen"
      :model-value="editingAutomation"
      :schema="form.schema"
      :form-id="formId"
      @close="automationOpen = false"
    />
    <WebhookEditor
      v-if="editorOpen"
      :open="editorOpen"
      :model-value="editing"
      :schema="form.schema"
      :form-id="formId"
      @close="editorOpen = false"
    />
    <BaseDialog
      :open="!!run"
      title="执行详情"
      width="850px"
      @close="run = undefined"
      ><template v-if="run"
        ><p class="field-hint">本次执行使用当时保存的配置与数据快照。</p>
        <RunTrace
          :run="run"
          :fields="configurableFields(run.snapshot.schema)"
        />
        <details>
          <summary>查看配置快照</summary>
          <pre class="snapshot-json">{{
            JSON.stringify(run.snapshot.config, null, 2)
          }}</pre>
        </details></template
      ><template #footer>
        <button class="button" @click="run = undefined">关闭</button>
      </template>
    </BaseDialog>
  </div>
</template>
