<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../../components/AppIcon.vue";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import { lookupDisplay } from "../../../domain/lookup";
import type { FormField } from "../../../domain/form";
import FileFieldControl from "./FileFieldControl.vue";
const props = defineProps<{
  field: FormField;
  modelValue?: unknown;
  disabled?: boolean;
  design?: boolean;
  readonly?: boolean;
  label: string;
}>();
const emit = defineEmits<{ activate: [] }>();
const data = useRuntimeData();
const display = computed(() =>
  lookupDisplay(props.field, props.modelValue, data.value),
);
</script>
<template>
  <div class="lookup-control">
    <button
      v-if="!readonly || design"
      type="button"
      class="button lookup-button"
      :aria-label="label"
      :disabled="disabled || !field.referenceFormId"
      @click="emit('activate')"
    >
      <AppIcon name="database" :size="16" />{{
        field.buttonText && field.buttonText !== "按钮"
          ? field.buttonText
          : "选择数据"
      }}
    </button>
    <dl v-if="display.length" class="lookup-display">
      <div v-for="item in display" :key="item.id">
        <dt>{{ item.label }}</dt>
        <dd>
          <FileFieldControl
            v-if="!design && item.files?.length"
            :field="item.sourceField"
            :model-value="item.files"
            disabled
          />
          <template v-else>{{
            design ? "暂无内容" : item.text === "—" ? "暂无内容" : item.text
          }}</template>
        </dd>
      </div>
    </dl>
  </div>
</template>
<style scoped>
.lookup-button {
  width: 100%;
  justify-content: center;
}
.lookup-display {
  margin: 8px 0 0;
  padding: 8px 12px;
  border-radius: 4px;
  background: var(--canvas);
  font-size: 13px;
}
.lookup-display > div {
  display: grid;
  grid-template-columns: minmax(70px, 30%) 1fr;
  gap: 12px;
  padding: 5px 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
