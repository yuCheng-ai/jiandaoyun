<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { isDepartmentField, isMultipleOrganization, type FormField, type OrganizationFieldConfig, type SelectionScope, type ServerOrganization } from "@platform/contracts";
import ServerIdentitySelect from "../../components/organization/ServerIdentitySelect.vue";
import { platformApi } from "../../repositories/platformApi";
const props = defineProps<{ field: FormField; fields: FormField[]; disabled?: boolean; parentId?: string }>();
const emit = defineEmits<{ update: [value: Partial<FormField>] }>();
const organization = ref<ServerOrganization>(), loading = ref(false), error = ref('');
async function load() { loading.value = true; error.value = ''; try { organization.value = await platformApi<ServerOrganization>('/organization'); } catch (cause) { error.value = (cause as Error).message; } finally { loading.value = false; } }
onMounted(load);
const config = computed(() => props.field.organization), department = computed(() => isDepartmentField(props.field.type));
const departments = computed(() => organization.value?.spec.departments.map(item => ({ ...item, active: !item.archived })) || []);
const members = computed(() => organization.value?.users || []);
const roles = computed(() => organization.value?.spec.roles.map(item => ({ ...item, active: !item.archived })) || []);
const dependencies = computed(() => [...props.fields, ...(props.fields.find(field => field.id === props.parentId)?.children || [])].filter(field => isDepartmentField(field.type) && field.id !== props.field.id));
function patch(value: Partial<OrganizationFieldConfig>) { emit('update', { organization: { ...config.value, ...value } }); }
function scope(value: Partial<SelectionScope>) { patch({ scope: { ...config.value.scope, ...value } }); }
const array = (value: string | string[]) => Array.isArray(value) ? value : value ? [value] : [];
</script>
<template>
  <div class="server-organization-rules">
    <p v-if="error" class="collab-error" role="alert">{{ error }}<button class="text-button" @click="load">重试</button></p>
    <label>选择范围<select :value="config.scope.mode" :aria-label="`${field.label}选择范围`" :disabled="disabled" @change="scope({ mode: ($event.target as HTMLSelectElement).value as SelectionScope['mode'] })"><option value="all">全部{{ department ? '部门' : '成员' }}</option><option value="custom">指定范围</option><option value="currentDepartment">当前成员所在部门</option><option value="fieldDepartment">由部门字段决定</option></select></label>
    <template v-if="config.scope.mode === 'custom'">
      <label>指定部门<ServerIdentitySelect :model-value="config.scope.departmentIds" :options="departments" :known="departments" multiple :disabled="disabled" :loading="loading" :error="error" label="选择范围内的部门" @update:model-value="scope({ departmentIds: array($event) })" @retry="load" /></label>
      <template v-if="!department"><label>指定成员<ServerIdentitySelect :model-value="config.scope.employeeIds" :options="members" :known="members" multiple :disabled="disabled" :loading="loading" :error="error" label="选择范围内的成员" @update:model-value="scope({ employeeIds: array($event) })" @retry="load" /></label><label>指定角色<ServerIdentitySelect :model-value="config.scope.roleIds" :options="roles" :known="roles" multiple :disabled="disabled" :loading="loading" :error="error" label="选择范围内的角色" @update:model-value="scope({ roleIds: array($event) })" @retry="load" /></label><p class="field-hint">部门、成员和角色范围取并集。</p></template>
    </template>
    <label v-if="config.scope.mode === 'fieldDepartment'">依赖部门<select :value="config.scope.fieldId" :aria-label="`${field.label}依赖部门字段`" :disabled="disabled" @change="scope({ fieldId: ($event.target as HTMLSelectElement).value })"><option value="">选择部门字段</option><option v-for="item in dependencies" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
    <label v-if="config.scope.mode !== 'all'"><input type="checkbox" :checked="config.scope.includeChildren" :disabled="disabled" @change="scope({ includeChildren: ($event.target as HTMLInputElement).checked })" />包含下级部门</label>
    <label>默认方式<select :value="config.defaultMode" :aria-label="`${field.label}默认方式`" :disabled="disabled" @change="patch({ defaultMode: ($event.target as HTMLSelectElement).value as OrganizationFieldConfig['defaultMode'], defaultIds: [] })"><option value="none">指定身份 / 无</option><option v-if="!department" value="currentUser">当前成员</option><option v-if="department" value="currentDepartment">当前成员主部门</option><option v-if="!department" value="departmentManager">当前成员主部门负责人</option></select></label>
    <ServerIdentitySelect v-if="config.defaultMode === 'none'" :model-value="config.defaultIds" :options="department ? departments : members" :known="department ? departments : members" :multiple="isMultipleOrganization(field.type)" :disabled="disabled" :loading="loading" :error="error" :label="`${field.label}默认身份`" @update:model-value="patch({ defaultIds: array($event) })" @retry="load" />
    <p class="field-hint">默认值由登录成员和当前组织计算，并受选择范围限制。已有记录保留原身份。</p>
  </div>
</template>
<style scoped>
.server-organization-rules > label { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; font-size: 12px; }
.server-organization-rules input[type=checkbox] { width: auto; align-self: flex-start; }
.server-organization-rules select { min-width: 0; width: 100%; }
</style>
