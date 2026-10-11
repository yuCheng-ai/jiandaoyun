<script setup lang="ts">
import BaseDialog from "../../../components/BaseDialog.vue";
defineProps<{
  open: boolean;
  count: number;
  selected?: boolean;
  busy: boolean;
  error: string;
}>();
const format = defineModel<string>("format", { required: true });
const includeIds = defineModel<boolean>("includeIds", { required: true });
defineEmits<{ close: []; export: [] }>();
</script>
<template>
  <BaseDialog
    :open="open"
    title="导出数据"
    width="520px"
    :busy="busy"
    pending-text="正在生成导出文件，请稍候…"
    @close="$emit('close')"
  >
    <p class="dialog-description">
      导出 {{ count }} 条{{ selected ? "所选记录" : "筛选结果" }}。
    </p>
    <label class="record-export-format"
      >文件格式<select v-model="format" aria-label="导出文件格式">
        <option value="xlsx">Excel（xlsx）</option>
        <option value="csv">CSV</option>
      </select></label
    >
    <label class="record-export-id"
      ><input v-model="includeIds" type="checkbox" />同时导出 data_id</label
    >
    <p class="field-hint">如需在 Excel 中修改后导回更新，请勾选 data_id。</p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <template #footer
      ><button class="button" @click="$emit('close')">取消</button
      ><button class="button primary" @click="$emit('export')">
        导出
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.record-export-format,
.record-export-id {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 18px 0;
}
.record-export-format select {
  width: 180px;
  height: 32px;
}
</style>
