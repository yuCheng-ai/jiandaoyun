<script setup lang="ts">
import { computed, ref } from "vue";
import {
  isMultipleChoice,
  organizationSubjectMembers,
  type FormField,
  type OrganizationIdentity,
  type PageSummary,
  type ProcessTemplateDraft,
  type ProcessTemplateSpec,
  type ProcessTemplateTask,
  type ServerOrganization,
} from "@platform/contracts";
import AppIcon from "./AppIcon.vue";
import BaseDialog from "./BaseDialog.vue";
import FieldPermissionEditor from "./FieldPermissionEditor.vue";
import ServerFieldControl from "../features/collaboration/ServerFieldControl.vue";

const props = defineProps<{
  task?: ProcessTemplateTask;
  selectedId: string;
  spec: ProcessTemplateSpec;
  saved?: ProcessTemplateDraft;
  tab: string;
  fields: FormField[];
  pages: PageSummary[];
  organization?: ServerOrganization;
  formLinked: boolean;
}>();
const emit = defineEmits<{
  "update:tab": [value: string];
  page: [task: ProcessTemplateTask];
  disable: [];
}>();
const terminalDescription = computed(() => {
  if (props.selectedId === "end") return "所有办理节点完成后，流程结束。";
  if (props.formLinked) return "成员提交此表单时发起流程，保存草稿不会发起。";
  return "在工作台选择本人记录发起流程。";
});
const detailTab = ref("rules");
const memberOpen = ref(false);
const memberQuery = ref("");
const memberKind = ref<"member" | "department" | "role">("member");
const memberId = ref("");
const includeChildren = ref(true);
const memberKinds = [
  { id: "member", label: "成员" },
  { id: "department", label: "部门" },
  { id: "role", label: "角色" },
] as const;
const detailTabs = [
  { id: "fields", label: "字段权限" },
  { id: "actions", label: "节点操作" },
  { id: "rules", label: "流转规则" },
];
const candidates = computed(() => {
  let values: { id: string; name: string }[];
  if (memberKind.value === "member")
    values = props.organization?.users.filter((item) => item.active) || [];
  else if (memberKind.value === "department")
    values =
      props.organization?.spec.departments.filter((item) => !item.archived) ||
      [];
  else
    values =
      props.organization?.spec.roles.filter((item) => !item.archived) || [];
  return values.filter((item) => item.name.includes(memberQuery.value.trim()));
});
const owner = computed(() => {
  const task = props.task;
  if (!task) return "";
  let values: { id: string; name: string }[] | undefined =
    props.organization?.users;
  if (task.assigneeSelector?.kind === "department")
    values = props.organization?.spec.departments;
  if (task.assigneeSelector?.kind === "role")
    values = props.organization?.spec.roles;
  const id = task.assigneeSelector?.id || task.assigneeId;
  if (!id) return "";
  return (
    values?.find((item) => item.id === id)?.name || "原负责人（请重新选择）"
  );
});
const memberCount = computed(() => {
  if (!props.task?.assigneeSelector || !props.organization) return 0;
  const ids = new Set(
    organizationSubjectMembers(
      props.organization.spec,
      props.task.assigneeSelector,
    ),
  );
  return props.organization.users.filter(
    (user) => user.active && ids.has(user.id),
  ).length;
});
function openMembers() {
  memberKind.value = props.task?.assigneeSelector?.kind || "member";
  memberId.value =
    props.task?.assigneeSelector?.id || props.task?.assigneeId || "";
  includeChildren.value = props.task?.assigneeSelector?.includeChildren ?? true;
  memberQuery.value = "";
  memberOpen.value = true;
}
function confirmMembers() {
  if (
    !props.task ||
    !candidates.value.some((item) => item.id === memberId.value)
  )
    return;
  if (memberKind.value === "member") {
    props.task.assigneeId = memberId.value;
    props.task.assigneeSelector = undefined;
  } else {
    props.task.assigneeId = "";
    props.task.assigneeSelector = {
      kind: memberKind.value,
      id: memberId.value,
      includeChildren: includeChildren.value,
    };
  }
  memberOpen.value = false;
}
const waitFields = computed(() =>
  props.fields.flatMap((field) => {
    if (field.type !== "subform") return [field];
    if (field.id === props.task?.subformId) return field.children;
    return [];
  }),
);
const waitField = computed(() =>
  waitFields.value.find((field) => field.id === props.task?.waitFor?.fieldId),
);
const identities = computed<OrganizationIdentity[]>(() => [
  ...(props.organization?.users || []).map((user) => ({
    ...user,
    kind: "member" as const,
  })),
  ...(props.organization?.spec.departments || []).map((dept) => ({
    ...dept,
    active: !dept.archived,
    kind: "department" as const,
  })),
]);
function toggleWait(enabled: boolean) {
  if (!props.task) return;
  props.task.waitFor = enabled
    ? { recordBinding: props.task.recordBinding, fieldId: "", equals: "" }
    : undefined;
}
function changeWaitField() {
  if (!props.task?.waitFor) return;
  const field = waitField.value;
  props.task.waitFor.equals = field?.type === "number" ? 0 : "";
  if (isMultipleChoice(field?.type || "")) props.task.waitFor.equals = [];
  props.task.waitFor.subformId = props.fields.find((parent) =>
    parent.children.some((child) => child.id === field?.id),
  )?.id;
}
function changeScope() {
  if (!props.task) return;
  props.task.requiredFields = [];
  props.task.waitFor = undefined;
}
</script>

