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
const session = usePlatformSession();
const directory = ref<ServerOrganization>();
const error = ref("");

async function load() {
  error.value = "";
  try {
    directory.value = await platformApi<ServerOrganization>("/organization");
  } catch (cause) {
    error.value = (cause as Error).message;
  }
}

onMounted(load);

// 预览只使用当前账号可读的组织信息，不读取浏览器里的旧业务数据。
const runtime = computed(() => {
  const source = directory.value;
  const workspace = emptyWorkspace();
  workspace.organization.currentUserId = session.user?.id || "";
  if (!source) return workspace;

  workspace.organization.departments = source.spec.departments.map((department) => ({
    ...department,
    managerIds: department.managerIds || [],
  }));
  workspace.organization.roleGroups = source.spec.roleGroups || [];
  workspace.organization.roles = source.spec.roles.map((role) => ({
    ...role,
    grants: [],
  }));
  workspace.organization.employees = source.users.map((user) => {
    const assignment = source.spec.assignments.find((item) => item.userId === user.id);
    return {
      id: user.id,
      name: user.name,
      number: user.username,
      status: user.active ? "active" : "inactive",
      departmentIds: assignment?.departmentIds || [],
      primaryDepartmentId: assignment?.primaryDepartmentId || "",
      email: "",
      phone: "",
      position: "",
      joinedAt: "",
    };
  });
  return workspace;
});

provide(runtimeDataKey, runtime);
</script>
<template>
  <FormPreview
    v-if="directory"
    :schema="schema"
    :form-id="formId"
    :title="title"
    @close="emit('close')"
  />
  <BaseDialog
    v-else
    :open="true"
    title="准备表单预览"
    width="460px"
    @close="emit('close')"
  >
    <p v-if="error" role="alert">
      {{ error }}
      <button class="text-button" @click="load">重试</button>
    </p>
    <p v-else role="status">正在读取当前组织…</p>
  </BaseDialog>
</template>
