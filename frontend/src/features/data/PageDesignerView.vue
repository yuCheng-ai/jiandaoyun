<script setup lang="ts">
import { onMounted } from "vue";
import { useRoute } from "vue-router";
import { usePageDesignerStore } from "../../stores/pageDesigner";
import { usePlatformSession } from "../../stores/platformSession";
import DesignerHeader from "../../components/shared/DesignerHeader.vue";
import PageEditor from "./PageEditor.vue";
import "../collaboration/collaboration.css";
const route = useRoute();
const store = usePageDesignerStore();
const session = usePlatformSession();
const pageId = String(route.params.pageId);
const pageTitle = store.data?.draft.id === pageId ? store.state.title : "表单";

function load() {
  // 路由守卫已恢复登录态，RouterView 切换页面时会重新挂载，直接读取本页即可。
  if (session.user?.role === "admin") return store.load(pageId);
}
onMounted(load);
</script>
<template>
  <PageEditor
    v-if="
      session.user?.role === 'admin' &&
      store.data &&
      store.data.draft.id === route.params.pageId
    "
    :key="`${store.data.draft.id}-${store.data.draft.latestVersion}-${store.editorEpoch}`"
  />
  <div v-else class="application form-designer server-page-designer">
    <DesignerHeader
      :title="pageTitle"
      :app-id="String(route.params.applicationId)"
      :form-id="pageId"
      active="design"
      readonly-title
    />
    <main class="form-designer-shell" :aria-busy="store.busy">
      <div class="form-editor-toolbar" aria-hidden="true" />
      <div class="form-editor-body page-designer-status">
        <p v-if="store.busy" role="status">正在读取表单…</p>
        <p v-else-if="store.error" role="alert" class="collab-error">
          {{ store.error }} <button class="button" @click="load">重试</button>
        </p>
        <p v-else-if="session.user?.role !== 'admin'">
          当前账号不能设计表单，请返回应用填写表单或处理待办。
        </p>
      </div>
    </main>
  </div>
</template>
<style scoped>
.page-designer-status {
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--muted);
  background: var(--canvas);
}
</style>
