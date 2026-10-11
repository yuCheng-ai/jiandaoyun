<script setup lang="ts">
import {
  subformPermissions,
  subformPermissionLabels,
  type SubformPermissions,
} from "@platform/contracts";
const props = defineProps<{
  modelValue?: SubformPermissions;
  disabled?: boolean;
  label?: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: SubformPermissions];
}>();
function change(key: keyof SubformPermissions, event: Event) {
  emit("update:modelValue", {
    ...subformPermissions(props.modelValue),
    [key]: (event.target as HTMLInputElement).checked,
  });
}
</script>
<template>
  <div
    class="subform-permission-options"
    role="group"
    :aria-label="label || '子表单操作权限'"
  >
    <label
      v-for="(name, key) in subformPermissionLabels"
      :key="key"
      class="checkbox-line"
    >
      <input
        type="checkbox"
        :checked="subformPermissions(modelValue)[key]"
        :disabled="disabled"
        @change="change(key, $event)"
      />{{ name }}
    </label>
  </div>
</template>
<style scoped>
.subform-permission-options {
  padding-left: 16px;
}
.subform-permission-options .checkbox-line {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  margin: 0;
  font-size: 13px;
  font-weight: 400;
}
</style>
