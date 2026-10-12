<script setup lang="ts">
import { computed, onMounted, provide, ref } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "../../components/AppIcon.vue";
import UserMenu from "../../components/shared/UserMenu.vue";
import { usePlatformSession } from "../../stores/platformSession";
import { useOrganizationStore } from "../../stores/organization";
import { runtimeDataKey } from "../../composables/useRuntimeData";
import { emptyWorkspace } from "../../domain/workspace";
const props = defineProps<{ active: string }>();
const directory = useOrganizationStore();
provide(
  runtimeDataKey,
  computed(() => ({
    ...emptyWorkspace(),
    organization: directory.organization,
  })),
);
const directoryPage = computed(() =>
  ["organization", "roles", "permissions"].includes(props.active),
);
onMounted(() => {
  if (directoryPage.value) void directory.load();
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
        <div class="admin-navigation-footer">
          <button @click="router.push('/')">
            <AppIcon name="home" />返回工作台
          </button>
        </div>
      </nav>
      <main class="admin-content">
        <div v-if="directoryPage && !directory.ready" class="workspace-empty">
          <p v-if="directory.loading" role="status">正在读取通讯录…</p>
          <template v-else
            ><p role="alert">{{ directory.error }}</p>
            <button class="button" @click="directory.load()">
              重新读取通讯录
            </button></template
          >
        </div>
        <template v-else>
          <p
            v-if="directoryPage && directory.error"
            class="field-error"
            role="alert"
          >
            {{ directory.error }}
            <button class="text-button" @click="directory.load()">
              重新读取
            </button>
          </p>
          <slot />
        </template>
      </main>
    </div>
  </div>
</template>
