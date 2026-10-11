<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "../AppIcon.vue";
import OrganizationPicker from "./OrganizationPicker.vue";
import { useRuntimeData } from "../../composables/useRuntimeData";
import { identityLabel, type SelectionScope } from "../../domain/organization";
import type { FormValues } from "../../domain/form";
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue?: unknown;
    kind?: "member" | "department" | "mixed";
    multiple?: boolean;
    disabled?: boolean;
    label?: string;
    placeholder?: string;
    scope?: SelectionScope;
    values?: FormValues;
    allowRoles?: boolean;
  }>(),
  {
    kind: "member",
    multiple: false,
    disabled: false,
    allowRoles: true,
    label: "选择成员",
  },
);
const emit = defineEmits<{ "update:modelValue": [value: string | string[]] }>();
const runtime = useRuntimeData();
const open = ref(false);
const ids = computed(() =>
  Array.isArray(props.modelValue)
    ? props.modelValue.map(String)
    : props.modelValue
      ? [String(props.modelValue)]
      : [],
);
function update(selected: string[]) {
  emit("update:modelValue", props.multiple ? selected : selected[0] || "");
}
</script>
<template>
  <div v-bind="$attrs" class="identity-input" :class="{ disabled }">
    <button
      type="button"
      class="identity-open"
      :disabled="disabled"
      :aria-label="label"
      @click="open = true"
    >
      <AppIcon :name="kind === 'department' ? 'department' : 'approval'" /><span
        v-if="ids.length"
        class="identity-input-label"
        >{{
          ids.map((id) => identityLabel(runtime.organization, id)).join("、")
        }}</span
      ><span v-else class="muted">{{
        placeholder || (kind === "department" ? "选择部门" : "选择成员")
      }}</span
      ><AppIcon name="down" :size="13" /></button
    ><button
      v-if="ids.length && !disabled"
      type="button"
      class="identity-clear"
      :aria-label="`清空${label}`"
      @click="update([])"
    >
      <AppIcon name="close" :size="13" />
    </button>
  </div>
  <OrganizationPicker
    :open="open"
    :model-value="ids"
    :kind="kind"
    :multiple="multiple"
    :scope="scope"
    :values="values"
    :allow-roles="allowRoles"
    :title="label"
    @update:model-value="update"
    @close="open = false"
  />
</template>
