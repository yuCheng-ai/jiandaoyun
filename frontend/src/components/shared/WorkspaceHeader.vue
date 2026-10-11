<script setup lang="ts">
import AppIcon from "../AppIcon.vue";
import UserMenu from "./UserMenu.vue";
import type { SessionUser } from "@platform/contracts";
defineProps<{ title?: string; account: SessionUser; busy?: boolean }>();
const emit = defineEmits<{
  home: [];
  directory: [];
  logout: [];
}>();
</script>
<template>
  <header class="workspace-header">
    <div class="workspace-brand">
      <button
        class="app-launcher"
        aria-label="返回工作台"
        @click="emit('home')"
      >
        <AppIcon name="apps" :size="23" /></button
      ><AppIcon name="cloud" :size="27" class="brand-cloud" /><button
        @click="emit('home')"
      >
        {{ title || "工作台" }}
      </button>
    </div>
    <div class="workspace-header-links">
      <button v-if="account.role === 'admin'" @click="emit('directory')">
        <AppIcon name="people" />组织与成员
      </button>
      <UserMenu
        :account="account"
        :busy="busy"
        @organization="emit('directory')"
        @logout="emit('logout')"
      />
    </div>
  </header>
</template>
