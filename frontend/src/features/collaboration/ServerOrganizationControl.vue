<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { isMultipleOrganization, isDepartmentField, type FormField, type OrganizationIdentity, type OrganizationFieldOptions } from "@platform/contracts";
import ServerIdentitySelect from "../../components/organization/ServerIdentitySelect.vue";
import { platformApi } from "../../repositories/platformApi";
const props = defineProps<{ field: FormField; modelValue: unknown; disabled?: boolean; label: string; identities?: OrganizationIdentity[]; request?: { path: string; body: Record<string, unknown> } }>();
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>();
const options = ref<OrganizationIdentity[]>([]), known = ref<OrganizationIdentity[]>([]), loading = ref(false), error = ref('');
let sequence = 0;
const labels = computed(() => [...(props.identities || []), ...known.value]);
async function load() {
  if (!props.request || props.disabled) return;
  const current = ++sequence; loading.value = true; error.value = '';
  try {
    const result = await platformApi<OrganizationFieldOptions>(props.request.path, 'POST', props.request.body);
    if (current !== sequence) return;
    options.value = result.options; known.value = [...known.value.filter(item => !result.options.some(option => option.id === item.id)), ...result.options];
    if (props.modelValue === undefined) emit('update:modelValue', result.defaultValue);
  } catch (cause) { if (current === sequence) { error.value = (cause as Error).message; options.value = []; } }
  finally { if (current === sequence) loading.value = false; }
}
watch(() => JSON.stringify([props.request, props.disabled]), () => { sequence++; options.value = []; if (!props.disabled) void load(); }, { immediate: true });
onBeforeUnmount(() => { sequence++; });
</script>
<template>
  <ServerIdentitySelect :model-value="modelValue" :options="request ? options : (identities || []).filter(item => item.kind === (isDepartmentField(field.type) ? 'department' : 'member'))" :known="labels" :multiple="isMultipleOrganization(field.type)" :disabled="disabled" :label="label" :loading="loading" :error="error" @open="load" @retry="load" @update:model-value="emit('update:modelValue', $event)" />
</template>
