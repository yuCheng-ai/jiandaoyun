<script setup lang="ts">
import { computed, provide } from "vue";
import { usePlatformSession } from "./stores/platformSession";
import { useNotices } from "./stores/notices";
import { customColorOwnerKey } from "./repositories/customColors";
import AppIcon from "./components/AppIcon.vue";
const feedback = useNotices();
const session = usePlatformSession();
provide(
  customColorOwnerKey,
  computed(() =>
    session.user ? `account:${session.user.id}` : "",
  ),
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
      class="toast-stack global-notices"
      aria-live="polite"
    >
      <div
        v-for="notice in feedback.notices"
        :key="notice.id"
        class="toast"
        :class="notice.type"
      >
        <AppIcon :name="notice.type === 'warning' ? 'warning' : 'success'" />{{
          notice.message
        }}
      </div>
    </div>
  </div>
</template>
