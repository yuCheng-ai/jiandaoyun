<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import { usePageDesignerStore } from "../../stores/pageDesigner";
import { usePlatformSession } from "../../stores/platformSession";
import PageEditor from "./PageEditor.vue";
import PlatformLogin from "../session/PlatformLogin.vue";
import "../collaboration/collaboration.css";
const route = useRoute(),
  store = usePageDesignerStore(),
  session = usePlatformSession();
async function load() {
  try {
    await session.restore();
    if (session.user?.role === "admin")
      await store.load(String(route.params.pageId));
  } catch (cause) {
    store.error = (cause as Error).message;
  }
}
onMounted(load);
watch(() => route.params.pageId, load);
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
  <div v-else class="collab-page">
    <main class="collab-main">
      <RouterLink :to="`/applications/${route.params.applicationId}`"
        >返回应用</RouterLink
      >
      <p v-if="store.busy" role="status">正在读取页面…</p>
      <p v-else-if="store.error" role="alert" class="collab-error">
        {{ store.error }} <button class="button" @click="load">重试</button>
      </p>
      <PlatformLogin
        v-show="!session.user && !store.busy && !store.error"
        @signed-in="load"
      />
      <p v-if="session.user && !store.busy && !store.error">
        当前账号不能设计表单，请返回应用填写表单或处理待办。
      </p>
    </main>
  </div>
</template>
