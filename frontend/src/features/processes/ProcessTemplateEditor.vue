<script setup lang="ts">
import ServerFieldControl from "../collaboration/ServerFieldControl.vue";
import { modelFormSchema, isMultipleChoice, type OrganizationIdentity } from "@platform/contracts";
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { composeFormSchema, type DataModel, type DefinitionSummary, type FormField, type PageSummary, type ProcessBindingSpec, type ProcessTemplateDraft, type ProcessTemplateSpec, type ProcessTemplateTask, type PublishedPage, type SessionUser, type ServerOrganization } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi, PlatformError } from "../../repositories/platformApi";
const props = defineProps<{ applicationId: string; objects: DefinitionSummary[]; pages: PageSummary[]; template?: ProcessTemplateDraft }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const saved = ref(props.template), spec = ref<ProcessTemplateSpec>(JSON.parse(JSON.stringify(props.template?.spec || { title: "", bindings: [], tasks: [] })));
const users = ref<SessionUser[]>([]), models = ref<Record<string, DataModel>>({}), pageVersions = ref<Record<string, { page: PublishedPage; model: DataModel }>>({});
const fieldLoading = ref(0), organization = ref<ServerOrganization>();
const waitIdentities = computed<OrganizationIdentity[]>(() => [...(organization.value?.users || []).map(user => ({ id: user.id, name: user.name, active: user.active, kind: 'member' as const })), ...(organization.value?.spec.departments || []).map(item => ({ id: item.id, name: item.name, active: !item.archived, kind: 'department' as const }))]);
const busy = ref(false), error = ref(""), notice = ref(""), conflict = ref(false), reloadConfirm = ref(false);
const { requestClose, confirmDiscard, discard, markSaved } = useDraftDismiss(() => true, () => spec.value, () => emit("close"));
onBeforeRouteLeave(() => { requestClose(); return false; });
const identity = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const binding = (id: string) => spec.value.bindings.find(b => b.id === id);
const model = (id: string) => { const b = binding(id); return b ? models.value[`${b.definitionId}/${b.definitionVersion}`] : undefined; };
const taskPage = (task: ProcessTemplateTask) => pageVersions.value[`${task.pageId}/${task.pageVersion}`];
const taskFields = (task: ProcessTemplateTask): FormField[] => { const source = taskPage(task); return source ? composeFormSchema(source.model, source.page.schema).fields.filter(f => f.visible) : []; };
const requiredChoices = (task: ProcessTemplateTask) => (task.subformId ? taskFields(task).find(f => f.id === task.subformId)?.children || [] : taskFields(task).flatMap(f => f.type === 'subform' ? f.children : [f])).filter(f => f.visible && f.type !== 'subform');
const pageChoices = (task: ProcessTemplateTask) => props.pages.filter(p => p.latestVersion && !p.archivedAt && p.definitionId === binding(task.recordBinding)?.definitionId);
const waitChoices = (task: ProcessTemplateTask) => { const data = model(task.waitFor?.recordBinding || ''); return (task.waitFor?.subformId ? data?.fields.find(f => f.id === task.waitFor!.subformId)?.children : data?.fields)?.filter(f => f.kind !== 'subform') || []; };
async function run(action: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; notice.value = ''; try { await action(); } catch (cause) { error.value = (cause as Error).message; conflict.value = cause instanceof PlatformError && cause.status === 409; } finally { busy.value = false; } }
async function ensureModel(b: ProcessBindingSpec) { if (!b.definitionId || !b.definitionVersion) return; const key = `${b.definitionId}/${b.definitionVersion}`; if (!models.value[key]) models.value[key] = await platformApi<DataModel>(`/data-objects/${b.definitionId}/versions/${b.definitionVersion}`); }
async function ensurePage(task: ProcessTemplateTask) { if (!task.pageId || !task.pageVersion) return; const key = `${task.pageId}/${task.pageVersion}`; if (!pageVersions.value[key]) pageVersions.value[key] = await platformApi(`/pages/${task.pageId}?version=${task.pageVersion}`); }
async function loadResources() { const directory = await platformApi<ServerOrganization>('/organization'); organization.value = directory; users.value = directory.users.filter(user => user.active); await Promise.all([...spec.value.bindings.map(ensureModel), ...spec.value.tasks.map(ensurePage)]); }
async function prepare(action: () => Promise<void>) { fieldLoading.value++; error.value = ''; try { await action(); } catch (cause) { error.value = (cause as Error).message; } finally { fieldLoading.value--; } }
onMounted(() => prepare(loadResources));
function addBinding() { spec.value.bindings.push({ id: identity('data'), title: `业务数据 ${spec.value.bindings.length + 1}`, definitionId: '', definitionVersion: 0 }); }
function removeBinding(id: string) { if (spec.value.tasks.some(t => t.recordBinding === id || t.waitFor?.recordBinding === id)) { error.value = '此业务数据已被任务或等待条件使用，请先调整对应任务。'; return; } spec.value.bindings = spec.value.bindings.filter(b => b.id !== id); }
function changeObject(b: ProcessBindingSpec) { b.definitionVersion = props.objects.find(o => o.id === b.definitionId)?.latestVersion || 0; prepare(() => ensureModel(b)); }
function changeAssignee(task: ProcessTemplateTask, kind: string) {
  task.assigneeId = '';
  task.assigneeSelector = kind === 'member' ? undefined : { kind: kind as 'department' | 'role', id: '', ...(kind === 'department' ? { includeChildren: true } : {}) };
}
function addTask() { spec.value.tasks.push({ id: identity('task'), title: `处理任务 ${spec.value.tasks.length + 1}`, recordBinding: spec.value.bindings[0]?.id || '', assigneeId: '', pageId: '', pageVersion: 0, dependsOn: [], requiredFields: [] }); }
function removeTask(id: string) { if (spec.value.tasks.some(t => t.dependsOn.includes(id))) { error.value = '其他任务正在等待此任务，请先调整前置任务配置。'; return; } spec.value.tasks = spec.value.tasks.filter(t => t.id !== id); }
function changePage(task: ProcessTemplateTask) { task.pageVersion = props.pages.find(p => p.id === task.pageId)?.latestVersion || 0; prepare(() => ensurePage(task)); }
function toggleWait(task: ProcessTemplateTask, checked: boolean) { task.waitFor = checked ? { recordBinding: task.recordBinding, fieldId: '', equals: '' } : undefined; }
function clearWaitField(task: ProcessTemplateTask) { if (task.waitFor) { task.waitFor.fieldId = ''; task.waitFor.equals = ''; } }
const waitField = (task: ProcessTemplateTask) => { const field = waitChoices(task).find(f => f.id === task.waitFor?.fieldId); return field ? modelFormSchema({version: 1, fields: [field]}).fields[0] : undefined; };
function changeWaitField(task: ProcessTemplateTask) { if (task.waitFor) { const field = waitField(task); task.waitFor.equals = field?.type === 'number' ? 0 : isMultipleChoice(field?.type || '') ? [] : ''; } }
function setWaitValue(task: ProcessTemplateTask, value: unknown) { if (task.waitFor) task.waitFor.equals = value as string | number | string[]; }
let createKey = '', fingerprint = '';
async function save(publish: boolean) { await run(async () => {
  if (!spec.value.title.trim()) throw new Error('请填写流程名称。');
  const next = JSON.stringify(spec.value); if (next !== fingerprint) { fingerprint = next; createKey = crypto.randomUUID(); }
  saved.value = await platformApi<ProcessTemplateDraft>(saved.value ? `/process-templates/${saved.value.id}` : '/process-templates', saved.value ? 'PUT' : 'POST', { applicationId: props.applicationId, spec: spec.value, expectedRevision: saved.value?.revision, requestId: createKey });
  markSaved();
  if (publish) { await platformApi(`/process-templates/${saved.value.id}/publish`, 'POST', { expectedRevision: saved.value.revision }); emit('saved'); }
  else notice.value = '流程草稿已保存。发布后可以选择业务记录并发起。';
}); }
async function reload() { await run(async () => {
  const latest = (await platformApi<ProcessTemplateDraft[]>(`/process-templates?applicationId=${props.applicationId}`)).find(t => t.id === saved.value?.id);
  if (!latest) throw new Error('流程模板已不可用，请关闭后重新检查。');
  saved.value = latest; spec.value = JSON.parse(JSON.stringify(latest.spec)); markSaved(); reloadConfirm.value = false; conflict.value = false; await loadResources();
}); }
</script>
<template>
  <BaseDialog :open="true" :title="saved ? `流程配置 · ${saved.spec.title}` : '新建流程'" width="960px" :busy="busy" @close="requestClose">
    <p class="collab-help">选择流程需要的业务数据，为任务指定处理人和页面。发起时再选择具体记录。</p>
    <p v-if="error" class="collab-error" role="alert">{{ error }} <button v-if="conflict && saved" class="text-button" @click="reloadConfirm = true">检查最新草稿</button><button v-if="!users.length" class="text-button" @click="prepare(loadResources)">重新读取配置</button></p><p v-if="notice" class="collab-success" role="status">{{ notice }}</p>
    <div v-if="reloadConfirm" class="collab-notice">重新读取将替换当前输入。<button class="button" @click="reloadConfirm = false">保留输入</button><button class="button" @click="reload">放弃输入并读取</button></div>
    <div v-if="confirmDiscard" class="config-discard collab-notice" tabindex="-1">有未保存的流程配置。<button class="button" @click="confirmDiscard = false">继续编辑</button><button class="button" @click="discard">放弃修改</button></div>
    <p v-if="fieldLoading" class="collab-help" role="status">正在读取成员和字段配置…</p>
    <label class="collab-field">流程名称<input v-model="spec.title" maxlength="100" placeholder="填写业务协作名称" /></label>
    <section class="process-config-section"><div class="collab-toolbar"><div><strong>业务数据</strong><p class="collab-help">每项对应发起时选择的一条记录，可以来自不同数据对象。</p></div><button class="button" :disabled="spec.bindings.length >= 20" @click="addBinding">添加业务数据</button></div>
      <article v-for="(b,index) in spec.bindings" :key="b.id" class="process-config-card"><div class="collab-toolbar"><strong>业务数据 {{ index + 1 }}</strong><button class="text-button" :aria-label="`移除业务数据 ${index + 1}`" @click="removeBinding(b.id)">移除</button></div><div class="process-config-grid">
        <label class="collab-field">业务名称<input v-model="b.title" :aria-label="`业务数据 ${index + 1} 名称`" maxlength="100" /></label>
        <label class="collab-field">数据对象<select v-model="b.definitionId" :aria-label="`业务数据 ${index + 1} 对象`" @change="changeObject(b)"><option value="">请选择已发布的数据对象</option><option v-for="o in objects.filter(o => o.latestVersion)" :key="o.id" :value="o.id">{{ o.title }}</option></select></label>
        <label v-if="b.definitionId" class="collab-field">数据版本<select v-model.number="b.definitionVersion" :aria-label="`业务数据 ${index + 1} 版本`" @change="prepare(() => ensureModel(b))"><option v-for="v in objects.find(o => o.id === b.definitionId)?.latestVersion || 0" :key="v" :value="v">V{{ v }}</option></select></label>
      </div></article><p v-if="!spec.bindings.length" class="collab-help">先添加至少一份业务数据。</p>
    </section>
    <section class="process-config-section"><div class="collab-toolbar"><div><strong>处理任务</strong><p class="collab-help">未设置前置任务的节点可以并行。按明细展开时，后续节点会等待该节点的所有明细任务完成。</p></div><button class="button" :disabled="!spec.bindings.length || spec.tasks.length >= 30" @click="addTask">添加处理任务</button></div>
      <article v-for="(task,index) in spec.tasks" :key="task.id" class="process-config-card" :aria-label="`任务 ${index + 1} 配置`">
        <div class="collab-toolbar"><div><span class="process-node-number">{{ index + 1 }}</span><strong>{{ task.title }}</strong></div><button class="text-button" :aria-label="`移除任务 ${index + 1}`" @click="removeTask(task.id)">移除任务</button></div>
        <div class="process-config-grid">
          <label class="collab-field">任务名称<input v-model="task.title" :aria-label="`任务 ${index + 1} 名称`" maxlength="100" /></label>
          <label class="collab-field">取人方式<select :value="task.assigneeSelector?.kind || 'member'" :aria-label="`任务 ${index + 1} 取人方式`" @change="changeAssignee(task, ($event.target as HTMLSelectElement).value)"><option value="member">指定成员</option><option value="department">部门成员逐人办理</option><option value="role">角色成员逐人办理</option></select></label>
          <label v-if="!task.assigneeSelector" class="collab-field">处理人<select v-model="task.assigneeId" :aria-label="`任务 ${index + 1} 处理人`"><option value="">请选择成员</option><option v-for="user in users" :key="user.id" :value="user.id">{{ user.name }}</option></select></label>
          <label v-else class="collab-field">{{ task.assigneeSelector.kind === 'department' ? '选择部门' : '选择角色' }}<select v-model="task.assigneeSelector.id" :aria-label="`任务 ${index + 1} 取人范围`"><option value="">请选择</option><option v-for="item in (task.assigneeSelector.kind === 'department' ? organization?.spec.departments : organization?.spec.roles)?.filter(item => !item.archived) || []" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label v-if="task.assigneeSelector?.kind === 'department'" class="checkbox-line"><input v-model="task.assigneeSelector.includeChildren" type="checkbox" />包括下级部门成员</label>
          <label class="collab-field">处理业务数据<select v-model="task.recordBinding" :aria-label="`任务 ${index + 1} 业务数据`"><option value="">请选择</option><option v-for="b in spec.bindings" :key="b.id" :value="b.id">{{ b.title }}</option></select></label>
          <label class="collab-field">处理页面<select v-model="task.pageId" :aria-label="`任务 ${index + 1} 页面`" @change="changePage(task)"><option value="">请选择已发布页面</option><option v-if="task.pageId && !pageChoices(task).some(p => p.id === task.pageId)" :value="task.pageId">原页面已归档或不适用于当前数据，请重新选择</option><option v-for="p in pageChoices(task)" :key="p.id" :value="p.id">{{ p.title }}</option></select></label>
          <label v-if="task.pageId" class="collab-field">页面版本<select v-model.number="task.pageVersion" :aria-label="`任务 ${index + 1} 页面版本`" @change="prepare(() => ensurePage(task))"><option v-if="!pages.some(p => p.id === task.pageId)" :value="task.pageVersion">V{{ task.pageVersion }}（原绑定）</option><option v-for="v in pages.find(p => p.id === task.pageId)?.latestVersion || 0" :key="v" :value="v">V{{ v }}</option></select></label>
          <label v-if="taskPage(task)" class="collab-field">处理范围<select v-model="task.subformId" :aria-label="`任务 ${index + 1} 范围`"><option :value="undefined">整条业务记录</option><option v-for="field in taskFields(task).filter(f => f.type === 'subform')" :key="field.id" :value="field.id">按「{{ field.label }}」每行生成任务</option></select></label>
        </div>
        <p v-if="taskPage(task) && (taskPage(task)!.page.definitionVersion !== binding(task.recordBinding)?.definitionVersion || taskPage(task)!.page.definitionId !== binding(task.recordBinding)?.definitionId)" class="collab-error">处理页面的数据对象或版本不匹配，请选择对应页面版本，或调整上方业务数据版本。</p>
        <p v-if="task.assigneeSelector" class="collab-help">发起时为每位在用成员生成独立任务。全部成员完成才满足后续依赖；分配本身不增加数据权限。已发出的任务不会随成员调动自动改派。</p>
        <p v-if="task.subformId" class="collab-help">发起时按现有明细行生成任务，每个任务仅可修改绑定行；后续新增明细不会自动加入本次流程。</p>
        <div class="process-fields-caption">完成任务前必须填写</div><div class="process-options"><label v-for="field in requiredChoices(task)" :key="field.id" class="process-option"><input v-model="task.requiredFields" type="checkbox" :value="field.id" />{{ field.label }}</label></div><p v-if="task.requiredFields.some(id => !requiredChoices(task).some(f => f.id === id))" class="collab-error">原必填配置中有字段不在当前范围。<button class="text-button" @click="task.requiredFields = task.requiredFields.filter(id => requiredChoices(task).some(f => f.id === id))">移除无效必填项</button></p>
        <div class="process-fields-caption">等待以下任务全部完成</div><div class="process-options"><label v-for="previous in spec.tasks.filter(t => t.id !== task.id)" :key="previous.id" class="process-option"><input v-model="task.dependsOn" type="checkbox" :value="previous.id" />{{ previous.title }}</label></div><p v-if="!task.dependsOn.length" class="collab-help">不等待其他任务，可与其他起始任务并行。</p>
        <label class="process-option"><input type="checkbox" :checked="!!task.waitFor" @change="toggleWait(task, ($event.target as HTMLInputElement).checked)" />同时等待业务条件</label>
        <div v-if="task.waitFor" class="process-config-grid process-preview">
          <label class="collab-field">条件数据<select v-model="task.waitFor.recordBinding" :aria-label="`任务 ${index + 1} 条件数据`" @change="task.waitFor.subformId = undefined; clearWaitField(task)"><option v-for="b in spec.bindings" :key="b.id" :value="b.id">{{ b.title }}</option></select></label>
          <label class="collab-field">条件范围<select v-model="task.waitFor.subformId" :aria-label="`任务 ${index + 1} 条件范围`" @change="clearWaitField(task)"><option :value="undefined">主数据字段</option><option v-if="task.subformId && task.waitFor.recordBinding === task.recordBinding" :value="task.subformId">本任务的明细行</option></select></label>
          <label class="collab-field">等待字段<select v-model="task.waitFor.fieldId" :aria-label="`任务 ${index + 1} 等待字段`" @change="changeWaitField(task)"><option value="">请选择</option><option v-for="f in waitChoices(task)" :key="f.id" :value="f.id">{{ f.name }}</option></select></label>
          <div class="collab-field">等于<ServerFieldControl v-if="waitField(task)" :field="waitField(task)!" :identities="waitIdentities" :model-value="task.waitFor.equals" :input-id="`wait-${task.id}`" :label="`任务 ${index + 1} 等待值`" @update:model-value="setWaitValue(task, $event)" /><small v-if="isMultipleChoice(waitField(task)?.type || '')">需与所选集合一致，选择顺序不影响判断。</small></div>
        </div>
      </article>
    </section>
    <p class="collab-help">分配任务不会增加成员的数据权限。发布后保留当前版本，后续草稿不影响已发起流程。</p>
    <template #footer><button class="button" @click="requestClose">关闭</button><button class="button" :disabled="fieldLoading > 0" @click="save(false)">保存草稿</button><button class="button primary" :disabled="fieldLoading > 0" @click="save(true)">保存并发布</button></template>
  </BaseDialog>
</template>
