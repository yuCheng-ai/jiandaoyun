<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { organizationIdentityLabel } from "@platform/contracts";
import BaseDialog from "../BaseDialog.vue";
const props = defineProps<{ modelValue: unknown; options: { id: string; name: string; active?: boolean; historical?: boolean }[]; known?: { id: string; name: string; active?: boolean; historical?: boolean }[]; multiple?: boolean; disabled?: boolean; label: string; loading?: boolean; error?: string; includeInactive?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | string[]]; open: []; retry: [] }>();
const open = ref(false), query = ref(''), selected = ref<string[]>([]);
const ids = computed(() => Array.isArray(props.modelValue) ? props.modelValue as string[] : props.modelValue ? [String(props.modelValue)] : []);
const labelFor = (id: string) => { const item = [...props.options, ...(props.known || [])].find(item => item.id === id); return item ? organizationIdentityLabel(item) : '已选择身份（待读取）'; };
const candidates = computed(() => props.options.filter(item => !item.historical && (props.includeInactive || item.active !== false) && item.name.toLowerCase().includes(query.value.trim().toLowerCase())));
function show() { selected.value = [...ids.value]; query.value = ''; open.value = true; emit('open'); }
function toggle(id: string, checked: boolean) { selected.value = props.multiple ? checked ? [...new Set([...selected.value, id])] : selected.value.filter(value => value !== id) : checked ? [id] : []; }
function confirm() { emit('update:modelValue', props.multiple ? [...selected.value] : selected.value[0] || ''); open.value = false; }
watch(() => props.disabled, value => { if (value) open.value = false; });
</script>
<template>
  <div class="server-identity-select">
    <button class="server-identity-trigger" :aria-label="label" :disabled="disabled" @click="show">{{ ids.length ? ids.map(labelFor).join('、') : loading ? '正在读取默认值…' : '请选择' }}</button>
    <p v-if="error && !open" class="field-hint" role="alert">{{ error }}<button v-if="!disabled" class="text-button" @click="emit('retry')">重试</button></p>
    <BaseDialog :open="open" :title="label" width="560px" @close="open = false">
      <label class="collab-field">搜索<input v-model="query" :aria-label="`${label}搜索`" placeholder="按名称搜索" /></label>
      <p v-if="loading" role="status">正在读取允许选择的范围…</p>
      <p v-if="error" class="collab-error" role="alert">{{ error }} <button class="text-button" @click="emit('retry')">重试</button></p>
      <div v-if="selected.length" class="server-identity-selected"><span v-for="id in selected" :key="id">{{ labelFor(id) }}<button class="text-button" :aria-label="`移除${labelFor(id)}`" @click="selected = selected.filter(value => value !== id)">×</button></span></div>
      <div class="server-identity-options" role="group" :aria-label="`${label}候选项`"><label v-for="item in candidates" :key="item.id"><input :type="multiple ? 'checkbox' : 'radio'" :name="label" :checked="selected.includes(item.id)" @change="toggle(item.id, ($event.target as HTMLInputElement).checked)" />{{ organizationIdentityLabel(item) }}</label></div>
      <p v-if="!loading && !error && !candidates.length" class="collab-help">当前范围没有匹配项。</p>
      <template #footer><span class="collab-help">已选 {{ selected.length }} 项</span><button class="button" @click="open = false">取消</button><button class="button primary" :disabled="loading || !!error" @click="confirm">确定</button></template>
    </BaseDialog>
  </div>
</template>
<style scoped>
.server-identity-select { min-width: 140px; max-width: 100%; }
.server-identity-trigger { border: 1px solid #dce3eb; border-radius: 4px; background: white; padding: 8px 10px; width: 100%; text-align: left; line-height: 1.4; overflow-wrap: anywhere; font-size: 12px; color: #34445c; }
.server-identity-trigger:disabled { background: #f6f8fa; color: #657287; }
.server-identity-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; max-height: 300px; overflow: auto; margin: 12px 0; }
.server-identity-options label { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px; }
.server-identity-options input { width: auto; }
.server-identity-selected { display: flex; flex-wrap: wrap; gap: 6px; }
.server-identity-selected span { background: #f1f5f9; padding: 3px 8px; border-radius: 4px; font-size: 12px; }
@media (max-width: 500px) { .server-identity-options { grid-template-columns: 1fr; } }
</style>