<template>
  <aside class="property-panel" aria-label="属性配置">
    <div class="property-tabs" role="tablist" aria-label="属性类型">
      <button
        v-for="item in [
          { id: 'node', label: '节点属性' },
          { id: 'flow', label: '流程属性' },
        ]"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        :class="{ active: tab === item.id }"
        @click="emit('update:tab', item.id)"
      >
        {{ item.label }}
      </button>
    </div>
    <div v-if="tab === 'node' && task" :key="task.id" class="property-content">
      <div class="form-group node-name-group">
        <div class="label-line">
          <label for="node-name"><span class="required">*</span>节点名称</label>
        </div>
        <input id="node-name" v-model="task.title" maxlength="100" />
      </div>
      <div class="form-group owner-group">
        <label
          ><span class="required">*</span
          >{{ task.kind === "copy" ? "抄送成员" : "节点负责人" }}</label
        >
        <button class="member-picker" @click="openMembers">
          <span v-if="owner" class="member-chip"
            ><AppIcon name="approval" :size="12" />{{ owner }}</span
          >
          <span v-else>选择成员、部门或角色</span
          ><AppIcon name="add" :size="16" />
        </button>
        <p v-if="task.assigneeSelector" class="field-hint">
          当前包含 {{ memberCount }} 位启用成员。{{
            task.kind === "copy"
              ? "流程到达后逐一抄送。"
              : "所有负责人完成后进入下一节点。"
          }}
        </p>
      </div>
      <div class="segmented detail-tabs" role="tablist" aria-label="节点配置">
        <button
          v-for="item in detailTabs"
          :key="item.id"
          role="tab"
          :aria-selected="detailTab === item.id"
          :class="{ active: detailTab === item.id }"
          @click="detailTab = item.id"
        >
          {{ item.label }}
        </button>
      </div>
      <FieldPermissionEditor
        v-if="detailTab === 'fields'"
        :task="task"
        :fields="fields"
      />
      <template v-else-if="detailTab === 'rules'">
        <div class="form-group">
          <label for="node-page">办理表单</label>
          <div class="select-wrap">
            <select
              id="node-page"
              v-model="task.pageId"
              @change="emit('page', task)"
            >
              <option value="">请选择已发布表单</option>
              <option v-for="page in pages" :key="page.id" :value="page.id">
                {{ page.title }}
              </option></select
            ><AppIcon name="down" />
          </div>
        </div>
        <div v-if="task.kind !== 'copy'" class="form-group">
          <label for="node-scope">办理范围</label>
          <div class="select-wrap">
            <select
              id="node-scope"
              v-model="task.subformId"
              @change="changeScope"
            >
              <option :value="undefined">整条记录</option>
              <option
                v-for="field in fields.filter(
                  (item) => item.type === 'subform',
                )"
                :key="field.id"
                :value="field.id"
              >
                {{ field.label }}逐行办理
              </option></select
            ><AppIcon name="down" />
          </div>
        </div>
        <div class="form-group">
          <label>节点流转条件</label>
          <p
            class="field-hint"
            v-if="
              !task.dependsOn.length && !spec.startTaskIds?.includes(task.id)
            "
          >
            尚未连接前置节点，连通流程后才能启用。
          </p>
          <p class="field-hint" v-else-if="!task.dependsOn.length">
            提交表单后进入此节点。
          </p>
          <p class="field-hint" v-else>
            等待
            {{
              task.dependsOn
                .map(
                  (id) =>
                    spec.tasks.find((item) => item.id === id)?.title ||
                    "原节点",
                )
                .join("、")
            }}
            全部完成。
          </p>
          <p class="field-hint">
            拖动画布连线调整节点顺序。必填项在“字段权限”中设置。
          </p>
        </div>
        <div class="form-group">
          <label class="checkbox-line"
            ><input
              type="checkbox"
              :checked="!!task.waitFor"
              @change="toggleWait(($event.target as HTMLInputElement).checked)"
            />同时等待字段满足条件</label
          >
          <template v-if="task.waitFor">
            <div class="select-wrap">
              <select
                v-model="task.waitFor.fieldId"
                aria-label="等待字段"
                @change="changeWaitField"
              >
                <option value="">请选择字段</option>
                <option
                  v-for="field in waitFields"
                  :key="field.id"
                  :value="field.id"
                >
                  {{ field.label }}
                </option></select
              ><AppIcon name="down" />
            </div>
            <label class="wait-value">等于</label>
            <ServerFieldControl
              v-if="waitField"
              :field="waitField"
              :identities="identities"
              :model-value="task.waitFor.equals"
              input-id="process-wait-value"
              label="等待值"
              @update:model-value="
                task.waitFor!.equals = $event as
                  string | number | boolean | string[]
              "
            />
            <p class="field-hint">未满足时停留等待，不会自动跳过此节点。</p>
          </template>
        </div>
      </template>
      <template v-else>
        <label class="standalone-label">当前可用操作</label>
        <div class="node-action-list">
          <div
            v-for="action in task.kind === 'copy'
              ? ['查看记录']
              : ['保存办理内容', '完成办理', '转交']"
            :key="action"
            class="node-action-row"
          >
            <span>{{ action }}</span
            ><AppIcon name="check" :size="16" />
          </div>
        </div>
        <p class="field-hint">
          {{
            task.kind === "copy"
              ? "抄送自动送达，仅可查看。"
              : "仅当前负责人可以办理。转交对象须有这条记录的查看和编辑权限。"
          }}
        </p>
      </template>
    </div>
    <div v-else-if="tab === 'node' && !selectedId" class="empty-properties">
      <AppIcon name="locate" :size="28" />
      <p>选择节点以编辑属性</p>
    </div>
    <div v-else-if="tab === 'node'" class="property-content">
      <div class="terminal-info">
        <AppIcon
          :name="selectedId === 'end' ? 'end' : 'start'"
          :size="32"
        /><strong>{{
          selectedId === "end" ? "流程结束节点" : "流程发起节点"
        }}</strong>
        <p>
          {{ terminalDescription }}
        </p>
      </div>
      <p v-if="selectedId !== 'end'" class="field-hint">
        发起权限和填写权限在表单发布中设置。
      </p>
      <button class="button full-width" @click="emit('update:tab', 'flow')">
        设置流程属性
      </button>
    </div>
    <div v-else class="property-content flow-properties">
      <div class="form-group">
        <label for="flow-title">流程名称</label
        ><input id="flow-title" v-model="spec.title" maxlength="100" />
      </div>
      <div class="flow-summary">
        <span
          >当前版本<strong>{{
            saved?.latestVersion ? `V${saved.latestVersion}` : "未启用"
          }}</strong></span
        ><span
          >流程节点<strong>{{ spec.tasks.length }} 个</strong></span
        >
      </div>
      <p class="field-hint">
        保存只更新草稿；启用后，新提交按新版本执行，已有流程保持原版本。
      </p>
      <button
        v-if="saved?.latestVersion && saved.enabled"
        class="button full-width"
        @click="emit('disable')"
      >
        停用流程
      </button>
      <p v-if="saved?.latestVersion && !saved.enabled" class="field-hint">
        流程已停用，已有待办仍可继续办理。
      </p>
    </div>
  </aside>
  <BaseDialog
    :open="memberOpen"
    title="选择节点负责人"
    width="560px"
    @close="memberOpen = false"
  >
    <div class="segmented detail-tabs">
      <button
        v-for="kind in memberKinds"
        :key="kind.id"
        :class="{ active: memberKind === kind.id }"
        @click="
          memberKind = kind.id;
          memberId = '';
          memberQuery = '';
        "
      >
        {{ kind.label }}
      </button>
    </div>
    <div class="field-search">
      <AppIcon name="search" :size="15" /><input
        v-model="memberQuery"
        aria-label="搜索负责人"
        placeholder="搜索"
      />
    </div>
    <div class="workflow-member-list">
      <label v-for="item in candidates" :key="item.id" class="picker-result"
        ><input
          v-model="memberId"
          type="radio"
          name="workflow-owner"
          :value="item.id"
          :aria-label="`选择${item.name}`"
        /><span class="person-avatar">{{ item.name.slice(0, 1) }}</span
        ><span>{{ item.name }}</span></label
      >
      <p v-if="!candidates.length" class="field-hint">
        没有符合条件的{{
          memberKinds.find((kind) => kind.id === memberKind)?.label
        }}。
      </p>
    </div>
    <label v-if="memberKind === 'department'" class="checkbox-line"
      ><input v-model="includeChildren" type="checkbox" />包含下级部门</label
    >
    <template #footer
      ><button class="button" @click="memberOpen = false">取消</button
      ><button
        class="button primary"
        :disabled="!candidates.some((item) => item.id === memberId)"
        @click="confirmMembers"
      >
        确定
      </button></template
    >
  </BaseDialog>
</template>
