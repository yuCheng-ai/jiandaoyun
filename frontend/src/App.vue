<script setup lang="ts">
import { computed, provide } from "vue";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { usePlatformSession } from "./stores/platformSession";
import { customColorOwnerKey } from "./repositories/customColors";
import AppFeedback from "./components/shared/AppFeedback.vue";
const session = usePlatformSession();
function pageKey(route: RouteLocationNormalizedLoaded) {
  // 栏目、筛选和详情参数只更新页内内容；切换账号或业务页面才重建。
  // 流程模板是独立的编辑对象，不能沿用另一份模板的未保存状态。
  const templateId =
    route.name === "page-workflow" ? route.query.templateId : undefined;
  return JSON.stringify([
    session.user?.id,
    session.user?.role,
    route.path,
    templateId,
  ]);
}
provide(
  customColorOwnerKey,
  computed(() => (session.user ? `account:${session.user.id}` : "")),
);
</script>
<template>
  <div class="workspace-frame">
    <div class="workspace-content">
      <RouterView v-slot="{ Component, route }"
        ><component :is="Component" :key="pageKey(route)"
      /></RouterView>
    </div>
    <AppFeedback />
  </div>
</template>
