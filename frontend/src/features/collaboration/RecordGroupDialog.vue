<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import {
  groupActionNames,
  groupScopeNames,
  type RecordGroupConfiguration,
  type RecordPermissionGroup,
  type ServerDefinition,
  type ServerOrganization,
  type RelationDefinition,
  type DataFilter,
} from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { platformApi, PlatformError } from "../../repositories/platformApi";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
const props = defineProps<{ definition: ServerDefinition }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const state = ref<RecordGroupConfiguration>({
    revision: 0,
    mode: "direct",
    allowMerged: false,
    groups: [],
  }),
  org = ref<ServerOrganization>();
const relations = ref<RelationDefinition[]>([]);
const selected = ref(""),
  busy = ref(false),
  loaded = ref(false),
  error = ref(""),
  conflict = ref(false),
  reloadConfirm = ref(false);
const group = computed(() =>
  state.value.groups.find((g) => g.id === selected.value),
);
const { requestClose, confirmDiscard, discard, markSaved } = useDraftDismiss(
  () => true,
  () => state.value,
  () => emit("close"),
);
onBeforeRouteLeave(() => {
  requestClose();
  return false;
});
async function load() {
  busy.value = true;
  error.value = "";
  try {
    const [config, directory, links] = await Promise.all([
      platformApi<RecordGroupConfiguration>(
        `/definitions/${props.definition.id}/permission-groups`,
      ),
      platformApi<ServerOrganization>("/organization"),
      platformApi<RelationDefinition[]>(
        `/relations?definitionId=${props.definition.id}`,
      ),
    ]);
    relations.value = (links || []).filter((link) => link.latestVersion);
    state.value = config;
    org.value = directory;
    selected.value = config.groups[0]?.id || "";
    loaded.value = true;
    conflict.value = false;
    reloadConfirm.value = false;
    markSaved();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
const fields = computed(() =>
  props.definition.schema.fields.flatMap((f) => [
    { field: f, label: f.label },
    ...f.children.map((c) => ({ field: c, label: `${f.label} / ${c.label}` })),
  ]),
);
const mainFields = computed(() =>
  props.definition.schema.fields.filter((f) => f.type !== "subform"),
);
const subjectKind = ref<"member" | "department" | "role">("member"),
  subjectId = ref("");
const subjects = computed(() =>
  subjectKind.value === "member"
    ? org.value?.users.filter((u) => u.active && u.role !== "admin") || []
    : subjectKind.value === "department"
      ? org.value?.spec.departments.filter((d) => !d.archived) || []
      : org.value?.spec.roles.filter((r) => !r.archived) || [],
);
const subjectName = (s: RecordPermissionGroup["subjects"][number]) =>
  (s.kind === "member"
    ? org.value?.users
    : s.kind === "department"
      ? org.value?.spec.departments
      : org.value?.spec.roles
  )?.find((item) => item.id === s.id)?.name || "原权限对象";
function addGroup() {
  const next: RecordPermissionGroup = {
    id: `group_${crypto.randomUUID().replaceAll("-", "")}`,
    name: "新权限组",
    enabled: true,
    archived: false,
    subjects: [],
    actions: ["view"],
    scope: "all",
    filters: [],
    fields: {},
    relations: {},
  };
  state.value.groups.push(next);
  selected.value = next.id;
}
function addSubject() {
  if (
    !group.value ||
    !subjectId.value ||
    group.value.subjects.some(
      (s) => s.kind === subjectKind.value && s.id === subjectId.value,
    )
  )
    return;
  group.value.subjects.push({
    kind: subjectKind.value,
    id: subjectId.value,
    ...(subjectKind.value === "department" ? { includeChildren: false } : {}),
  });
  subjectId.value = "";
}
const filterField = (filter: DataFilter) =>
  mainFields.value.find((field) => field.id === filter.sourceFieldId);
const filterChoices = (filter: DataFilter) => {
  const field = filterField(filter);
  if (!field) return undefined;
  if (["member", "members"].includes(field.type))
    return org.value?.users
      .filter((u) => u.active)
      .map((u) => ({ id: u.id, label: u.name }));
  if (["department", "departments"].includes(field.type))
    return org.value?.spec.departments
      .filter((d) => !d.archived)
      .map((d) => ({ id: d.id, label: d.name }));
  if (["select", "radio", "checkbox", "multiselect"].includes(field.type))
    return field.options;
  return undefined;
};
function addFilter() {
  group.value?.filters.push({
    id: `filter_${crypto.randomUUID().replaceAll("-", "")}`,
    sourceFieldId: mainFields.value[0]?.id || "",
    source: "constant",
    operator: "equals",
    value: "",
  });
}
function reconcileActions(action: keyof typeof groupActionNames) {
  const current = group.value;
  if (!current) return;
  if (action === 'view' && !current.actions.includes('view')) current.actions = current.actions.filter(item => item === 'create');
  else if (!['create', 'view'].includes(action) && current.actions.includes(action) && !current.actions.includes('view')) current.actions.push('view');
}
async function save() {
  if (!loaded.value) return;
  busy.value = true;
  error.value = "";
  try {
    state.value = await platformApi<RecordGroupConfiguration>(
      `/definitions/${props.definition.id}/permission-groups`,
      "PUT",
      {
        expectedRevision: state.value.revision,
        mode: state.value.mode,
        allowMerged: state.value.allowMerged,
        groups: state.value.groups,
      },
    );
    markSaved();
    emit("saved");
  } catch (cause) {
    error.value = (cause as Error).message;
    conflict.value = cause instanceof PlatformError && cause.status === 409;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <BaseDialog
    :open="true"
    title="权限组管理"
    width="850px"
    :busy="busy"
    @close="requestClose"
  >
    <p class="collab-help">
      权限组分别定义成员能处理哪些记录和字段。启用后按所选组执行，原按成员、部门或角色直接设置的授权保留，切回原模式才恢复适用。
    </p>
    <p class="collab-notice">
      支持新增、自己的草稿及已有记录的操作。收集时间、数量限制和流程任务固定权限组仍待接入。
    </p>
    <p v-if="error" class="collab-error" role="alert">
      {{ error }}
      <button v-if="conflict" class="text-button" @click="reloadConfirm = true">
        重新读取权限组
      </button>
    </p>
    <p v-if="reloadConfirm" class="collab-notice">
      重新读取会替换当前未保存修改。<button
        class="button"
        @click="reloadConfirm = false"
      >
        继续编辑</button
      ><button class="button" @click="load">放弃修改并读取</button>
    </p>
    <p v-if="confirmDiscard" class="collab-notice" tabindex="-1">
      有未保存的权限修改。<button
        class="button"
        @click="confirmDiscard = false"
      >
        继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </p>
    <template v-if="loaded">
      <label class="collab-field"
        >授权模式<select v-model="state.mode">
          <option value="direct">按成员、部门和角色授权</option>
          <option value="groups">按权限组授权</option>
        </select></label
      >
      <label class="checkbox-line"
        ><input
          v-model="state.allowMerged"
          type="checkbox"
        />允许成员选择合并适用的权限组</label
      >
      <div class="collab-toolbar">
        <label class="collab-field"
          >选择权限组<select v-model="selected">
            <option v-if="!state.groups.length" value="">尚无权限组</option>
            <option
              v-for="item in state.groups"
              :key="item.id"
              :value="item.id"
            >
              {{ item.name }}{{ item.archived ? "（已归档）" : "" }}
            </option>
          </select></label
        ><button class="button" @click="addGroup">新建权限组</button>
      </div>
      <template v-if="group">
        <label class="collab-field"
          >权限组名称<input v-model="group.name" maxlength="100"
        /></label>
        <div class="collab-toolbar">
          <label
            ><input v-model="group.enabled" type="checkbox" /> 启用此组</label
          ><label
            ><input v-model="group.archived" type="checkbox" /> 归档此组</label
          >
        </div>
        <h3>权限对象</h3>
        <div class="collab-toolbar">
          <select
            v-model="subjectKind"
            aria-label="权限对象类别"
            @change="subjectId = ''"
          >
            <option value="member">成员</option>
            <option value="department">部门</option>
            <option value="role">角色</option></select
          ><select v-model="subjectId" aria-label="选择权限组对象">
            <option value="">请选择</option>
            <option v-for="item in subjects" :key="item.id" :value="item.id">
              {{ item.name }}
            </option></select
          ><button class="button" :disabled="!subjectId" @click="addSubject">
            添加对象
          </button>
        </div>
        <div
          v-for="(subject, index) in group.subjects"
          :key="`${subject.kind}/${subject.id}`"
          class="collab-toolbar"
        >
          <span>{{ subjectName(subject) }}</span
          ><label v-if="subject.kind === 'department'"
            ><input v-model="subject.includeChildren" type="checkbox" />
            包含下级部门成员</label
          ><button
            class="text-button"
            :aria-label="`移除${subjectName(subject)}`"
            @click="group.subjects.splice(index, 1)"
          >
            移除
          </button>
        </div>
        <h3>操作和记录范围</h3>
        <div class="collab-toolbar">
          <label
            v-for="action in [
              'create',
              'view',
              'edit',
              'delete',
              'export',
              'print',
            ] as const"
            :key="action"
            ><input
              v-model="group.actions"
              type="checkbox"
              :value="action"
              @change="reconcileActions(action)"
            />
            {{
              action === "delete" ? "归档记录" : groupActionNames[action]
            }}</label
          >
        </div>
        <p class="collab-help">只勾选添加时，成员可以填写、保存自己的草稿和提交，不能查看正式记录。编辑、归档、导出及打印需要查看权限。</p>
        <template v-if="group.actions.includes('view')">
        <label class="collab-field"
          >权限组记录范围<select v-model="group.scope">
            <option
              v-for="(label, value) in groupScopeNames"
              :key="value"
              :value="value"
            >
              {{ label }}
            </option>
          </select></label
        >
        <p v-if="group.scope === 'department'" class="collab-help">
          按记录创建时部门匹配当前成员部门，不包含下级部门记录；与上方的权限对象资格分别计算。
        </p>
        <template v-if="group.scope === 'custom' || group.filters.length">
          <p class="collab-help">
            自定义范围要求以下条件全部满足。切换为其他范围时保留条件，但暂不用于筛选。
          </p>
          <div
            v-for="(filter, index) in group.filters"
            :key="filter.id"
            class="group-filter-row"
          >
            <select
              v-model="filter.sourceFieldId"
              :aria-label="`条件${index + 1}字段`"
            >
              <option
                v-for="field in mainFields"
                :key="field.id"
                :value="field.id"
              >
                {{ field.label }}
              </option></select
            ><select
              v-model="filter.operator"
              :aria-label="`条件${index + 1}关系`"
            >
              <option value="equals">等于</option>
              <option value="notEquals">不等于</option>
              <option value="contains">包含</option>
              <option value="notEmpty">不为空</option>
              <option value="greater">大于</option>
              <option value="less">小于</option></select
            ><select
              v-model="filter.source"
              :aria-label="`条件${index + 1}来源`"
            >
              <option value="constant">固定值</option>
              <option
                v-if="
                  ['member', 'members'].includes(
                    filterField(filter)?.type || '',
                  )
                "
                value="currentUser"
              >
                当前成员
              </option>
              <option
                v-if="
                  ['department', 'departments'].includes(
                    filterField(filter)?.type || '',
                  )
                "
                value="currentDepartment"
              >
                当前主部门
              </option></select
            ><select
              v-if="
                filter.source === 'constant' &&
                filter.operator !== 'notEmpty' &&
                filterChoices(filter)
              "
              v-model="filter.value"
              :aria-label="`条件${index + 1}固定值`"
            >
              <option value="">请选择</option>
              <option
                v-for="item in filterChoices(filter)"
                :key="item.id"
                :value="item.id"
              >
                {{ item.label }}
              </option></select
            ><input
              v-else-if="
                filter.source === 'constant' && filter.operator !== 'notEmpty'
              "
              v-model="filter.value"
              :aria-label="`条件${index + 1}固定值`"
            /><button
              class="text-button"
              :aria-label="`移除条件${index + 1}`"
              @click="group.filters.splice(index, 1)"
            >
              移除
            </button>
          </div>
          <button class="button" @click="addFilter">添加筛选条件</button>
        </template>
        </template>
        <h3>字段与明细列</h3>
        <p class="collab-help">
          未授予的字段保持隐藏。可编辑在新增时需要本组允许添加，修改正式记录时需要本组允许编辑；所属明细也须可编辑。合并多个组时，各操作只使用授予该操作的组字段。
        </p>
        <table class="collab-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>本组权限</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in fields" :key="item.field.id">
              <td>{{ item.label }}</td>
              <td>
                <select
                  :aria-label="`${item.label}组权限`"
                  :value="group.fields[item.field.id] || 'hidden'"
                  @change="
                    group.fields[item.field.id] = (
                      $event.target as HTMLSelectElement
                    ).value as 'hidden' | 'read' | 'edit'
                  "
                >
                  <option value="hidden">隐藏</option>
                  <option value="read">只读</option>
                  <option value="edit">可编辑</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
        <template v-if="relations.length"
          ><h3>关联操作</h3>
          <p class="collab-help">
            建立关系仍需拥有两端记录及回填字段的相应权限。
          </p>
          <table class="collab-table">
            <thead>
              <tr>
                <th>关系</th>
                <th>本组权限</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="relation in relations" :key="relation.id">
                <td>{{ relation.spec.title }}</td>
                <td>
                  <select
                    :aria-label="`${relation.spec.title}组关系权限`"
                    :value="group.relations[relation.id] || 'hidden'"
                    @change="
                      group.relations[relation.id] = (
                        $event.target as HTMLSelectElement
                      ).value as 'hidden' | 'read' | 'edit'
                    "
                  >
                    <option value="hidden">隐藏</option>
                    <option value="read">查看关联</option>
                    <option value="edit">建立与解除关联</option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table></template
        >
      </template>
    </template>
    <template #footer
      ><button class="button" @click="requestClose">取消</button
      ><button v-if="!loaded" class="button" @click="load">重新读取</button
      ><button class="button primary" :disabled="!loaded || busy" @click="save">
        保存权限组配置
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.group-filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}
.group-filter-row > * {
  min-width: 0;
  flex: 1 1 120px;
}
.group-filter-row button {
  flex: 0 0 auto;
}
</style>
