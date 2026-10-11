<script setup lang="ts">
import { useRouter } from "vue-router";
import AppIcon from "../AppIcon.vue";
import UserMenu from "./UserMenu.vue";
const router = useRouter();
defineProps<{ title?: string }>();
const emit = defineEmits<{ templates: []; directory: []; notifications: [] }>();
</script>
<template>
  <header class="workspace-header">
    <div class="workspace-brand">
      <button
        class="app-launcher"
        aria-label="返回工作台"
        @click="router.push('/')"
      >
        <AppIcon name="apps" :size="23" /></button
      ><AppIcon name="cloud" :size="27" class="brand-cloud" /><button
        @click="router.push('/')"
      >
        {{ title || "工作台" }}
      </button>
    </div>
    <div class="workspace-header-links">
      <button @click="emit('templates')"><AppIcon name="grid" />模板中心</button
      ><button @click="emit('directory')">
        <AppIcon name="people" />通讯录</button
      ><span class="nav-divider" /><button
        class="icon-button"
        aria-label="通知"
        @click="emit('notifications')"
      >
        <AppIcon name="bell" :size="18" /></button
      ><UserMenu />
    </div>
  </header>
</template>
