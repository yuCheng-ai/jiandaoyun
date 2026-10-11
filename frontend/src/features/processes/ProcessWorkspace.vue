<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type {
  DefinitionSummary,
  PageSummary,
  ProcessTemplateDraft,
} from "@platform/contracts";
import { usePlatformSession } from "../../stores/platformSession";
import { platformApi } from "../../repositories/platformApi";
import ProcessTemplateEditor from "./ProcessTemplateEditor.vue";
import ProcessStartDialog from "./ProcessStartDialog.vue";
import ProcessDetail from "./ProcessDetail.vue";
import "./processes.css";
const props = defineProps<{
  applicationId?: string;
  objects?: DefinitionSummary[];
  pages?: PageSummary[];
  scope?: "todo" | "started" | "handled";
}>();
const session = usePlatformSession(),
  templates = ref<ProcessTemplateDraft[]>([]),
  processes = ref<
    { id: string; title: string; status: string; templateVersion?: number }[]
  >([]);
const busy = ref(false),
  error = ref(""),
  editing = ref(false),
  selected = ref<ProcessTemplateDraft>(),
  starting = ref<ProcessTemplateDraft>(),
  processId = ref("");
const heading = computed(() =>
  props.scope
    ? { todo: "我的待办", started: "我发起的", handled: "我处理的" }[
        props.scope
      ]
    : "流程",
);
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
            applicationId && session.user?.role === "admin"
              ? "配置处理人、表单和办理顺序，按已发布版本发起。"
              : "打开流程中的任务，按权限处理关联表单。"
          }}
        </p>
      </div>
      <button class="button" :disabled="busy" @click="load">刷新列表</button
      ><button
        v-if="applicationId && session.user?.role === 'admin'"
        class="button primary"
        :disabled="busy"
        @click="
          selected = undefined;
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
                {{
                  template.latestVersion
                    ? `已发布 V${template.latestVersion}${template.hasDraftChanges ? " · 有未发布修改" : ""}`
                    : "草稿"
                }}
              </td>
              <td>
                <div class="process-actions">
                  <button
                    class="text-button"
                    @click="
                      selected = template;
                      editing = true;
                    "
                  >
                    配置流程</button
                  ><button
                    v-if="template.latestVersion"
                    class="text-button"
                    @click="starting = template"
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
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="process in processes" :key="process.id">
            <td>
              {{ process.title
              }}<small v-if="process.templateVersion" class="process-subtitle"
                >V{{ process.templateVersion }}</small
              >
            </td>
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
              <button class="text-button" @click="processId = process.id">
                查看任务
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
  <ProcessTemplateEditor
    v-if="editing && applicationId"
    :application-id="applicationId"
    :objects="objects || []"
    :pages="pages || []"
    :template="selected"
    @close="
      editing = false;
      load();
    "
    @saved="
      editing = false;
      load();
    "
  />
  <ProcessStartDialog
    v-if="starting"
    :template-id="starting.id"
    :version="starting.latestVersion"
    @close="starting = undefined"
    @started="
      (id) => {
        starting = undefined;
        processId = id;
        load();
      }
    "
  />
  <ProcessDetail
    v-if="processId"
    :key="processId"
    :process-id="processId"
    @close="processId = ''"
    @updated="load"
  />
</template>
