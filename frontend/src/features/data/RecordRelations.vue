<script setup lang="ts">
import { fieldValueLabel } from "@platform/contracts";
import { computed, ref, watch } from "vue";
import type { FormValues, RecordDetail, RecordRelationGroup, RelationCandidate, RelationCandidatesPage, RelationLinkView } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { platformApi } from "../../repositories/platformApi";
import { useNotices } from "../../stores/notices";
import "./relations.css";
const { notify } = useNotices();
const props = defineProps<{ detail: RecordDetail; unsaved: boolean }>();
const emit = defineEmits<{ updated: [record: RecordDetail]; busy: [value: boolean] }>();
const groups = ref<RecordRelationGroup[]>([]), busy = ref(false), error = ref("");
const chooser = ref<RecordRelationGroup>(), rowId = ref(""), query = ref(""), candidates = ref<RelationCandidate[]>([]), candidateColumns = ref<Record<string, string>>({}), cursor = ref<string | null>(null), relationVersion = ref(0), selected = ref<RelationCandidate>(), candidateError = ref("");
const removing = ref<{ group: RecordRelationGroup; link: RelationLinkView }>();
const related = ref<RecordDetail>(), relatedOpen = ref(false), relatedError = ref("");
const sourceFull = computed(() => chooser.value?.relation.spec.cardinality === "one" && chooser.value.links.some(link => (link.sourceRowId || "") === rowId.value));
const path = computed(() => props.detail.page ? `/pages/${props.detail.page.id}/records/${props.detail.record.id}` : `/records/${props.detail.record.id}`);
const pageQuery = () => props.detail.page ? `version=${props.detail.page.version}` : "";
const rows = (group: RecordRelationGroup) => group.relation.spec.sourceSubformId ? (props.detail.record.values[group.relation.spec.sourceSubformId] || []) as FormValues[] : [];
function rowLabel(group: RecordRelationGroup, id: string) {
  const index = rows(group).findIndex(row => row._rowId === id);
  const field = props.detail.definition.schema.fields.find(f => f.id === group.relation.spec.sourceSubformId);
  const summary = field?.children.slice(0, 2).map(f => fieldValueLabel(f, rows(group)[index]?.[f.id], props.detail.identities)).filter(v => v !== undefined && v !== "").join(' / ');
  return `${field?.label || '明细'}第 ${index + 1} 行${summary ? ` · ${summary}` : ''}`;
}
let loadEpoch = 0;
async function load() {
  const epoch = ++loadEpoch; error.value = "";
  try { const result = await platformApi<RecordRelationGroup[]>(`${path.value}/relations?${pageQuery()}`); if (epoch === loadEpoch) groups.value = result; }
  catch (cause) { if (epoch === loadEpoch) { groups.value = []; error.value = (cause as Error).message; } }
}
watch(() => [props.detail.record.id, props.detail.record.revision], () => { if (!busy.value) load(); }, { immediate: true });
watch(() => props.detail.access.edit, (editable) => {
  if (editable) return;
  chooser.value = undefined;
  removing.value = undefined;
  selected.value = undefined;
});
async function choose(group: RecordRelationGroup) {
  if (!props.detail.access.edit || props.unsaved || busy.value) return;
  chooser.value = group; rowId.value = rows(group)[0]?._rowId as string || ""; query.value = ""; candidates.value = []; selected.value = undefined; cursor.value = null;
  if (!group.relation.spec.sourceSubformId || rowId.value) await search();
}
async function search(more = false) {
  if (!props.detail.access.edit || !chooser.value || busy.value) return;
  busy.value = true; candidateError.value = ""; selected.value = undefined;
  if (!more) { candidates.value = []; cursor.value = null; }
  try {
    const params = new URLSearchParams(pageQuery());
    if (rowId.value) params.set("rowId", rowId.value);
    if (more && cursor.value) params.set("cursor", cursor.value);
    params.set("q", query.value);
    const result = await platformApi<RelationCandidatesPage>(`${path.value}/relations/${chooser.value.relation.id}/candidates?${params}`);
    candidates.value = more ? [...candidates.value, ...result.items] : result.items;
    candidateColumns.value = result.columnLabels; relationVersion.value = result.relationVersion; cursor.value = result.nextCursor;
  } catch (cause) { candidateError.value = (cause as Error).message; }
  finally { busy.value = false; }
}
let requestKey = "", fingerprint = "";
async function mutate(unlink = false) {
  if (!props.detail.access.edit || props.unsaved || busy.value) return;
  const group = unlink ? removing.value?.group : chooser.value;
  if (!group || (!unlink && !selected.value)) return;
  busy.value = true; emit("busy", true); candidateError.value = ""; error.value = "";
  const commandPath = `${path.value}/relations/${group.relation.id}/links${unlink ? `/${removing.value!.link.id}/remove` : ''}`;
  const payload = { ...(props.detail.page ? { pageVersion: props.detail.page.version } : {}), ...(!unlink ? { targetRecordId: selected.value!.recordId, expectedTargetRevision: selected.value!.revision, expectedRelationVersion: relationVersion.value, expectedCells: props.detail.record.cellRevisions, ...(rowId.value ? { sourceRowId: rowId.value } : {}) } : {}) };
  const nextFingerprint = JSON.stringify([commandPath, payload]);
  if (nextFingerprint !== fingerprint) { fingerprint = nextFingerprint; requestKey = crypto.randomUUID(); }
  try {
    const result = await platformApi<{ record: RecordDetail }>(commandPath, "POST", { ...payload, requestId: requestKey });
    emit("updated", result.record); chooser.value = undefined; removing.value = undefined;
    let message = "关联已保存";
    if (unlink) message = "关联已解除，已回填的值保留";
    else if (selected.value?.mappings?.length) message = "关联及字段回填已保存";
    notify(message);
    await load();
  } catch (cause) {
    if (unlink) error.value = (cause as Error).message;
    else candidateError.value = (cause as Error).message;
  } finally { busy.value = false; emit("busy", false); }
}
async function openRelated(group: RecordRelationGroup, link: RelationLinkView) {
  relatedOpen.value = true; related.value = undefined; relatedError.value = ""; busy.value = true;
  try { related.value = await platformApi<RecordDetail>(`/records/${group.direction === 'incoming' ? link.sourceRecordId : link.targetRecordId}`); }
  catch (cause) { relatedError.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function refreshSource() {
  if (!props.detail.access.edit || props.unsaved || busy.value) return;
  busy.value = true; emit("busy", true); candidateError.value = "";
  let refreshed = false;
  try {
    const result = await platformApi<RecordDetail>(`${path.value}?${pageQuery()}`);
    emit("updated", result); selected.value = undefined; refreshed = true;
    await load();
    if (chooser.value) {
      chooser.value = groups.value.find(g => g.direction !== "incoming" && g.relation.id === chooser.value?.relation.id);
      if (chooser.value?.relation.spec.sourceSubformId && !rows(chooser.value).some(row => row._rowId === rowId.value)) rowId.value = String(rows(chooser.value)[0]?._rowId || "");
    }
  } catch (cause) { candidateError.value = (cause as Error).message; }
  finally { busy.value = false; emit("busy", false); }
  if (refreshed && chooser.value) await search();
}
const alreadyLinked = (candidate: RelationCandidate) => chooser.value?.links.some(link => link.targetRecordId === candidate.recordId && (link.sourceRowId || "") === rowId.value);
</script>
<template>
  <section v-if="groups.length || error" class="record-relations">
    <div class="collab-toolbar"><strong>关联业务记录</strong><button class="text-button" :disabled="busy" @click="load">刷新关联</button></div>
    <p v-if="error && !removing" class="collab-error" role="alert">{{ error }}</p>
    <p v-if="detail.access.edit && unsaved" class="collab-help">请先保存当前字段和明细修改，再建立或解除关联。</p>
    <article v-for="group in groups" :key="`${group.direction}-${group.relation.id}`" class="relation-record-group">
      <div class="collab-toolbar"><div><strong>{{ group.relation.spec.title }}</strong><small class="collab-help"> · {{ group.direction === 'incoming' ? '关联到本记录的来源' : '本记录关联的数据' }}</small></div><button v-if="detail.access.edit && group.direction !== 'incoming' && group.canLink" class="button" :disabled="unsaved || busy || (!!group.relation.spec.sourceSubformId && !rows(group).length)" @click="choose(group)">选择关联记录</button></div>
      <p v-if="group.unavailableReason" class="collab-help">{{ group.unavailableReason }}</p><p v-if="detail.access.edit && group.direction !== 'incoming' && group.relation.spec.sourceSubformId && !rows(group).length" class="collab-help">保存一行明细后，即可为该行选择关联。</p>
      <div class="collab-table-wrap"><table v-if="group.links.length" class="collab-table"><thead><tr><th>关联记录</th><th v-if="group.direction !== 'incoming' && group.relation.spec.sourceSubformId">所属明细</th><th v-for="(label, id) in group.columnLabels" :key="id">{{ label }}</th><th>取值方式</th><th>操作</th></tr></thead><tbody><tr v-for="link in group.links" :key="link.id"><td>{{ link.label }}</td><td v-if="group.direction !== 'incoming' && group.relation.spec.sourceSubformId">{{ rowLabel(group, link.sourceRowId || '') }}</td><td v-for="(_, id) in group.columnLabels" :key="id">{{ link.restricted ? '无权查看' : link.displayValues?.[id] ?? link.values[id] ?? '—' }}</td><td>{{ link.valueMode === 'snapshot' ? '关联时的值' : '当前值' }}</td><td><button v-if="!link.restricted" class="text-button" @click="openRelated(group, link)">查看记录</button><button v-if="detail.access.edit && group.direction !== 'incoming' && group.permission === 'edit'" class="text-button" :disabled="unsaved || busy" @click="removing = {group, link}; error = ''">解除关联</button></td></tr></tbody></table></div><p v-if="!group.links.length" class="collab-help">尚未关联记录。</p>
    </article>
  </section>
  <BaseDialog :open="detail.access.edit && !!chooser" :title="`选择关联记录 · ${chooser?.relation.spec.title || ''}`" width="860px" :busy="busy" @close="chooser = undefined">
    <template v-if="chooser">
      <label v-if="chooser.relation.spec.sourceSubformId" class="collab-field">所属明细行<select v-model="rowId" @change="search()"><option v-for="row in rows(chooser)" :key="String(row._rowId)" :value="row._rowId">{{ rowLabel(chooser, String(row._rowId)) }}</option></select></label>
      <form class="collab-toolbar relation-search" @submit.prevent="search()"><input v-model="query" aria-label="搜索关联记录" placeholder="按记录标题搜索" maxlength="100" /><button class="button" type="submit">搜索</button></form>
      <p class="collab-help">候选项已按当前记录的筛选条件及成员权限检查。关联和字段回填将立即保存。</p><p v-if="sourceFull" class="collab-notice">此位置只允许关联一条记录。请先关闭选择并解除已有关系，再选择新的记录。</p><p v-if="candidateError" class="collab-error" role="alert">{{ candidateError }} <button class="text-button" @click="refreshSource">重新读取后选择</button></p>
      <div class="collab-table-wrap"><table class="collab-table"><thead><tr><th>选择</th><th>记录标题</th><th v-for="(label, id) in candidateColumns" :key="id">{{ label }}</th></tr></thead><tbody><tr v-for="candidate in candidates" :key="candidate.recordId"><td><input v-model="selected" type="radio" name="relation-candidate" :value="candidate" :aria-label="`选择${candidate.label}`" :disabled="alreadyLinked(candidate)" /><small v-if="alreadyLinked(candidate)">已关联</small></td><td>{{ candidate.label }}</td><td v-for="(_, id) in candidateColumns" :key="id">{{ candidate.displayValues?.[id] ?? candidate.values[id] ?? '—' }}</td></tr></tbody></table></div>
      <p v-if="!busy && !candidates.length" class="collab-help">当前未找到符合条件且有权查看的记录。{{ cursor ? '可以继续加载后续候选。' : '可调整搜索或检查已保存的业务字段。' }}</p><button v-if="cursor" class="text-button" @click="search(true)">加载更多候选</button>
      <div v-if="selected?.mappings?.length" class="collab-notice"><strong>确认本次回填</strong><p v-for="mapping in selected.mappings" :key="mapping.fieldId">{{ mapping.label }}：{{ mapping.beforeLabel || (mapping.before === '' || mapping.before == null ? '空' : mapping.before) }} → {{ mapping.valueLabel || (mapping.value === '' || mapping.value == null ? '空' : mapping.value) }}</p></div>
    </template>
    <template #footer><button class="button" @click="chooser = undefined">取消</button><button class="button primary" :disabled="!selected || unsaved || sourceFull" @click="mutate()">确认关联</button></template>
  </BaseDialog>
  <BaseDialog :open="detail.access.edit && !!removing" title="解除关联" :busy="busy" @close="removing = undefined"><p>解除与「{{ removing?.link.label }}」的关联。双方业务记录及之前回填的值都会保留。</p><p v-if="error" class="collab-error" role="alert">{{ error }}</p><template #footer><button class="button" @click="removing = undefined">保留关联</button><button class="button danger" @click="mutate(true)">确认解除</button></template></BaseDialog>
  <BaseDialog :open="relatedOpen" :title="`关联记录 · ${related?.definition.title || ''}`" width="780px" :busy="busy" @close="relatedOpen = false"><p class="collab-help">以下为该记录的当前数据，仅显示你现在有权查看的字段。</p><p v-if="relatedError" class="collab-error" role="alert">{{ relatedError }}</p><template v-if="related"><div v-for="field in related.definition.schema.fields" :key="field.id" class="collab-field"><strong>{{ field.label }}</strong><span v-if="field.type !== 'subform'">{{ fieldValueLabel(field, related.record.values[field.id], related.identities) || '—' }}</span><div v-else class="collab-table-wrap"><table class="collab-table"><thead><tr><th v-for="child in field.children" :key="child.id">{{ child.label }}</th></tr></thead><tbody><tr v-for="row in (related.record.values[field.id] as FormValues[])" :key="String(row._rowId)"><td v-for="child in field.children" :key="child.id">{{ fieldValueLabel(child, row[child.id], related.identities) || '—' }}</td></tr></tbody></table></div></div></template><template #footer><button class="button" @click="relatedOpen = false">关闭</button></template></BaseDialog>
</template>
