<script setup lang="ts">
import { computed, provide, watch } from "vue";
import { useRoute } from "vue-router";
import { useWorkspaceStore } from "./stores/workspace";
import { usePlatformSession } from "./stores/platformSession";
import { customColorOwnerKey } from "./repositories/customColors";
import AppIcon from "./components/AppIcon.vue";
import WorkspaceStorageNotice from "./components/WorkspaceStorageNotice.vue";
import WorkspaceRecovery from "./features/workspace/WorkspaceRecovery.vue";
const store = useWorkspaceStore();
const route = useRoute();
const session = usePlatformSession();
const localWorkspaceRoute = computed(
  () => route.path.startsWith("/apps/") || route.path.startsWith("/admin/"),
);
provide(
  customColorOwnerKey,
  computed(() =>
    route.path === "/" || route.path.startsWith("/applications")
      ? session.user
        ? `account:${session.user.id}`
        : ""
      : store.data.organization.currentUserId
        ? `local:${store.data.organization.currentUserId}`
        : "",
  ),
);
watch(
  () => route.fullPath,
  () => {
    if (localWorkspaceRoute.value) store.refreshForRead?.();
  },
  { immediate: true, flush: "sync" },
);
</script>
<template>
  <div class="workspace-frame">
    <div class="workspace-content">
      <RouterView v-slot="{ Component, route }"
        ><component :is="Component" :key="route.fullPath"
      /></RouterView>
    </div>
    <div
      v-if="localWorkspaceRoute"
      class="toast-stack global-notices"
      aria-live="polite"
    >
      <div
        v-for="notice in store.notices"
        :key="notice.id"
        class="toast"
        :class="notice.type"
      >
        <AppIcon :name="notice.type === 'warning' ? 'warning' : 'success'" />{{
          notice.message
        }}
      </div>
    </div>
    <WorkspaceStorageNotice
      v-if="localWorkspaceRoute"
      class="global-storage-notice"
    />
    <WorkspaceRecovery v-if="localWorkspaceRoute" />
  </div>
</template>
