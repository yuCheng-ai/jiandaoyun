<script setup lang="ts">
import { computed, onMounted, provide, ref } from "vue";
import type { FormSchema, ServerOrganization } from "@platform/contracts";
import FormPreview from "../forms/components/FormPreview.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { runtimeDataKey } from "../../composables/useRuntimeData";
import { emptyWorkspace } from "../../domain/workspace";
import { usePlatformSession } from "../../stores/platformSession";
import { platformApi } from "../../repositories/platformApi";
defineProps<{ schema: FormSchema; formId: string; title: string }>();
const emit = defineEmits<{ close: [] }>();
const session = usePlatformSession(), directory = ref<ServerOrganization>(), error = ref('');
async function load() { error.value = ''; try { directory.value = await platformApi<ServerOrganization>('/organization'); } catch (cause) { error.value = (cause as Error).message; } }
onMounted(load);
provide(runtimeDataKey, computed(() => {
  const source = directory.value;
  return { ...emptyWorkspace(), organization: {
    version: 1 as const, name: '组织与成员', currentUserId: session.user?.id || '',
    departments: (source?.spec.departments || []).map(item => ({ ...item, managerIds: item.managerIds || [] })),
    roleGroups: source?.spec.roleGroups || [], roles: (source?.spec.roles || []).map(item => ({ ...item, grants: [] })),
    employees: (source?.users || []).map(user => {
      const assignment = source?.spec.assignments.find(item => item.userId === user.id);
      return { id: user.id, name: user.name, number: user.username, status: user.active ? 'active' as const : 'inactive' as const, departmentIds: assignment?.departmentIds || [], primaryDepartmentId: assignment?.primaryDepartmentId || '', email: '', phone: '', position: '', joinedAt: '' };
    }),
  } };
}));
</script>
<template>
  <FormPreview v-if="directory" :schema="schema" :form-id="formId" :title="title" @close="emit('close')" />
  <BaseDialog v-else :open="true" title="准备表单预览" width="460px" @close="emit('close')"><p v-if="error" role="alert">{{ error }}<button class="text-button" @click="load">重试</button></p><p v-else role="status">正在读取当前组织…</p></BaseDialog>
</template>
