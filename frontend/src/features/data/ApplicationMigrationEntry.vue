<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace";
const emit = defineEmits<{ close: [] }>();
const workspace = useWorkspaceStore();
const applications = computed(() => workspace.data?.apps || []);
const sourceId = ref(""),
  checking = ref(false);
const ApplicationMigrationDialog = defineAsyncComponent(
  () => import("../collaboration/ApplicationMigrationDialog.vue"),
);
</script>
<template>
  <BaseDialog
    :open="true"
    title="原应用迁移检查"
    width="540px"
    @close="emit('close')"
  >
    <p class="collab-help">
      选择原应用，检查表单、记录、身份和流程的接入条件。当前提供检查与对应准备，尚不执行整套迁移。
    </p>
    <label class="collab-field"
      >原应用<select v-model="sourceId" aria-label="选择迁移检查应用">
        <option value="">请选择原应用</option>
        <option
          v-for="application in applications"
          :key="application.id"
          :value="application.id"
        >
          {{ application.name }}
        </option>
      </select></label
    >
    <template #footer
      ><button class="button" @click="emit('close')">关闭</button
      ><button
        class="button primary"
        :disabled="!sourceId"
        @click="checking = true"
      >
        检查原应用
      </button></template
    >
  </BaseDialog>
  <ApplicationMigrationDialog
    v-if="checking && sourceId"
    :app-id="sourceId"
    @close="checking = false"
  />
</template>
