<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import type { MigrationBatch, MigrationResourcePlan } from "@platform/contracts";
import { groupActionNames, groupScopeNames, type MigrationAccessGroupSummary, type MigrationAccessSummary } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { platformApi } from "../../repositories/platformApi";
import { readMigrationResources } from "../../repositories/migrationResources";
import { readMigrationIdentities } from "../../repositories/migrationIdentities";
const props = defineProps<{ appId: string; batchId: string }>();
const emit = defineEmits<{ close: [] }>();
const batch = shallowRef<MigrationBatch>(), plan = shallowRef<MigrationResourcePlan | null>(null);
const busy = ref(false), error = ref(""), notice = ref(""), sourceFingerprint = ref("");
const tab = ref("issues"), query = ref(""), formId = ref(""), page = ref(1);
const groupFilter = ref<{ formId: string; id: string }>();
const staleSource = computed(() => !!batch.value && sourceFingerprint.value !== batch.value.source.fingerprint);
const stalePlan = computed(() => !!plan.value && (!plan.value.current || plan.value.sourceFingerprint !== sourceFingerprint.value));
const formName = (id: string) => plan.value?.forms.find(form => form.sourceId === id)?.title || "应用设置";
const groupName = (form: string, group: string) => plan.value?.access?.find(item => item.formId === form)?.groups.find(item => item.id === group)?.name || group;
const issues = computed(() => (plan.value?.issues || []).filter(item => (!formId.value || item.formId === formId.value) && (!groupFilter.value || (item.formId === groupFilter.value.formId && item.groupId === groupFilter.value.id)) && `${formName(item.formId)} ${item.version} ${item.recordId || ''} ${item.groupId || ''} ${item.groupId ? groupName(item.formId, item.groupId) : ''} ${item.fieldId || ''} ${item.message}`.includes(query.value.trim())));
const records = computed(() => (plan.value?.records || []).filter(item => (!formId.value || item.formId === formId.value) && `${formName(item.formId)} ${item.sourceId}`.includes(query.value.trim())));
const forms = computed(() => (plan.value?.forms || []).filter(item => (!formId.value || item.sourceId === formId.value) && `${item.title} ${item.sourceId}`.includes(query.value.trim())));
type AccessRow = { access: MigrationAccessSummary; group?: MigrationAccessGroupSummary };
const accessRows = computed<AccessRow[]>(() => (plan.value?.access || []).flatMap(access => [{ access }, ...access.groups.map(group => ({ access, group }))] as AccessRow[]).filter(item => (!formId.value || item.access.formId === formId.value) && `${formName(item.access.formId)} ${item.group?.id || ''} ${item.group?.name || '入口与收集设置'}`.includes(query.value.trim())));
const total = computed(() => tab.value === "issues" ? issues.value.length : tab.value === "records" ? records.value.length : tab.value === "access" ? accessRows.value.length : forms.value.length);
const switchName = (value: boolean | null) => value === null ? "需核对" : value ? "开启" : "关闭";
const actionNames = (group: MigrationAccessGroupSummary) => group.actions.map(action => groupActionNames[action]).join('、') || '尚未取得有效操作';
function showGroupIssues(row: AccessRow) { formId.value = row.access.formId; groupFilter.value = row.group ? { formId: row.access.formId, id: row.group.id } : undefined; query.value = row.group ? "" : "访问权限"; tab.value = "issues"; }
const pages = computed(() => Math.max(1, Math.ceil(total.value / 15)));
const slice = <T,>(items: T[]) => items.slice((page.value - 1) * 15, page.value * 15);
watch([tab, query, formId, groupFilter], () => page.value = 1);
watch([tab, formId], () => { if (tab.value !== "issues" || groupFilter.value?.formId !== formId.value) groupFilter.value = undefined; });
onBeforeRouteLeave(() => !busy.value);
async function run(action: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ""; notice.value = ""; try { await action(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = false; } }
async function load() {
  await run(async () => {
    sourceFingerprint.value = "";
    const next = await platformApi<MigrationBatch>(`/migration-batches/${props.batchId}`);
    if (next.source.applicationId !== props.appId) throw new Error("当前批次不属于此来源应用。");
    const saved = await platformApi<{ plan: MigrationResourcePlan | null }>(`/migration-batches/${props.batchId}/resources`);
    sourceFingerprint.value = (await readMigrationIdentities(props.appId)).fingerprint;
    batch.value = next; plan.value = saved.plan; page.value = 1;
  });
}
let command: { signature: string; requestId: string } | undefined;
async function prepare() {
  await run(async () => {
    const source = await readMigrationResources(props.appId); sourceFingerprint.value = source.fingerprint;
    if (!batch.value || staleSource.value) throw new Error("来源已变化，请先回到身份对应更新来源清单，再检查历史数据。");
    const body = { expectedBatchRevision: batch.value.revision, expectedResourceRevision: plan.value?.revision || 0, source };
    const signature = JSON.stringify(body); if (command?.signature !== signature) command = { signature, requestId: crypto.randomUUID() };
    plan.value = await platformApi<MigrationResourcePlan>(`/migration-batches/${props.batchId}/resources`, "POST", { ...body, requestId: command.requestId });
    page.value = 1; notice.value = "原始快照和检查结果已保存。未创建业务应用、记录或权限，原入口继续使用。";
  });
}
async function checkSource() { if (busy.value || !batch.value) return; try { sourceFingerprint.value = (await readMigrationIdentities(props.appId)).fingerprint; } catch (cause) { sourceFingerprint.value = ""; error.value = (cause as Error).message; } }
onMounted(() => { load(); window.addEventListener("storage", checkSource); window.addEventListener("focus", checkSource); });
onBeforeUnmount(() => { window.removeEventListener("storage", checkSource); window.removeEventListener("focus", checkSource); });
const statusNames: Record<string, string> = { draft: "原填写草稿", submitted: "原已提交", approved: "原已通过", rejected: "原已退回" };
</script>
<template>
  <BaseDialog :open="true" title="历史数据迁移检查" width="1000px" :busy="busy" @close="emit('close')">
    <div class="resource-migration">
      <p class="collab-help">保存快照会将本应用已保存的表单草稿、历史发布、记录值、权限与相关配置发送到当前协作服务，供迁移检查。原数据保留；账号凭据和独立签名密钥不在此快照中。</p>
      <p class="collab-help">按每条记录引用的历史版本检查字段，预留稳定的对象、页面、记录和明细行标识。本阶段不执行正式导入或切换入口。</p>
      <p v-if="error" class="collab-error" role="alert">{{ error }}</p><p v-if="notice" class="collab-success" role="status">{{ notice }}</p>
      <p v-if="staleSource" class="collab-error" role="alert">来源内容已变化，请先回到身份对应更新来源清单。</p>
      <p v-if="stalePlan" class="collab-notice" role="alert">以下是上次检查结果，来源或身份对应依据已变化，需要重新检查。</p>
      <template v-if="batch"><strong>{{ batch.source.applicationName }}</strong><p v-if="!plan" class="collab-help">尚未保存历史数据快照。保存后可以按表单和记录查看版本对应与待处理项。</p></template>
      <template v-if="plan">
        <div class="resource-counts"><span>{{ plan.totals.forms }} 张表单（归档 {{ plan.totals.archivedForms }}）</span><span>{{ plan.totals.versions }} 个发布版本</span><span>{{ plan.totals.records }} 条记录（删除 {{ plan.totals.deletedRecords }}）</span><span>{{ plan.totals.rows }} 行明细</span><span>{{ plan.totals.historyEvents }} 条处理轨迹</span><span>检查第 {{ plan.revision }} 版</span></div>
        <p class="collab-help">{{ plan.identityConfirmed ? '当前身份对应已确认。' : '身份对应仍需核对确认。' }} 字段校验通过仅表示本次字段转换通过，不表示流程、权限和整套应用已可导入。</p>
        <nav class="property-tabs" aria-label="历史数据检查内容"><button :class="{ active: tab === 'issues' }" @click="tab = 'issues'">待处理项 {{ plan.issues.length }}</button><button :class="{ active: tab === 'forms' }" @click="tab = 'forms'">表单与版本</button><button :class="{ active: tab === 'records' }" @click="tab = 'records'">记录与明细</button><button :class="{ active: tab === 'access' }" @click="tab = 'access'">权限与收集</button></nav>
        <div class="resource-filters"><select v-model="formId" aria-label="按表单筛选历史检查"><option value="">全部表单</option><option v-for="form in plan.forms" :key="form.sourceId" :value="form.sourceId">{{ form.title }}</option></select><input v-model="query" aria-label="搜索历史数据检查" placeholder="搜索表单、记录或问题" /></div>
        <p v-if="groupFilter" class="collab-help">权限组：{{ groupName(groupFilter.formId, groupFilter.id) }} <button class="text-button" @click="groupFilter = undefined">取消权限组筛选</button></p>
        <ol v-if="tab === 'issues'" class="resource-list"><li v-for="(item,index) in slice(issues)" :key="index"><strong>{{ formName(item.formId) }} · {{ item.version }}{{ item.recordId ? ` · 记录 ${item.recordId}` : '' }}{{ item.groupId ? ` · ${groupName(item.formId, item.groupId)}` : '' }}</strong><p>{{ item.message }}</p><small v-if="item.fieldId">字段 {{ item.fieldId }}{{ item.rowIndex === undefined ? '' : ` · 原第 ${item.rowIndex + 1} 行` }}</small></li></ol>
        <ol v-else-if="tab === 'forms'" class="resource-list"><li v-for="form in slice(forms)" :key="form.sourceId"><strong>{{ form.title }}{{ form.archived ? '（原已归档）' : '' }}</strong><p>草稿字段：{{ form.draftChecked ? '校验通过' : '需处理' }}</p><p v-for="version in form.versions" :key="version.sourceVersion">原 V{{ version.sourceVersion }} → 目标 V{{ version.targetVersion }} · {{ version.variants > 1 ? `${version.variants} 份冲突原定义` : version.checked ? '字段校验通过' : '字段需处理' }}</p><details><summary>查看资源对应</summary><p>原表单：{{ form.sourceId }}</p><p>数据对象：{{ form.definitionId }}</p><p>默认页面：{{ form.pageId }}</p></details></li></ol>
        <template v-else-if="tab === 'access'">
          <p class="collab-help">保留原权限组的独立选择、合并设置与分操作字段范围。以下仅检查配置；权限、公开填写和收集限制尚未接入执行。</p>
          <p v-if="!plan.access" class="collab-notice">这份历史检查尚未包含权限组转换，请保存新的快照并检查。原快照保持不变。</p>
          <ol class="resource-list">
            <li v-for="(row,index) in slice(accessRows)" :key="`${row.access.formId}/${row.group?.id || 'settings'}/${index}`">
              <strong>{{ formName(row.access.formId) }} · {{ row.group?.name || (row.group ? '未命名权限组' : '入口与收集设置') }}</strong>
              <template v-if="row.group">
                <p>{{ row.group.checked ? '组配置转换通过' : '组配置需处理' }} · 原启用：{{ switchName(row.group.enabled) }} · 原归档：{{ row.group.archived === null ? '需核对' : row.group.archived ? '是' : '否' }}</p>
                <p>操作：{{ actionNames(row.group) }} · 记录范围：{{ row.group.scope ? groupScopeNames[row.group.scope] : '需核对' }}</p>
                <p>权限对象 {{ row.group.subjects }} 项，已对应 {{ row.group.mappedSubjects }} 项（历史身份 {{ row.group.historicalSubjects }} 项）；字段规则 {{ row.group.fields }} 项，筛选条件 {{ row.group.filters }} 项。</p>
                <p v-if="row.group.historicalSubjects" class="collab-help">历史身份只保留来源，不生成账号或获得权限。</p>
                <button v-if="plan.issues.some(issue => issue.formId === row.access.formId && issue.groupId === row.group?.id)" class="text-button" @click="showGroupIssues(row)">查看本组待处理项</button>
              </template>
              <template v-else>
                <p>{{ row.access.checked ? '整份权限配置转换通过' : '整份权限配置需处理' }} · 原成员入口：{{ switchName(row.access.membersEnabled) }} · 原公开入口：{{ switchName(row.access.publicEnabled) }}</p>
                <p>权限组：{{ row.access.allowMerged === null ? '合并规则需核对' : row.access.allowMerged ? '可选择单组或显式合并适用组' : '选择一个权限组，不叠加多个组' }}。</p>
                <template v-if="row.access.filling">
                  <p>原收集状态：{{ switchName(row.access.filling.enabled) }} · 上限：{{ row.access.filling.limit || '不限' }} · 重复填写：{{ row.access.filling.allowRepeat ? '允许' : '不允许' }}</p>
                  <p>原开始时间：{{ row.access.filling.startsAt || '不限' }} · 原结束时间：{{ row.access.filling.endsAt || '不限' }}</p>
                </template>
                <p v-else>收集规则需核对，未按默认规则放行。</p>
                <button class="text-button" @click="showGroupIssues(row)">查看权限待处理项</button>
              </template>
            </li>
          </ol>
        </template>
        <ol v-else class="resource-list"><li v-for="(record,index) in slice(records)" :key="`${record.sourceId}/${index}`"><strong>{{ formName(record.formId) }} · V{{ record.version }}</strong><p>{{ statusNames[record.status] || record.status }}{{ record.deleted ? ' · 原已删除' : '' }} · {{ record.rows.length }} 行明细 · {{ record.checked ? '字段与身份格式校验通过' : '需处理' }}</p><p>原记录：{{ record.sourceId }}</p><details><summary>查看记录与行对应</summary><p>目标记录：{{ record.targetId }}</p><p v-for="row in record.rows" :key="`${row.fieldId}/${row.index}`">{{ row.fieldId }} · {{ row.sourceRowId ? `原行 ${row.sourceRowId}` : `原第 ${row.index + 1} 行（无原行标识）` }} → {{ row.targetId }}</p></details></li></ol>
        <p v-if="!total" class="collab-help">没有匹配项。</p>
        <div class="resource-pagination"><span>共 {{ total }} 项 · {{ page }} / {{ pages }} 页</span><button class="button" :disabled="page <= 1" @click="page--">上一页</button><button class="button" :disabled="page >= pages" @click="page++">下一页</button></div>
      </template>
    </div>
    <template #footer><span class="collab-help">{{ busy ? '正在保存和检查…' : '原应用继续使用' }}</span><button class="button" @click="emit('close')">关闭</button><button class="button" :disabled="busy" @click="load">重新读取检查</button><button class="button primary" :disabled="!batch || busy || staleSource" @click="prepare">保存快照并检查</button></template>
  </BaseDialog>
</template>
<style scoped>
.resource-migration { display: grid; gap: 12px; min-width: 0; font-size: 13px; }
.resource-migration p { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.resource-counts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: #f3f6f9; padding: 12px; border-radius: 5px; }
.resource-filters,.resource-pagination { display: flex; flex-wrap: wrap; gap: 8px; }
.resource-filters > * { flex: 1 1 160px; min-width: 0; }
.resource-list { list-style: none; margin: 0; padding: 0; }
.resource-list li { display: grid; gap: 8px; border-bottom: 1px solid #e6ebf0; padding: 12px 0; overflow-wrap: anywhere; }
.resource-list small { color: #718092; }
.resource-list details p { padding: 5px 0; }
.resource-list summary { cursor: pointer; color: #43566b; }
.resource-pagination { justify-content: flex-end; align-items: center; }
.resource-pagination > span { margin-right: auto; }
@media (max-width:600px) { .resource-counts { grid-template-columns: 1fr 1fr; } .property-tabs { flex-wrap: wrap; } }
</style>
