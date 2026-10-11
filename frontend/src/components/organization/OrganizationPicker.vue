<script setup lang="ts">
import { useRuntimeData } from "../../composables/useRuntimeData";
import { computed, ref, watch } from "vue";
import BaseDialog from "../BaseDialog.vue";
import AppIcon from "../AppIcon.vue";
import DepartmentTree from "./DepartmentTree.vue";
import {
  allowedDepartments,
  allowedEmployees,
  departmentPath,
  descendants,
  emptyScope,
  identityLabel,
  roleMembers,
  type SelectionScope,
} from "../../domain/organization";
import type { FormValues } from "../../domain/form";
const props = withDefaults(
  defineProps<{
    open: boolean;
    modelValue: string[];
    kind?: "member" | "department" | "mixed";
    multiple?: boolean;
    title?: string;
    scope?: SelectionScope;
    values?: FormValues;
    allowRoles?: boolean;
  }>(),
  { kind: "member", multiple: true, values: () => ({}), allowRoles: true },
);
const emit = defineEmits<{ "update:modelValue": [ids: string[]]; close: [] }>();
const runtimeData = useRuntimeData();
const org = computed(() => runtimeData.value.organization);
const query = ref(""),
  treeQuery = ref(""),
  treeTab = ref("department"),
  departmentId = ref(""),
  roleId = ref(""),
  selected = ref<string[]>([]);
