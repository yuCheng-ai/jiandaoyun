<script setup lang="ts">
import { ref } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from "vue-router";
import type { DataObjectDraft, DataField, DataModelImpact } from "@platform/contracts";
import { separateFormSchema, modelFormSchema, serverDataKinds, serverDataKindLabels, dataKind, defaultControlType } from "@platform/contracts";
import { createField, emptySchema, copy, type FieldType } from "../../domain/form";
import { modelFields } from "../../domain/pageDesigner";
import { platformApi } from "../../repositories/platformApi";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import BaseDialog from "../../components/BaseDialog.vue";
import FieldValueRules from "./FieldValueRules.vue";
import DataModelPublishDialog from "./DataModelPublishDialog.vue";
const props = defineProps<{ object: DataObjectDraft }>();
const emit = defineEmits<{ close: []; saved: [object: DataObjectDraft] }>();
const draft = ref(copy(props.object)), busy = ref(false), error = ref("");
const router = useRouter(), leaveTo = ref(""), baseline = ref(JSON.stringify(draft.value));
const reviewing = ref(false), impact = ref<DataModelImpact>(), restoring = ref(false), reloading = ref(false), notice = ref("");
let leaveApproved = false;
let serverChanged = false;
const { requestClose, confirmDiscard, discard, markSaved } = useDraftDismiss(() => true, () => draft.value, () => {
  if (leaveTo.value) { leaveApproved = true; router.push(leaveTo.value); }
  else if (serverChanged) emit("saved", draft.value);
  else emit("close");
});
function guard(to: { fullPath: string }) {
  if (busy.value) return false;
  if (!leaveApproved && JSON.stringify(draft.value) !== baseline.value) { leaveTo.value = to.fullPath; requestClose(); return false; }
  return true;
}
onBeforeRouteLeave(guard); onBeforeRouteUpdate(guard);
const kindName = (field: DataField) => serverDataKindLabels[field.kind] || field.kind;
const scalarTypes = serverDataKinds.filter(kind => kind !== "subform").map(defaultControlType);
const newType = ref<FieldType>("text");
const childType = ref<FieldType>("text");
const rulesField = (field: DataField) => modelFormSchema({ version: 1, fields: [field] }).fields[0]!;
function add(type: FieldType, parent?: DataField) {
  const field = separateFormSchema({ ...emptySchema(), fields: [createField(type)] }).model.fields[0]!;
  const fields = parent?.children || draft.value.model.fields, original = field.name;
  let index = 2; while (fields.some(item => item.name === field.name)) field.name = `${original} ${index++}`;
  fields.push(field);
}
function remove(field: DataField, parentId?: string) {
  const fields = parentId ? draft.value.model.fields.find(item => item.id === parentId)!.children : draft.value.model.fields;
  fields.splice(fields.findIndex(item => item.id === field.id), 1);
}
function accept(value: DataObjectDraft) {
  draft.value = value; markSaved(); baseline.value = JSON.stringify(value); serverChanged = true;
}
async function save(close = true) {
  if (busy.value) return false;
  busy.value = true; error.value = "";
  try {
    accept(await platformApi<DataObjectDraft>(`/data-objects/${draft.value.id}`, "PUT", { ...draft.value, expectedRevision: draft.value.revision }));
    if (close) emit("saved", draft.value);
    return true;
  } catch (cause) { error.value = (cause as Error).message; return false; }
  finally { busy.value = false; }
}
async function review() {
  if (busy.value) return;
  if (JSON.stringify(draft.value) !== baseline.value && !await save(false)) return;
  reviewing.value = true; impact.value = undefined; busy.value = true; error.value = "";
  try { impact.value = await platformApi<DataModelImpact>(`/data-objects/${draft.value.id}/publish-preview`, "POST", { expectedRevision: draft.value.revision }); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function publish() {
  if (busy.value || !impact.value || impact.value.blockers.length) return;
  busy.value = true; error.value = "";
  try { accept(await platformApi<DataObjectDraft>(`/data-objects/${draft.value.id}/publish`, "POST", { expectedRevision: impact.value.revision, impactToken: impact.value.token })); emit("saved", draft.value); }
  catch (cause) { error.value = (cause as Error).message; impact.value = undefined; }
  finally { busy.value = false; }
}
async function restore() {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try {
    accept(await platformApi<DataObjectDraft>(`/data-objects/${draft.value.id}/discard-draft`, "POST", { expectedRevision: draft.value.revision }));
    restoring.value = false; notice.value = `已放弃数据草稿，恢复为已发布 V${draft.value.latestVersion}。页面草稿和记录保留。`;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function reload() {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try { accept(await platformApi<DataObjectDraft>(`/data-objects/${draft.value.id}/draft`)); reloading.value = false; notice.value = "已读取服务器最新草稿。"; }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
</script>
<template>
  <BaseDialog :open="true" title="编辑数据对象" width="880px" :busy="busy" @close="requestClose">
    <div v-if="error" class="collab-error" role="alert">{{ error }} <button class="button" :disabled="busy" @click="reloading = true">重新读取数据草稿</button></div>
    <p v-if="notice" class="collab-notice" role="status">{{ notice }}</p>
    <p v-if="draft.hasDraftChanges" class="collab-help">当前包含已保存的未发布修改{{ draft.latestVersion ? `；正式数据版本仍为 V${draft.latestVersion}` : '' }}。</p>
    <div v-if="confirmDiscard" class="config-discard collab-notice" tabindex="-1">有未保存的修改。<button class="button" @click="confirmDiscard = false; leaveTo = ''">继续编辑</button><button class="button" @click="discard">放弃修改</button></div>
    <fieldset class="model-edit-fields" :disabled="busy">
    <label class="collab-field">对象名称<input v-model="draft.title" maxlength="100" /></label>
    <p class="collab-help">这里定义共享字段。永久必填适用于采用新版的数据；某一步的填写要求，请在对应页面设置。</p>
    <div class="collab-toolbar"><button class="button" @click="add('text')">添加文本字段</button><button class="button" @click="add('number')">添加数字字段</button><button class="button" @click="add('subform')">添加明细</button><select v-model="newType" aria-label="新增数据字段类型"><option v-for="type in scalarTypes" :key="type" :value="type">{{ serverDataKindLabels[dataKind(type)!] }}</option></select><button class="button" @click="add(newType)">添加所选字段</button></div>
    <div class="collab-table-wrap"><table class="collab-table model-fields-table">
      <thead><tr><th>字段名称</th><th>类型</th><th>永久必填</th><th>数据规则</th><th>操作</th></tr></thead>
      <tbody><tr v-for="item in modelFields(draft.model)" :key="item.field.id">
        <td :class="{child: item.parentId}"><input v-model="item.field.name" :aria-label="`字段名称 ${item.field.name}`" /></td>
        <td>{{ kindName(item.field) }}</td>
        <td><input v-model="item.field.required" type="checkbox" :aria-label="`${item.field.name}永久必填`" /></td>
        <td class="model-field-rules">
          <FieldValueRules v-if="item.field.kind !== 'subform'" :field="rulesField(item.field)" :fields="modelFormSchema(draft.model).fields" :parent-id="item.parentId" @update="Object.assign(item.field.settings, $event)" />
          <span v-if="item.field.kind === 'subform'" class="collab-help">明细列分别设置</span>
        </td>
        <td><button v-if="item.field.kind === 'subform'" class="text-button" @click="add('text', item.field)">添加文本列</button><button v-if="item.field.kind === 'subform'" class="text-button" @click="add('number', item.field)">添加数字列</button><template v-if="item.field.kind === 'subform'"><select v-model="childType" :aria-label="`${item.field.name}新增列类型`"><option v-for="type in scalarTypes" :key="type" :value="type">{{ serverDataKindLabels[dataKind(type)!] }}</option></select><button class="text-button" @click="add(childType, item.field)">添加所选列</button></template><button class="text-button danger" :aria-label="`移除字段 ${item.field.name}`" @click="remove(item.field, item.parentId)">移除字段</button></td>
      </tr></tbody>
    </table></div>
    </fieldset>
    <p class="collab-help">草稿可以保留待处理的字段变更。发布前检查页面、关系、流程、权限及已有记录；不会直接删除历史值。</p>
    <template #footer><button v-if="draft.latestVersion" class="button danger" :disabled="busy" @click="restoring = true; error = ''">放弃已保存草稿</button><button class="button" :disabled="busy" @click="requestClose">取消</button><button class="button" :disabled="busy" @click="save()">保存草稿</button><button class="button primary" :disabled="busy" @click="review">检查并发布</button></template>
  </BaseDialog>
  <DataModelPublishDialog v-if="reviewing" :impact="impact" :busy="busy" :error="error" @close="reviewing = false" @retry="review" @confirm="publish" />
  <BaseDialog :open="restoring" title="放弃数据对象草稿" width="520px" :busy="busy" @close="restoring = false">
    <p>将恢复「{{ draft.title }}」最近发布的 V{{ draft.latestVersion }}，同时放弃当前未保存修改和服务器上的数据草稿。其他页面的草稿、已发布版本和业务记录保留。</p>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <template #footer><button class="button" @click="restoring = false">继续编辑</button><button class="button danger" :disabled="busy" @click="restore">确认放弃数据草稿</button></template>
  </BaseDialog>
  <BaseDialog :open="reloading" title="重新读取数据草稿" width="480px" :busy="busy" @close="reloading = false">
    <p>当前未保存的修改将被服务器最新草稿替换；不会撤销其他人已保存的修改。</p><p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <template #footer><button class="button" @click="reloading = false">继续编辑</button><button class="button primary" :disabled="busy" @click="reload">放弃当前修改并读取</button></template>
  </BaseDialog>
</template>

<style scoped>
.model-edit-fields { border: 0; padding: 0; margin: 0; min-width: 0; }
.model-fields-table { min-width: 660px; }
.model-fields-table td:first-child input { min-width: 100px; }
.model-field-rules { min-width: 150px; }
.model-field-rules label { display: flex; align-items: center; gap: 8px; margin: 3px 0; font-size: 12px; white-space: nowrap; }
.model-field-rules input { width: 85px; min-width: 0; }
</style>
