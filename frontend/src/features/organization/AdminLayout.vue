<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "../../components/AppIcon.vue";
import UserMenu from "../../components/shared/UserMenu.vue";
import { usePlatformSession } from "../../stores/platformSession";
import { useWorkspaceStore } from "../../stores/workspace";
const props = defineProps<{ active: string }>();
const workspace = useWorkspaceStore();
const directoryPage = computed(() =>
  ["organization", "roles", "permissions"].includes(props.active),
);
onMounted(() => {
  if (directoryPage.value) void workspace.loadDirectory();
});
const router = useRouter();
const session = usePlatformSession();
const busy = ref(false),
  error = ref("");
async function logout() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await session.logout();
    await router.replace("/");
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="admin-layout">
    <header class="admin-header">
      <button
        class="icon-button"
        aria-label="返回工作台"
        @click="router.push('/')"
      >
        <AppIcon name="back" :size="23" /></button
      ><AppIcon name="settings" :size="23" class="teal-icon" /><strong
        >管理后台</strong
      >
      <div class="toolbar-spacer" />
      <span v-if="error" class="field-error" role="alert">{{ error }}</span>
      <UserMenu
        v-if="session.user"
        :account="session.user"
        :busy="busy"
        @organization="router.push('/admin/organization')"
        @logout="logout"
      />
    </header>
    <div class="admin-body">
      <nav class="admin-navigation" aria-label="管理后台导航">
        <small>通讯录</small
        ><button
          :class="{ active: active === 'organization' || active === 'roles' }"
          @click="router.push('/admin/organization')"
        >
          <AppIcon name="department" />内部组织</button
        ><small>权限中心</small
        ><button
          :class="{ active: active === 'permissions' }"
          @click="router.push('/admin/permissions')"
        >
          <AppIcon name="success" />权限查询
        </button>
        <small>业务服务</small
        ><button
          :class="{ active: active === 'payments' }"
          @click="router.push('/admin/payments')"
        >
          <AppIcon name="database" />支付管理
        </button>
        <div class="admin-navigation-footer">
          <button @click="router.push('/')">
            <AppIcon name="home" />返回工作台
          </button>
        </div>
      </nav>
      <main class="admin-content">
        <div
          v-if="directoryPage && !workspace.directoryReady"
          class="workspace-empty"
        >
          <p v-if="workspace.directoryLoading" role="status">正在读取通讯录…</p>
          <template v-else
            ><p role="alert">{{ workspace.directoryError }}</p>
            <button class="button" @click="workspace.loadDirectory()">
              重新读取通讯录
            </button></template
          >
        </div>
        <slot v-else />
      </main>
    </div>
  </div>
</template>
