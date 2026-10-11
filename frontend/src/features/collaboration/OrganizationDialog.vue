<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { emptyOrganizationSpec, organizationSubjectMembers, type OrganizationSpec, type ServerDepartment, type ServerOrganization } from "@platform/contracts";
import ServerIdentitySelect from "../../components/organization/ServerIdentitySelect.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi, PlatformError } from "../../repositories/platformApi";
const emit = defineEmits<{ close: []; saved: [] }>();
const organization = ref<ServerOrganization>(), spec = ref<OrganizationSpec>(emptyOrganizationSpec()), tab = ref('departments'), query = ref('');
const busy = ref(false), error = ref(''), notice = ref(''), conflict = ref(false), reloadConfirm = ref(false), baseline = ref('');
const dirty = computed(() => !!organization.value && JSON.stringify(spec.value) !== baseline.value);
const { requestClose, confirmDiscard, discard, markSaved } = useDraftDismiss(() => true, () => spec.value, () => emit('close'));
onBeforeRouteLeave(() => { if (busy.value) return false; if (dirty.value) { requestClose(); return false; } return true; });
const departments = computed(() => spec.value.departments.filter(item => !item.archived));
const members = computed(() => (organization.value?.users || []).filter(user => `${user.name} ${user.username}`.includes(query.value.trim())));
const assignment = (id: string) => spec.value.assignments.find(item => item.userId === id)!;
const name = (id: string) => organization.value?.users.find(user => user.id === id)?.name || '已不可用成员';
async function load() {
  busy.value = true; error.value = '';
  try {
    organization.value = await platformApi<ServerOrganization>('/organization'); spec.value = JSON.parse(JSON.stringify(organization.value.spec));
    for (const user of organization.value.users) if (!spec.value.assignments.some(item => item.userId === user.id)) spec.value.assignments.push({ userId: user.id, departmentIds: [], primaryDepartmentId: null });
    baseline.value = JSON.stringify(spec.value); markSaved(); conflict.value = false; reloadConfirm.value = false;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(load);
async function save() {
  if (!organization.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    organization.value = await platformApi<ServerOrganization>('/organization', 'PUT', { expectedRevision: organization.value.revision, spec: spec.value });
    spec.value = JSON.parse(JSON.stringify(organization.value.spec)); baseline.value = JSON.stringify(spec.value); markSaved(); conflict.value = false;
    notice.value = '组织配置已保存，成员授权与后续流程取人立即按新配置计算。已发出的任务保留原处理人。'; emit('saved');
  } catch (cause) { error.value = (cause as Error).message; conflict.value = cause instanceof PlatformError && cause.status === 409; }
  finally { busy.value = false; }
}
function uniqueName(original: string, names: string[]) { let candidate = original, n = 2; while (names.includes(candidate)) candidate = `${original} ${n++}`; return candidate; }
function addDepartment() { spec.value.departments.push({ id: crypto.randomUUID(), name: uniqueName('新部门', departments.value.map(item => item.name)), parentId: null, archived: false }); }
function addGroup() { spec.value.roleGroups.push({ id: crypto.randomUUID(), name: uniqueName('新角色组', spec.value.roleGroups.map(item => item.name)) }); }
function addRole() {
  if (!spec.value.roleGroups.length) addGroup();
  spec.value.roles.push({ id: crypto.randomUUID(), groupId: spec.value.roleGroups[0]!.id, name: uniqueName('新角色', spec.value.roles.map(item => item.name)), description: '', memberIds: [], departmentIds: [], includeChildren: true, archived: false });
}
function archiveDepartment(department: ServerDepartment) {
  error.value = '';
  if (!department.archived) {
    if (spec.value.departments.some(item => item.parentId === department.id && !item.archived)) { error.value = '请先调整或归档下级部门。'; return; }
    if (spec.value.assignments.some(item => item.departmentIds.includes(department.id))) { error.value = '该部门仍有成员，请在“成员归属”中先调整部门。'; return; }
    if (spec.value.roles.some(item => item.departmentIds.includes(department.id))) { error.value = '角色仍引用该部门，请先调整角色的部门范围。'; return; }
  } else if (department.parentId && !departments.value.some(item => item.id === department.parentId)) { error.value = '请先恢复上级部门，或选择其他上级部门。'; return; }
  department.archived = !department.archived;
}
function fixPrimary(userId: string) { const item = assignment(userId); if (!item.primaryDepartmentId || !item.departmentIds.includes(item.primaryDepartmentId)) item.primaryDepartmentId = item.departmentIds[0] || null; }
function roleMembers(roleId: string) { return organizationSubjectMembers(spec.value, { kind: 'role', id: roleId }).filter(id => organization.value?.users.some(user => user.id === id && user.active)).map(name); }
</script>
<template>
  <BaseDialog :open="true" title="组织与成员" width="1040px" :busy="busy" @close="requestClose">
    <p class="collab-help">管理登录成员的部门和业务角色。数据权限在所属应用中配置，业务角色不会获得平台管理员身份。</p>
    <p v-if="error" class="collab-error" role="alert">{{ error }} <button v-if="conflict" class="text-button" @click="reloadConfirm = true">重新读取组织</button></p><p v-if="notice" class="collab-success" role="status">{{ notice }}</p>
    <div v-if="reloadConfirm" class="collab-notice">重新读取会替换当前未保存的修改。<button class="button" @click="reloadConfirm = false">继续编辑</button><button class="button" @click="load">放弃修改并读取</button></div>
    <div v-if="confirmDiscard" class="config-discard collab-notice" tabindex="-1">组织配置尚未保存。<button class="button" @click="confirmDiscard = false">继续编辑</button><button class="button" @click="discard">放弃修改</button></div>
    <template v-if="organization">
      <nav class="organization-tabs" aria-label="组织配置"><button v-for="item in [{id:'departments',name:'部门结构'},{id:'members',name:'成员归属'},{id:'roles',name:'角色与角色组'}]" :key="item.id" class="button" :class="{primary:tab === item.id}" @click="tab = item.id">{{ item.name }}</button></nav>
      <section v-if="tab === 'departments'">
        <div class="collab-toolbar"><strong>部门结构</strong><button class="button" @click="addDepartment">新增部门</button></div>
        <p class="collab-help">部门支持上下级关系。归档前须调整其成员、下级部门和角色引用；恢复部门后，原有部门授权重新适用。</p>
        <div class="collab-table-wrap"><table class="collab-table"><thead><tr><th>部门名称</th><th>上级部门</th><th>负责人</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="(department,index) in spec.departments" :key="department.id"><td><input v-model="department.name" :aria-label="`部门 ${index + 1} 名称`" maxlength="100" /></td><td><select v-model="department.parentId" :aria-label="`部门 ${index + 1} 上级部门`"><option :value="null">无上级部门</option><option v-for="parent in departments.filter(item => item.id !== department.id)" :key="parent.id" :value="parent.id">{{ parent.name }}</option></select></td><td><ServerIdentitySelect :model-value="department.managerIds || []" :options="organization.users" :known="organization.users" multiple :label="`部门 ${index + 1} 负责人`" @update:model-value="department.managerIds = Array.isArray($event) ? $event : $event ? [$event] : []" /></td><td>{{ department.archived ? '已归档' : '使用中' }}</td><td><button class="text-button" @click="archiveDepartment(department)">{{ department.archived ? '恢复部门' : '归档部门' }}</button></td></tr></tbody></table></div>
        <p v-if="!spec.departments.length" class="collab-help">尚未配置部门，可直接新增。</p>
      </section>
      <section v-else-if="tab === 'members'">
        <label class="collab-field">搜索成员<input v-model="query" placeholder="姓名或登录名" /></label>
        <p class="collab-help">成员来自当前登录账号，可属于多个部门并指定主部门。部门数据范围按授权中选择的依据计算；调动会影响成员当前适用的授权，记录的创建部门保持不变。</p>
        <article v-for="user in members" :key="user.id" class="organization-card"><strong>{{ user.name }}</strong><span class="collab-help">{{ user.username }} · {{ user.role === 'admin' ? '平台管理员' : '普通成员' }}{{ user.active ? '' : ' · 已停用' }}</span>
          <div class="organization-options"><label v-for="department in departments" :key="department.id"><input v-model="assignment(user.id).departmentIds" type="checkbox" :value="department.id" :aria-label="`${user.name}属于${department.name}`" @change="fixPrimary(user.id)" />{{ department.name }}</label><span v-if="!departments.length" class="collab-help">请先配置部门。</span></div>
          <label class="collab-field">主部门<select v-model="assignment(user.id).primaryDepartmentId" :aria-label="`${user.name}主部门`"><option v-if="!assignment(user.id).departmentIds.length" :value="null">未分配部门</option><option v-for="id in assignment(user.id).departmentIds" :key="id" :value="id">{{ departments.find(item => item.id === id)?.name }}</option></select></label>
        </article>
      </section>
      <section v-else>
        <div class="collab-toolbar"><strong>角色组</strong><button class="button" @click="addGroup">新增角色组</button></div>
        <div class="organization-groups"><label v-for="(item,index) in spec.roleGroups" :key="item.id"><input v-model="item.name" :aria-label="`角色组 ${index + 1} 名称`" maxlength="100" /><button class="text-button" :disabled="spec.roles.some(role => role.groupId === item.id)" @click="spec.roleGroups = spec.roleGroups.filter(group => group.id !== item.id)">移除空组</button></label></div>
        <div class="collab-toolbar"><strong>业务角色</strong><button class="button" @click="addRole">新增角色</button></div>
        <article v-for="(role,index) in spec.roles" :key="role.id" class="organization-card">
          <div class="organization-role-fields"><label class="collab-field">角色名称<input v-model="role.name" :aria-label="`角色 ${index + 1} 名称`" maxlength="100" /></label><label class="collab-field">角色组<select v-model="role.groupId" :aria-label="`角色 ${index + 1} 角色组`"><option v-for="group in spec.roleGroups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label></div>
          <label class="collab-field">说明<input v-model="role.description" :aria-label="`角色 ${index + 1} 说明`" maxlength="2000" /></label>
          <strong>指定成员</strong><div class="organization-options"><label v-for="user in organization.users.filter(item => item.active)" :key="user.id"><input v-model="role.memberIds" type="checkbox" :value="user.id" :aria-label="`${role.name}包含成员${user.name}`" />{{ user.name }}</label></div>
          <strong>按部门包含成员</strong><div class="organization-options"><label v-for="department in departments" :key="department.id"><input v-model="role.departmentIds" type="checkbox" :value="department.id" :aria-label="`${role.name}包含部门${department.name}`" />{{ department.name }}</label></div>
          <label class="checkbox-line"><input v-model="role.includeChildren" type="checkbox" :aria-label="`${role.name}包括下级部门`" />包括下级部门成员</label>
          <p class="collab-help">{{ role.archived ? '角色已归档，不参与授权与取人。' : `当前成员：${roleMembers(role.id).join('、') || '暂无成员'}` }}</p>
          <button class="text-button" @click="role.archived = !role.archived">{{ role.archived ? '恢复角色' : '归档角色' }}</button>
        </article><p class="collab-help">角色归档后，其授权不再生效；恢复时重新适用原授权。成员变动不会自动改派已经发出的任务，办理时仍检查当前数据权限。</p>
      </section>
    </template>
    <template #footer><span class="collab-help">{{ dirty ? '有未保存的修改' : '已读取组织配置' }}</span><button class="button" @click="requestClose">关闭</button><button v-if="!organization" class="button" @click="load">重试</button><button class="button primary" :disabled="!organization" @click="save">保存组织配置</button></template>
  </BaseDialog>
</template>
<style scoped>
.organization-tabs,.organization-options,.organization-groups { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.organization-card { margin: 12px 0; padding: 16px; border: 1px solid #e4e8ed; border-radius: 6px; }
.organization-card > span { margin-left: 10px; }
.organization-options label { display: inline-flex; gap: 6px; align-items: center; }
.organization-role-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.organization-groups label { display: flex; align-items: center; gap: 8px; }
.collab-table input,.collab-table select { min-width: 130px; }
@media(max-width:600px) { .organization-role-fields { grid-template-columns: 1fr; gap: 0; } .organization-card { padding: 10px; } .organization-tabs { gap: 6px; } }
</style>
