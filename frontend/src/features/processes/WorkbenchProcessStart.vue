<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type {
  ApplicationSummary,
  ProcessTemplateDraft,
} from "@platform/contracts";
import { usePlatformSession } from "../../stores/platformSession";
import { platformApi } from "../../repositories/platformApi";
import ProcessStartDialog from "./ProcessStartDialog.vue";
import ProcessDetail from "./ProcessDetail.vue";
const props = defineProps<{ applications: ApplicationSummary[] }>();
const session = usePlatformSession(),
  router = useRouter();
const templates = ref<(ProcessTemplateDraft & { applicationTitle: string })[]>(
  [],
);
const busy = ref(false),
  error = ref(""),
  starting = ref<ProcessTemplateDraft>(),
  processId = ref("");
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    templates.value = (
      await Promise.all(
        props.applications.map(async (app) =>
          (
            await platformApi<ProcessTemplateDraft[]>(
              `/process-templates?applicationId=${app.id}`,
            )
          )
            .filter((item) => item.latestVersion && item.enabled)
            .map((item) => ({ ...item, applicationTitle: app.title })),
        ),
      )
    ).flat();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
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
onMounted(load);
</script>
<template>
  <section class="panel-card apps-panel">
    <header class="section-heading">
      <h2>发起流程</h2>
      <button class="button" :disabled="busy" @click="load">刷新</button>
    </header>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status">正在读取…</p>
    <div class="process-start-list">
      <button
        v-for="template in templates"
        :key="template.id"
        @click="start(template)"
      >
        <strong>{{ template.spec.title }}</strong
        ><span>{{ template.applicationTitle }}</span>
      </button>
    </div>
    <p v-if="!busy && !error && !templates.length" class="workspace-empty">
      {{
        session.user?.role === "admin"
          ? "暂无已发布的流程。"
          : "当前账号尚无可发起的流程。"
      }}
    </p>
  </section>
  <ProcessStartDialog
    v-if="starting"
    :template-id="starting.id"
    :version="starting.latestVersion"
    @close="starting = undefined"
    @started="
      (id) => {
        starting = undefined;
        processId = id;
      }
    "
  />
  <ProcessDetail
    v-if="processId"
    :process-id="processId"
    @close="processId = ''"
  />
</template>
<style scoped>
.process-start-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}
.process-start-list button {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  text-align: left;
  border: 1px solid #e4e7ee;
  border-radius: 6px;
}
.process-start-list button:hover {
  border-color: #00aea4;
  background: #f6fbfa;
}
.process-start-list span {
  color: #8c96a6;
  font-size: 12px;
}
</style>
