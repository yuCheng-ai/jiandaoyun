<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { migrationIdentityKey, type MigrationBatch, type MigrationBatchEvent, type MigrationIdentityChoice, type MigrationIdentityReview, type MigrationIdentitySource, type ServerOrganization } from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import ServerIdentitySelect from "../../components/organization/ServerIdentitySelect.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi } from "../../repositories/platformApi";
import { readMigrationIdentities } from "../../repositories/migrationIdentities";
const MigrationResourcesDialog = defineAsyncComponent(() => import("./MigrationResourcesDialog.vue"));
const resourcesOpen = ref(false);
const props = defineProps<{ appId: string }>();
const emit = defineEmits<{ close: [] }>();
const source = shallowRef<MigrationIdentitySource>(), batch = shallowRef<MigrationBatch>(), directory = shallowRef<ServerOrganization>();
const batches = shallowRef<MigrationBatch[]>([]), events = shallowRef<MigrationBatchEvent[]>([]), review = shallowRef<MigrationIdentityReview>();
const choices = ref<MigrationIdentityChoice[]>([]), baseline = ref(""), busy = ref(false), error = ref(""), directoryError = ref(""), notice = ref("");
const query = ref(""), page = ref(1), kind = ref(""), pending = ref<"reload" | "refresh" | "">(""), otherReopen = shallowRef<MigrationBatch>();
const dirty = computed(() => JSON.stringify(choices.value) !== baseline.value && !!batch.value);
const stale = computed(() => !!batch.value && source.value?.fingerprint !== batch.value.source.fingerprint);
const editable = computed(() => !!batch.value && batch.value.state === "draft" && !busy.value && !stale.value);
const names = { member: "成员", department: "部门", role: "角色" };
const filtered = computed(() => (batch.value?.source.identities || source.value?.identities || []).filter(item => (!kind.value || item.kind === kind.value) && `${item.name} ${item.sourceId}`.includes(query.value.trim())));
const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 15)));
const visible = computed(() => filtered.value.slice((page.value - 1) * 15, page.value * 15));
watch([query, kind], () => page.value = 1);
watch(choices, () => review.value = undefined, { deep: true, flush: "sync" });
const { requestClose, confirmDiscard, discard, markSaved } = useDraftDismiss(() => true, () => choices.value, () => emit("close"));
onBeforeRouteLeave(() => { if (busy.value) return false; if (dirty.value) { requestClose(); return false; } return true; });
const choice = (item: { kind: string; sourceId: string }) => choices.value.find(value => value.kind === item.kind && value.sourceId === item.sourceId)!;
function setChoice(item: { kind: string; sourceId: string }, mode: MigrationIdentityChoice["mode"], targetId?: string) {
  if (!editable.value) return;
  const current = choice(item); current.mode = mode; delete current.targetId; if (mode === "existing" && targetId) current.targetId = targetId;
  notice.value = "";
}
const options = (kind: string) => !directory.value ? [] : kind === "member" ? directory.value.users.map(user => ({ ...user, name: `${user.name}（${user.username}）` })) : (kind === "department" ? directory.value.spec.departments : directory.value.spec.roles).map(item => ({ ...item, active: !item.archived }));
const decisionName = (item: MigrationIdentityChoice) => item.mode === "unresolved" ? "尚未决定" : item.mode === "historical" ? "保留历史身份" : options(item.kind).find(value => value.id === item.targetId)?.name || "目标待读取或已不存在";
function apply(next: MigrationBatch) { batch.value = next; choices.value = JSON.parse(JSON.stringify(next.choices)); baseline.value = JSON.stringify(choices.value); markSaved(); review.value = undefined; }
let command: { signature: string; requestId: string } | undefined;
async function mutate(path: string, method: string, body: object) {
  const signature = JSON.stringify({ path, method, body });
  if (command?.signature !== signature) command = { signature, requestId: crypto.randomUUID() };
  return platformApi<MigrationBatch>(path, method, { ...body, requestId: command.requestId });
}
async function run(action: () => Promise<void>) {
  if (busy.value) return; busy.value = true; error.value = ""; notice.value = "";
  try { await action(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = false; }
}
async function readDirectory() {
  directoryError.value = "";
  try { directory.value = await platformApi<ServerOrganization>("/organization"); } catch (cause) { directoryError.value = (cause as Error).message; }
}
async function readBatches() {
  batches.value = await platformApi<MigrationBatch[]>(`/migration-batches?namespace=${encodeURIComponent(source.value!.namespace)}`);
}
async function readEvents() {
  if (!batch.value) return;
  try { events.value = await platformApi<MigrationBatchEvent[]>(`/migration-batches/${batch.value.id}/events`); } catch { notice.value = "对应已读取或保存，操作记录暂时无法读取，可重新读取后查看。"; }
}
async function load() {
  await run(async () => {
    const current = await readMigrationIdentities(props.appId);
    const saved = await platformApi<MigrationBatch[]>(`/migration-batches?namespace=${encodeURIComponent(current.namespace)}&applicationId=${encodeURIComponent(props.appId)}`);
    source.value = current;
    if (saved[0]) apply(saved[0]); else { batch.value = undefined; choices.value = []; baseline.value = "[]"; markSaved(); }
    pending.value = ""; await readDirectory(); await readBatches(); await readEvents();
  });
}
async function currentSource() {
  source.value = await readMigrationIdentities(props.appId);
  if (stale.value) { review.value = undefined; throw new Error("来源内容已变化，请先更新来源清单；原身份对应仍保留。"); }
}
async function create() { await run(async () => { source.value = await readMigrationIdentities(props.appId); apply(await mutate("/migration-batches", "POST", { source: source.value })); await readBatches(); await readEvents(); notice.value = "身份对应草稿已建立，请逐项决定；同名身份没有自动关联。"; }); }
async function saveDraft() {
  await currentSource(); const value = batch.value!;
  // Incomplete drafts can be saved; existing mode needs an explicitly selected identity.
  if (choices.value.some(item => item.mode === "existing" && !item.targetId)) throw new Error("请选择现有身份，或将未决定的项改回“尚未决定”。");
  apply(await mutate(`/migration-batches/${value.id}`, "PUT", { expectedRevision: value.revision, sourceFingerprint: value.source.fingerprint, choices: choices.value }));
  await readEvents();
}
async function save() { await run(async () => { await saveDraft(); notice.value = "身份对应草稿已保存。"; }); }
async function inspect() {
  await run(async () => {
    if (dirty.value) await saveDraft(); else await currentSource();
    const value = batch.value!;
    review.value = await platformApi<MigrationIdentityReview>(`/migration-batches/${value.id}/review`, "POST", { expectedRevision: value.revision, sourceFingerprint: value.source.fingerprint });
    await readDirectory(); await readBatches();
  });
}
async function confirm() {
  const checked = review.value; if (!checked || checked.blockers.length || dirty.value) return;
  await run(async () => {
    await currentSource(); const value = batch.value!;
    apply(await mutate(`/migration-batches/${value.id}/confirm-identities`, "POST", { expectedRevision: value.revision, sourceFingerprint: value.source.fingerprint, token: checked.token }));
    await readEvents(); await readBatches(); notice.value = "本批次身份对应已确认。业务数据、权限和流程尚未导入，原应用继续使用。";
  });
}
async function reopen(value = batch.value!) {
  await run(async () => {
    const next = await mutate(`/migration-batches/${value.id}/reopen`, "POST", { expectedRevision: value.revision });
    if (next.id === batch.value?.id) { apply(next); await readEvents(); }
    otherReopen.value = undefined; review.value = undefined; await readBatches(); notice.value = `已撤销「${value.source.applicationName}」的身份确认，对应草稿保留。`;
  });
}
async function refresh() {
  await run(async () => {
    const current = await readMigrationIdentities(props.appId), value = batch.value!;
    apply(await mutate(`/migration-batches/${value.id}/source`, "POST", { expectedRevision: value.revision, source: current }));
    source.value = current; pending.value = ""; page.value = 1; await readEvents(); await readBatches();
    notice.value = "来源已更新，同一身份的已保存决定保留，新增身份需要重新核对。";
  });
}
function requestReload() { if (dirty.value) pending.value = "reload"; else load(); }
function requestRefresh() { pending.value = "refresh"; }
async function checkSource() {
  if (busy.value || !source.value) return;
  try { source.value = await readMigrationIdentities(props.appId); if (stale.value) review.value = undefined; } catch (cause) { review.value = undefined; error.value = (cause as Error).message; }
}
onMounted(() => { load(); window.addEventListener("storage", checkSource); window.addEventListener("focus", checkSource); });
onBeforeUnmount(() => { window.removeEventListener("storage", checkSource); window.removeEventListener("focus", checkSource); });
const actionNames = { create: "建立草稿", save: "保存对应", refresh_source: "更新来源", confirm_identities: "确认身份", reopen: "撤销确认" };
</script>
<template>
  <BaseDialog :open="true" title="迁移身份对应" width="960px" :busy="busy" @close="requestClose">
    <div class="migration-identities">
      <p class="collab-help">核对旧应用引用的成员、部门、角色及关联组织身份。建立草稿会保存名称、身份标识、状态与资源数量；业务记录内容保留在原应用。</p>
      <p class="collab-help">关联现有身份需要逐项确认。保留历史身份会先预留标识，确认后保存独立历史档案，供迁移记录显示原身份；不创建账号、不启用权限或待办。</p>
      <p v-if="error" class="collab-error" role="alert">{{ error }}</p><p v-if="notice" class="collab-success" role="status">{{ notice }}</p>
      <div v-if="confirmDiscard" class="config-discard collab-notice" tabindex="-1">对应决定尚未保存。<button class="button" @click="confirmDiscard = false">继续编辑</button><button class="button" @click="discard">放弃修改并关闭</button></div>
      <div v-if="pending" class="collab-notice" role="alert">{{ pending === 'refresh' ? '更新来源将采用最新已保存的应用内容，保留相同身份的已保存决定；当前未保存决定会被替换。' : '重新读取会替换当前未保存的决定。' }}<button class="button" @click="pending = ''">继续编辑</button><button class="button" @click="pending === 'refresh' ? refresh() : load()">{{ pending === 'refresh' ? '更新来源并重新核对' : '放弃修改并读取' }}</button></div>
      <template v-if="source">
        <div class="identity-heading"><strong>{{ source.applicationName }}</strong><span>{{ batch ? batch.state === 'identities_confirmed' ? '身份对应已确认' : '身份对应草稿' : '尚未建立对应草稿' }}</span><span>{{ (batch?.source || source).identities.length }} 个身份</span></div>
        <p v-if="stale" class="collab-error" role="alert">来源工作空间已变化，当前对应依据已过期。{{ batch?.state === 'identities_confirmed' ? '请撤销身份确认后更新来源。' : '请更新来源清单后重新检查。' }}</p>
        <p v-if="batch?.state === 'identities_confirmed'" class="collab-help">仅确认身份对应，尚未导入业务数据或切换原应用。执行导入前仍需重新核对组织与来源。</p>
        <p v-if="batch" class="collab-help">可以继续检查旧记录的版本、字段与明细行对应。<button class="text-button" :disabled="busy || dirty || stale" @click="resourcesOpen = true">检查历史数据</button><span v-if="dirty">请先保存当前身份决定。</span></p>
        <p v-if="directoryError" class="collab-error" role="alert">{{ directoryError }}<button class="text-button" @click="readDirectory">重试读取组织</button></p>
        <div class="identity-filters"><input v-model="query" aria-label="搜索来源身份" placeholder="搜索名称或来源标识" /><select v-model="kind" aria-label="身份类别"><option value="">全部类别</option><option v-for="(label, value) in names" :key="value" :value="value">{{ label }}</option></select></div>
        <ol class="identity-list">
          <li v-for="item in visible" :key="migrationIdentityKey(item)">
            <div><strong>{{ item.name }}</strong><span class="collab-help">{{ names[item.kind] }} · {{ !item.found ? '原目录缺失' : item.active ? '使用中' : '已停用或归档' }}</span><small>来源标识：{{ item.sourceId }}</small></div>
            <div v-if="batch" class="identity-decision"><select :value="choice(item).mode" :disabled="!editable" :aria-label="`${item.name}对应方式`" @change="setChoice(item, ($event.target as HTMLSelectElement).value as MigrationIdentityChoice['mode'])"><option value="unresolved">尚未决定</option><option value="existing">关联现有{{ names[item.kind] }}</option><option value="historical">保留历史身份</option></select>
              <ServerIdentitySelect v-if="choice(item).mode === 'existing'" :model-value="choice(item).targetId" :options="options(item.kind)" include-inactive :disabled="!editable" :error="directoryError" :label="`为${item.name}选择${names[item.kind]}`" @retry="readDirectory" @update:model-value="setChoice(item, 'existing', String($event))" />
              <span v-else class="collab-help">{{ decisionName(choice(item)) }}</span>
            </div><span v-else class="collab-help">建立草稿后逐项配置</span>
          </li>
        </ol>
        <p v-if="!visible.length" class="collab-help">没有匹配的来源身份。</p>
        <div class="identity-pagination"><span>{{ page }} / {{ totalPages }} 页</span><button class="button" :disabled="page <= 1" @click="page--">上一页</button><button class="button" :disabled="page >= totalPages" @click="page++">下一页</button></div>
        <section v-if="review" class="identity-review" aria-label="身份对应检查结果">
          <strong>检查结果：关联现有 {{ review.counts.existing }} 项，保留历史 {{ review.counts.historical }} 项，未决定 {{ review.counts.unresolved }} 项</strong>
          <p v-if="batch?.state === 'identities_confirmed'" :class="review.confirmationCurrent ? 'collab-success' : 'collab-error'">{{ review.confirmationCurrent ? '身份确认依据仍有效。' : '组织或其他对应已变化，请撤销确认后重新核对。' }}</p>
          <ul v-if="review.blockers.length" class="collab-error"><li v-for="blocker in review.blockers" :key="blocker">{{ blocker }}</li></ul>
          <details><summary>查看逐项对应与注意事项</summary><p v-for="item in review.items" :key="migrationIdentityKey(item.source)">{{ item.source.name }} → {{ item.targetName || '尚未决定' }}（{{ names[item.source.kind] }}）<span v-for="warning in item.warnings" :key="warning"> · {{ warning }}</span></p></details>
          <button v-if="batch?.state === 'draft'" class="button primary" :disabled="busy || stale || dirty || !!review.blockers.length" @click="confirm">确认本批次身份对应</button>
        </section>
        <details v-if="batches.some(item => item.id !== batch?.id)"><summary>同一来源的其他应用对应</summary><div v-for="item in batches.filter(value => value.id !== batch?.id)" :key="item.id" class="identity-other"><span>{{ item.source.applicationName }} · {{ item.state === 'identities_confirmed' ? '已确认' : '草稿' }}</span><button v-if="item.state === 'identities_confirmed'" class="text-button" @click="otherReopen = item">撤销此应用身份确认</button></div></details>
        <div v-if="otherReopen" class="collab-notice" role="alert">撤销「{{ otherReopen.source.applicationName }}」的身份确认后，原对应草稿保留，需要重新检查确认。<button class="button" @click="otherReopen = undefined">取消</button><button class="button" @click="reopen(otherReopen)">确认撤销</button></div>
        <details v-if="events.length"><summary>操作记录</summary><p v-for="event in events" :key="event.id">{{ actionNames[event.action] }} · {{ event.actorName }} · {{ new Date(event.createdAt).toLocaleString() }} · 第 {{ event.revision }} 版</p></details>
      </template>
    </div>
    <template #footer><span class="collab-help">{{ busy ? '正在处理…' : dirty ? '有未保存的对应决定' : '业务数据与原入口保留' }}</span><button class="button" @click="requestClose">关闭</button><button class="button" :disabled="busy" @click="requestReload">重新读取</button><button v-if="source && !batch" class="button primary" :disabled="busy" @click="create">建立身份对应草稿</button><template v-if="batch"><button v-if="batch.state === 'identities_confirmed'" class="button" :disabled="busy" @click="reopen()">撤销身份确认</button><template v-else><button class="button" :disabled="busy" @click="requestRefresh">更新来源清单</button><button class="button" :disabled="busy || stale" @click="save">保存对应草稿</button></template><button class="button primary" :disabled="busy || stale" @click="inspect">检查身份对应</button></template></template>
  </BaseDialog>
  <MigrationResourcesDialog v-if="resourcesOpen && batch" :app-id="appId" :batch-id="batch.id" @close="resourcesOpen = false" />
</template>
<style scoped>
.migration-identities { display: grid; gap: 12px; min-width: 0; font-size: 13px; }
.migration-identities p { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.identity-heading,.identity-filters,.identity-pagination,.identity-other { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.identity-heading { padding: 10px; background: #f3f6f9; border-radius: 5px; }
.identity-heading span { color: #627184; }
.identity-filters input { flex: 1; min-width: 120px; }
.identity-list { list-style: none; padding: 0; margin: 0; }
.identity-list li { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 12px 0; border-bottom: 1px solid #e6ebf0; }
.identity-list li > div { min-width: 0; display: grid; gap: 6px; align-content: start; overflow-wrap: anywhere; }
.identity-list small { color: #84909e; }
.identity-decision select { width: 100%; min-width: 0; }
.identity-pagination { justify-content: flex-end; }
.identity-review { display: grid; gap: 12px; background: #f4f7fa; padding: 12px; border-radius: 5px; }
.identity-review .button { justify-self: start; }
.identity-other { padding: 8px 0; }
details summary { cursor: pointer; color: #43566b; }
details p { padding: 6px 0; }
@media (max-width:600px) { .identity-list li { grid-template-columns: 1fr; gap: 8px; } }
</style>
