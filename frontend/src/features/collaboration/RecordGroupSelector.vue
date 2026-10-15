<script setup lang="ts">
import type { RecordGroupOptions } from "@platform/contracts";
import {
  accessGroupSelections,
  chooseAccessGroup,
} from "../../repositories/accessGroupSelection";
const props = defineProps<{
  definitionId: string;
  options?: RecordGroupOptions;
  busy?: boolean;
}>();
const emit = defineEmits<{ change: [] }>();
function select(event: Event) {
  chooseAccessGroup(
    props.definitionId,
    (event.target as HTMLSelectElement).value,
  );
  emit("change");
}
</script>
<template>
  <div
    v-if="options && !options.administrator && options.groups.length > 1"
    class="record-group-choice"
  >
    <label class="collab-field"
      >使用权限组<select
        :value="accessGroupSelections[definitionId] || ''"
        :disabled="busy"
        @change="select"
      >
        <option value="">请选择权限组</option>
        <option
          v-for="group in options.groups"
          :key="group.id"
          :value="group.id"
        >
          {{ group.name }}
        </option>
        <option
          v-if="options.allowMerged && options.groups.length > 1"
          value="*"
        >
          全部有权限的数据
        </option>
      </select></label
    >
  </div>
</template>
