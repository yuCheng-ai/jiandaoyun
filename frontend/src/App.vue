<script setup lang="ts">
import { computed, provide } from "vue";
import { usePlatformSession } from "./stores/platformSession";
import { customColorOwnerKey } from "./repositories/customColors";
import AppFeedback from "./components/shared/AppFeedback.vue";
const session = usePlatformSession();
provide(
  customColorOwnerKey,
  computed(() => (session.user ? `account:${session.user.id}` : "")),
);
</script>
<template>
  <div class="workspace-frame">
    <div class="workspace-content">
      <RouterView v-slot="{ Component, route }"
        ><component :is="Component" :key="route.fullPath"
      /></RouterView>
    </div>
    <AppFeedback />
  </div>
</template>
