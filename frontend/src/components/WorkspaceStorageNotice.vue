<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useWorkspaceStore } from "../stores/workspace";
import AppIcon from "./AppIcon.vue";
const store = useWorkspaceStore(),
  route = useRoute();
const relevant = computed(
  () =>
    !store.storageErrorContext ||
    store.storageErrorContext === `#${route.fullPath}`,
);
</script>
<template>
  <div
    v-if="store.storageError && relevant"
    class="workspace-storage-notice"
    role="status"
  >
    <AppIcon name="warning" />
    <div>
      <strong>{{
        store.storageConflict
          ? `${store.storageChanges?.[0] || "当前内容"}已更新`
          : "保存未完成"
      }}</strong>
      <p>
        {{
          store.storageConflict
            ? "本页修改仍保留，请查看更新后继续。"
            : store.storageError
        }}
      </p>
    </div>
    <button type="button" class="button" @click="store.recoveryOpen = true">
      {{ store.storageConflict ? "查看更新" : "处理保存问题" }}
    </button>
  </div>
</template>
