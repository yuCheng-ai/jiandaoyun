<script setup lang="ts">
import { computed } from "vue";
import {
  choiceSettingsErrors,
  isMultipleChoice,
  type FormField,
} from "@platform/contracts";
const props = defineProps<{
  field: FormField;
  section?: "layout" | "validation";
}>();
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const limit = computed(() => props.field.selectionLimit || { enabled: false });
const errors = computed(() => choiceSettingsErrors(props.field));
function bound(key: "min" | "max", event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit("update", {
    selectionLimit: {
      ...limit.value,
      [key]: value === "" ? undefined : Number(value),
    },
  });
}
</script>
<template>
  <div
    v-if="
      section !== 'validation' && ['radio', 'checkbox'].includes(field.type)
    "
    class="form-group choice-layout-settings"
  >
    <label>分布方式</label>
    <div class="segmented">
      <button
        v-for="item in [
          { value: 'vertical', label: '纵向排列' },
          { value: 'horizontal', label: '横向排列' },
        ] as const"
        :key="item.value"
        type="button"
        :class="{ active: (field.choiceLayout || 'horizontal') === item.value }"
        :aria-pressed="(field.choiceLayout || 'horizontal') === item.value"
        @click="emit('update', { choiceLayout: item.value })"
      >
        {{ item.label }}
      </button>
    </div>
  </div>
  <template v-if="section !== 'layout' && isMultipleChoice(field.type)">
    <label class="checkbox-line"
      ><input
        type="checkbox"
        :checked="limit.enabled"
        @change="
          emit('update', {
            selectionLimit: {
              ...limit,
              enabled: ($event.target as HTMLInputElement).checked,
            },
          })
        "
      />限制可选项数</label
    >
    <div v-if="limit.enabled" class="inline-range choice-limit-range">
      <input
        type="number"
        min="0"
        step="1"
        :value="limit.min"
        aria-label="最少可选项数"
        placeholder="最少"
        @input="bound('min', $event)"
      /><span>~</span
      ><input
        type="number"
        min="0"
        step="1"
        :value="limit.max"
        aria-label="最多可选项数"
        placeholder="最多"
        @input="bound('max', $event)"
      />
    </div>
    <p v-if="limit.enabled && errors.length" class="field-error" role="alert">
      {{ errors[0] }}
    </p>
  </template>
</template>
<style scoped>
.choice-layout-settings .segmented {
  display: flex;
}
.choice-layout-settings button {
  flex: 1;
}
.choice-limit-range {
  margin-top: 8px;
}
.choice-limit-range input {
  min-width: 0;
}
</style>
