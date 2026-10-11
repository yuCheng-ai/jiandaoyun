<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "../AppIcon.vue";
import UserMenu from "./UserMenu.vue";
const props = defineProps<{
  title: string;
  appId: string;
  formId: string;
  active?: string;
  workflow?: boolean;
}>();
const emit = defineEmits<{ "update:title": [value: string]; help: [] }>();
const router = useRouter();
const route = useRoute();
const tabs = computed(() => [
  { id: "design", label: "表单设计" },
  { id: "flow", label: "流程设定" },
  { id: "extensions", label: "扩展功能" },
  { id: "publish", label: "表单发布" },
  { id: "data", label: "数据管理" },
]);
function go(id: string) {
  router.push(`/apps/${props.appId}/forms/${props.formId}/${id}`);
}
</script>
<template>
  <header class="app-header">
    <div class="document-identity">
      <button
        class="icon-button back-button"
        aria-label="返回应用首页"
        @click="router.push({ path: `/apps/${appId}`, query: { form: formId } })"
      >
        <AppIcon name="back" :size="23" /></button
      ><input
        class="document-title"
        :value="title"
        maxlength="60"
        aria-label="表单名称"
        @input="emit('update:title', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <nav class="main-navigation" aria-label="表单设计导航">
      <template v-for="tab in tabs" :key="tab.id"
        ><span v-if="tab.id === 'data'" class="nav-divider" /><button
          :class="{ active: active === tab.id }"
          :aria-current="active === tab.id ? 'page' : undefined"
          @click="go(tab.id)"
        >
          {{ tab.label }}
        </button></template
      >
    </nav>
    <select
      class="mobile-designer-navigation"
      aria-label="切换设计模块"
      :value="active"
      @change="go(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="tab in tabs" :key="tab.id" :value="tab.id">
        {{ tab.label }}
      </option>
    </select>
    <div class="header-utilities">
      <button class="icon-button" aria-label="帮助" @click="emit('help')">
        <AppIcon name="help" :size="20" /></button
      ><UserMenu />
    </div>
  </header>
</template>
