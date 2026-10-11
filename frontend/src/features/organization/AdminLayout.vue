<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "../../components/AppIcon.vue";
import IdentityInput from "../../components/organization/IdentityInput.vue";
import { useWorkspaceStore } from "../../stores/workspace";
const props = defineProps<{ active: string }>();
const router = useRouter();
const store = useWorkspaceStore();
const current = computed({
  get: () => store.data.organization.currentUserId,
  set: async (id: string) => {
    if (id && (await store.setCurrentUser(id)))
      store.notify("当前体验成员已切换");
  },
});
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
      <span class="admin-context-label">当前体验成员</span
      ><IdentityInput v-model="current" label="切换当前体验成员" />
    </header>
    <div class="admin-body">
      <nav class="admin-navigation" aria-label="管理后台导航">
        <small>通讯录</small
        ><button
          :class="{ active: active === 'organization' || active === 'roles' }"
          @click="router.push('/admin/organization')"
        >
          <AppIcon name="department" />内部组织</button
        ><button
          :class="{ active: active === 'members' }"
          @click="router.push('/admin/members')"
        >
          <AppIcon name="people" />成员信息管理</button
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
            <AppIcon name="home" />返回工作台</button
          ><span>本地工作空间</span>
        </div>
      </nav>
      <main class="admin-content"><slot /></main>
    </div>
  </div>
</template>
