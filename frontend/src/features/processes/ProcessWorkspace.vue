<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import BaseDialog from "../../components/BaseDialog.vue";
import type {
  DefinitionSummary,
  PageSummary,
  ProcessTemplateDraft,
  ProcessSummary,
} from "@platform/contracts";
import { usePlatformSession } from "../../stores/platformSession";
import { platformApi } from "../../repositories/platformApi";
import ProcessStartDialog from "./ProcessStartDialog.vue";
import ProcessDetail from "./ProcessDetail.vue";
import "./processes.css";
const props = defineProps<{
  applicationId?: string;
  objects?: DefinitionSummary[];
  pages?: PageSummary[];
  scope?: "todo" | "started" | "handled" | "copied" | "delegation";
}>();
const session = usePlatformSession(),
  templates = ref<ProcessTemplateDraft[]>([]),
  processes = ref<ProcessSummary[]>([]);
const busy = ref(false),
  error = ref(""),
  editing = ref(false),
  selectedPage = ref(""),
  starting = ref<ProcessTemplateDraft>();
const heading = computed(() =>
  props.scope
    ? {
        todo: "我的待办",
        started: "我发起的",
        handled: "我处理的",
        copied: "抄送我的",
        delegation: "待办委托",
      }[props.scope]
    : "流程",
);
const router = useRouter();
const route = useRoute();
const processId = computed(() =>
  typeof route.query.process === "string" ? route.query.process : "",
);
function openProcess(id: string) {
  void router.push({
    path: route.path,
    query: { ...route.query, process: id },
  });
}
function closeProcess() {
  const { process, ...query } = route.query;
  const destination = { path: route.path, query };
  // 从列表打开后关闭回到原列表；直接访问申请链接时也能留在工作台。
  if (
    router.options.history.state.back === router.resolve(destination).fullPath
  ) {
    router.back();
  } else {
    void router.replace(destination);
  }
}
const availablePages = computed(() =>
  (props.pages || []).filter((page) => page.latestVersion && !page.archivedAt),
);
function configure(template?: ProcessTemplateDraft) {
  const pageId =
    template?.startPageId ||
    template?.spec.tasks[0]?.pageId ||
    selectedPage.value;
  if (!pageId || !props.applicationId) return;
  router.push({
    path: `/applications/${props.applicationId}/pages/${pageId}/flow`,
    query: template ? { templateId: template.id } : {},
  });
}
function start(template: ProcessTemplateDraft) {
  if (template.startPageId) {
    router.push({
      path: `/applications/${template.applicationId}`,
      query: { form: template.startPageId },
    });
    return;
  }
  starting.value = template;
}
function templateStatus(template: ProcessTemplateDraft) {
  if (!template.activeVersion) return "草稿";
  const state = template.enabled ? "启用中" : "已停用";
  const changes = template.hasDraftChanges ? " · 有未发布修改" : "";
  return `${state} V${template.activeVersion}${changes}`;
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await Promise.all([
      platformApi<typeof processes.value>(
        `/processes?${new URLSearchParams({ ...(props.applicationId ? { applicationId: props.applicationId } : {}), ...(props.scope ? { scope: props.scope } : {}) })}`,
      ),
      session.user?.role === "admin" && props.applicationId
        ? platformApi<ProcessTemplateDraft[]>(
            `/process-templates?applicationId=${props.applicationId}`,
          )
        : Promise.resolve([]),
    ]);
    [processes.value, templates.value] = result;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="panel-card collab-section">
    <div class="collab-toolbar">
      <div>
        <h2>{{ heading }}</h2>
        <p class="collab-help">
          {{
            scope === "delegation"
              ? "打开待办，选择有权限的同事接手；已委托的任务可继续查看进度。"
              : "打开申请，查看内容与处理进度。"
          }}
        </p>
      </div>
      <button class="button" :disabled="busy" @click="load">刷新列表</button
      ><button
        v-if="applicationId && session.user?.role === 'admin'"
        class="button primary"
        :disabled="busy"
        @click="
          selectedPage = availablePages[0]?.id || '';
          editing = true;
        "
      >
        新建流程
      </button>
    </div>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <p v-if="busy" class="collab-help" role="status">正在读取流程…</p>
    <template v-if="applicationId && session.user?.role === 'admin'"
      ><h3>流程模板</h3>
      <div class="collab-table-wrap">
        <table v-if="templates.length" class="collab-table">
          <thead>
            <tr>
              <th>流程名称</th>
              <th>业务数据 / 节点</th>
              <th>发布状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="template in templates" :key="template.id">
              <td>{{ template.spec.title }}</td>
              <td>
                {{ template.spec.bindings.length }} 份 /
                {{ template.spec.tasks.length }} 个
              </td>
              <td>
                {{ templateStatus(template) }}
              </td>
              <td>
                <div class="process-actions">
                  <button class="text-button" @click="configure(template)">
                    配置流程</button
                  ><button
                    v-if="template.activeVersion && template.enabled"
                    class="text-button"
                    @click="start(template)"
                  >
                    发起流程
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!busy && !templates.length" class="collab-help">
        暂无流程模板。先发布表单，再配置流程。
      </p></template
    >
    <h3 v-if="!scope">
      {{ session.user?.role === "admin" ? "已发起流程" : "我参与的流程" }}
    </h3>
    <div class="collab-table-wrap">
      <table v-if="processes.length" class="collab-table">
        <thead>
          <tr>
            <th>流程名称</th>
            <th>发起人</th>
            <th>发起时间</th>
            <th>当前办理人</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="process in processes" :key="process.id">
            <td>
              <button class="text-button" @click="openProcess(process.id)">
                {{ process.title }}
              </button>
            </td>
            <td>{{ process.createdByName || "—" }}</td>
            <td>
              {{
                new Date(process.createdAt).toLocaleString("zh-CN", {
                  hour12: false,
                })
              }}
            </td>
            <td>{{ process.currentAssigneeNames.join("、") || "—" }}</td>
            <td>
              <span
                :class="[
                  'process-status',
                  process.status === 'completed' ? 'completed' : 'ready',
                ]"
                >{{
                  process.status === "completed" ? "已完成" : "进行中"
                }}</span
              >
            </td>
            <td>
              <button class="text-button" @click="openProcess(process.id)">
                {{ scope === "todo" ? "办理" : "查看详情" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!busy && !processes.length" class="collab-help">
      暂无可查看的流程。
    </p>
  </section>
  <BaseDialog
    :open="editing"
    title="选择要设置流程的表单"
    @close="editing = false"
  >
    <label class="collab-field"
      >表单<select v-model="selectedPage">
        <option v-for="page in availablePages" :key="page.id" :value="page.id">
          {{ page.title }}
        </option>
      </select></label
    >
    <p v-if="!availablePages.length" class="collab-help">请先发布一张表单。</p>
    <template #footer
      ><button class="button" @click="editing = false">取消</button
      ><button
        class="button primary"
        :disabled="!selectedPage"
        @click="configure()"
      >
        配置流程
      </button></template
    >
  </BaseDialog>
  <ProcessStartDialog
    v-if="starting"
    :template-id="starting.id"
    :version="starting.activeVersion"
    @close="starting = undefined"
    @started="
      (id) => {
        starting = undefined;
        openProcess(id);
      }
    "
  />
  <ProcessDetail
    v-if="processId"
    :key="processId"
    :process-id="processId"
    @close="closeProcess"
    @updated="load"
  />
</template>
