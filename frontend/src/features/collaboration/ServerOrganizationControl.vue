<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  isMultipleOrganization,
  isDepartmentField,
  type FormField,
  type OrganizationIdentity,
  type OrganizationFieldOptions,
} from "@platform/contracts";
import ServerIdentitySelect from "../../components/organization/ServerIdentitySelect.vue";
import { platformApi } from "../../repositories/platformApi";

const props = defineProps<{
  field: FormField;
  modelValue: unknown;
  disabled?: boolean;
  label: string;
  identities?: OrganizationIdentity[];
  request?: { path: string; body: Record<string, unknown> };
}>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();
const options = ref<OrganizationIdentity[]>([]);
const known = ref<OrganizationIdentity[]>([]);
const loading = ref(false);
const error = ref("");
let sequence = 0;

const labels = computed(() => [...(props.identities || []), ...known.value]);
const availableOptions = computed(() => {
  if (props.request) return options.value;
  const kind = isDepartmentField(props.field.type) ? "department" : "member";
  return (props.identities || []).filter((item) => item.kind === kind);
});

async function load() {
  if (!props.request || props.disabled) return;
  const current = ++sequence;
  loading.value = true;
  error.value = "";
  try {
    const result = await platformApi<OrganizationFieldOptions>(
      props.request.path,
      "POST",
      props.request.body,
    );
    // 条件或权限变化后，不采用旧请求的候选项和默认值。
    if (current !== sequence) return;
    options.value = result.options;
    const receivedIds = new Set(result.options.map((item) => item.id));
    const previousLabels = known.value.filter(
      (item) => !receivedIds.has(item.id),
    );
    known.value = [...previousLabels, ...result.options];
    if (props.modelValue === undefined) {
      emit("update:modelValue", result.defaultValue);
    }
  } catch (cause) {
    if (current !== sequence) return;
    error.value = (cause as Error).message;
    options.value = [];
  } finally {
    if (current === sequence) loading.value = false;
  }
}

watch(
  () => JSON.stringify([props.request, props.disabled]),
  () => {
    sequence++;
    options.value = [];
    loading.value = false;
    error.value = "";
    if (!props.disabled) void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  sequence++;
});
</script>
<template>
  <ServerIdentitySelect
    :model-value="modelValue"
    :options="availableOptions"
    :known="labels"
    :multiple="isMultipleOrganization(field.type)"
    :disabled="disabled"
    :label="label"
    :loading="loading"
    :error="error"
    @open="load"
    @retry="load"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>