const scope = computed(() => props.scope || emptyScope());
const eligibleMembers = computed(() =>
  allowedEmployees(org.value, scope.value, props.values),
);
const eligibleDepartments = computed(() =>
  allowedDepartments(org.value, scope.value, props.values),
);
const activeRoles = computed(() => org.value.roles.filter((r) => !r.archived));
const candidates = computed(() => {
  let employees = eligibleMembers.value;
  let departments = eligibleDepartments.value;
  if (departmentId.value) {
    const ids = new Set(descendants(org.value, departmentId.value));
    employees = employees.filter((e) =>
      e.departmentIds.some((id) => ids.has(id)),
    );
    departments = departments.filter((d) => ids.has(d.id));
  }
  if (treeTab.value === "role" && roleId.value) {
    const role = activeRoles.value.find((r) => r.id === roleId.value);
    const ids = new Set(
      role ? roleMembers(org.value, role).map((e) => e.id) : [],
    );
    employees = employees.filter((e) => ids.has(e.id));
  }
  const rows: { id: string; label: string; detail: string; kind: string }[] =
    [];
  if (
    props.kind === "department" ||
    (props.kind === "mixed" && treeTab.value === "department")
  )
    rows.push(
      ...departments.map((d) => ({
        id: d.id,
        label: d.name,
        detail: departmentPath(org.value, d.id),
        kind: "department",
      })),
    );
  if (props.kind !== "department")
    rows.push(
      ...employees.map((e) => ({
        id: e.id,
        label: e.name,
        detail: `${e.number} · ${e.departmentIds.map((id) => identityLabel(org.value, id)).join("、")}`,
        kind: "member",
      })),
    );
  if (props.kind === "mixed" && treeTab.value === "role" && props.allowRoles)
    rows.unshift(
      ...activeRoles.value
        .filter((r) => !roleId.value || r.id === roleId.value)
        .map((r) => ({
          id: r.id,
          label: r.name,
          detail: `角色 · ${roleMembers(org.value, r).length} 位成员`,
          kind: "role",
        })),
    );
  const text = query.value.trim().toLowerCase();
  return rows.filter(
    (r) =>
      !text ||
      `${r.label} ${r.detail} ${org.value.employees.find((e) => e.id === r.id)?.email || ""}`
        .toLowerCase()
        .includes(text),
  );
});
const eligibleIds = computed(
  () =>
    new Set([
      ...(props.kind === "department"
        ? []
        : eligibleMembers.value.map((e) => e.id)),
      ...(props.kind === "member"
        ? []
        : eligibleDepartments.value.map((d) => d.id)),
      ...(props.kind === "mixed" && props.allowRoles
        ? activeRoles.value.map((r) => r.id)
        : []),
    ]),
);
watch(
  () => props.open,
  (open) => {
    if (open) {
      selected.value = [...props.modelValue];
      query.value = "";
      treeQuery.value = "";
      departmentId.value = "";
      roleId.value = "";
      treeTab.value = "department";
    }
  },
  { immediate: true },
);
function toggle(id: string) {
  if (!eligibleIds.value.has(id)) return;
  selected.value = selected.value.includes(id)
    ? selected.value.filter((v) => v !== id)
    : props.multiple
      ? [...selected.value, id]
      : [id];
}
function allVisible() {
  const ids = candidates.value.map((r) => r.id);
  selected.value = ids.every((id) => selected.value.includes(id))
    ? selected.value.filter((id) => !ids.includes(id))
    : [...new Set([...selected.value, ...ids])];
}
function confirm() {
  emit(
    "update:modelValue",
    selected.value
      .filter((id) => eligibleIds.value.has(id))
      .slice(0, props.multiple ? undefined : 1),
  );
  emit("close");
}
</script>
<template>
  <BaseDialog
    :open="open"
    :title="
      title ||
      (kind === 'department'
        ? '选择部门'
        : kind === 'mixed'
          ? '选择成员、部门或角色'
          : '选择成员')
    "
    width="860px"
    @close="emit('close')"
  >
    <div class="organization-picker">
      <aside class="picker-tree-panel">
        <div class="segmented-control">
          <button
            :class="{ active: treeTab === 'department' }"
            @click="
              treeTab = 'department';
              roleId = '';
            "
          >
            部门</button
          ><button
            v-if="kind !== 'department' && allowRoles"
            :class="{ active: treeTab === 'role' }"
            @click="
              treeTab = 'role';
              departmentId = '';
            "
          >
            角色
          </button>
        </div>
        <div class="search-input">
          <AppIcon name="search" /><input
            v-model="treeQuery"
            placeholder="搜索组织"
            aria-label="搜索选择器组织"
          />
        </div>
        <template v-if="treeTab === 'department'"
          ><button
            class="picker-all-row"
            :class="{ active: !departmentId }"
            @click="departmentId = ''"
          >
            {{ kind === "department" ? "全部部门" : "全部成员" }}</button
          ><DepartmentTree
            :departments="org.departments"
            :selected-id="departmentId"
            :query="treeQuery"
            @select="departmentId = $event"
        /></template>
        <template v-else
          ><button
            class="picker-all-row"
            :class="{ active: !roleId }"
            @click="roleId = ''"
          >
            全部角色</button
          ><template v-for="group in org.roleGroups" :key="group.id"
            ><div class="picker-group-title">{{ group.name }}</div>
            <button
              v-for="role in activeRoles.filter(
                (r) => r.groupId === group.id && r.name.includes(treeQuery),
              )"
              :key="role.id"
              class="picker-all-row"
              :class="{ active: roleId === role.id }"
              @click="roleId = role.id"
            >
              <AppIcon name="people" />{{ role.name }}
            </button></template
          ></template
        >
      </aside>
      <section class="picker-candidates">
        <div class="search-input">
          <AppIcon name="search" /><input
            v-model="query"
            placeholder="搜索姓名、工号或部门"
            aria-label="搜索可选成员或部门"
          />
        </div>
        <div class="picker-list-heading">
          <span>{{ candidates.length }} 个可选项</span
          ><button
            v-if="multiple && candidates.length"
            class="text-button"
            @click="allVisible"
          >
            {{
              candidates.every((r) => selected.includes(r.id))
                ? "取消全选"
                : "全选当前结果"
            }}
          </button>
        </div>
        <div class="picker-results">
          <label v-for="item in candidates" :key="item.id" class="picker-result"
            ><input
              :type="multiple ? 'checkbox' : 'radio'"
              name="organization-pick"
              :checked="selected.includes(item.id)"
              :aria-label="`选择${item.label}`"
              @change="toggle(item.id)"
            /><span class="person-avatar" :class="item.kind"
              ><AppIcon
                v-if="item.kind !== 'member'"
                :name="item.kind === 'role' ? 'people' : 'department'"
              /><template v-else>{{ item.label.slice(0, 1) }}</template></span
            ><span
              ><b>{{ item.label }}</b
              ><small>{{ item.detail }}</small></span
            ></label
          >
          <div v-if="!candidates.length" class="picker-empty">
            暂无符合范围的{{
              kind === "department" ? "部门" : "成员"
            }}，请调整筛选条件
          </div>
        </div>
      </section>
      <aside class="picker-selected">
        <div class="picker-list-heading">
          <span>已选 {{ selected.length }}</span
          ><button class="text-button" @click="selected = []">清空</button>
        </div>
        <div
          v-for="id in selected"
          :key="id"
          class="selected-identity"
          :class="{ unavailable: !eligibleIds.has(id) }"
        >
          <span
            >{{ identityLabel(org, id)
            }}<small v-if="!eligibleIds.has(id)"
              >不在可选范围，将不保存</small
            ></span
          ><button
            class="icon-button"
            :aria-label="`移除${identityLabel(org, id)}`"
            @click="selected = selected.filter((v) => v !== id)"
          >
            <AppIcon name="close" :size="14" />
          </button>
        </div>
        <p v-if="!selected.length" class="picker-empty">从左侧选择</p>
      </aside>
    </div>
    <div v-if="selected.length" class="picker-mobile-selected">
      <span>已选 {{ selected.length }}</span
      ><button
        v-for="id in selected"
        :key="id"
        type="button"
        :aria-label="`移除已选${identityLabel(org, id)}`"
        @click="selected = selected.filter((value) => value !== id)"
      >
        {{ identityLabel(org, id) }}<AppIcon name="close" :size="12" /></button
      ><button type="button" class="text-button" @click="selected = []">
        清空已选
      </button>
    </div>
    <template #footer
      ><span class="dialog-footer-hint">{{
        multiple ? "可选择多个" : "仅选择一个"
      }}</span
      ><button class="button" @click="emit('close')">取消</button
      ><button class="button primary" @click="confirm">确定</button></template
    >
  </BaseDialog>
</template>
