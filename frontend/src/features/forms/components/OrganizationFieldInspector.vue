<script setup lang="ts">
import { computed } from "vue";
import IdentityInput from "../../../components/organization/IdentityInput.vue";
import { type FormField, type FormSchema } from "../../../domain/form";
import { defaultLinkLocalFields } from "../../../domain/relations";
import type {
  OrganizationFieldConfig,
  SelectionScope,
} from "../../../domain/organization";
import { useWorkspaceStore } from "../../../stores/workspace";
const props = defineProps<{ field: FormField; schema: FormSchema }>();
const emit = defineEmits<{ update: [value: Partial<FormField>] }>();
const store = useWorkspaceStore();
const config = computed(() => props.field.organization),
  isDepartment = computed(() => props.field.type.startsWith("department")),
  multiple = computed(() =>
    ["members", "departments"].includes(props.field.type),
  );
const dependencies = computed(() =>
  defaultLinkLocalFields(props.schema.fields, props.field.id).filter((f) =>
    ["department", "departments"].includes(f.type),
  ),
);
function patch(value: Partial<OrganizationFieldConfig>) {
  emit("update", { organization: { ...config.value, ...value } });
}
function scope(value: Partial<SelectionScope>) {
  patch({ scope: { ...config.value.scope, ...value } });
}
function role(id: string, checked: boolean) {
  scope({
    roleIds: checked
      ? [...config.value.scope.roleIds, id]
      : config.value.scope.roleIds.filter((r) => r !== id),
  });
}
</script>
<template>
  <div class="form-group">
    <label>选择范围</label
    ><select
      :value="config.scope.mode"
      aria-label="组织选择范围"
      @change="
        scope({
          mode: ($event.target as HTMLSelectElement)
            .value as SelectionScope['mode'],
        })
      "
    >
      <option value="all">全部{{ isDepartment ? "部门" : "成员" }}</option>
      <option value="custom">指定范围</option>
      <option value="currentDepartment">当前成员所在部门</option>
      <option value="fieldDepartment">由表单中的部门字段决定</option></select
    ><template v-if="config.scope.mode === 'custom'"
      ><label class="spaced-label">指定部门</label
      ><IdentityInput
        :model-value="config.scope.departmentIds"
        kind="department"
        multiple
        label="配置可选部门范围"
        @update:model-value="scope({ departmentIds: $event as string[] })"
      /><template v-if="!isDepartment"
        ><label class="spaced-label">指定成员</label
        ><IdentityInput
          :model-value="config.scope.employeeIds"
          multiple
          label="配置可选成员范围"
          @update:model-value="scope({ employeeIds: $event as string[] })"
        /><label class="spaced-label">指定角色</label>
        <div class="config-check-list">
          <label
            v-for="item in store.data.organization.roles.filter(
              (r) => !r.archived,
            )"
            :key="item.id"
            ><input
              type="checkbox"
              :checked="config.scope.roleIds.includes(item.id)"
              @change="
                role(item.id, ($event.target as HTMLInputElement).checked)
              "
            />{{ item.name }}</label
          >
        </div>
        <p class="field-hint">部门、成员与角色范围取并集。</p></template
      ></template
    ><select
      v-if="config.scope.mode === 'fieldDepartment'"
      class="spaced-control"
      :value="config.scope.fieldId"
      aria-label="依赖部门字段"
      @change="scope({ fieldId: ($event.target as HTMLSelectElement).value })"
    >
      <option value="">选择部门字段</option>
      <option
        v-if="
          config.scope.fieldId &&
          !dependencies.some((f) => f.id === config.scope.fieldId)
        "
        :value="config.scope.fieldId"
        disabled
      >
        原字段不在当前可用范围
      </option>
      <option v-for="f in dependencies" :key="f.id" :value="f.id">
        {{ f.pathLabel }}
      </option></select
    ><label v-if="config.scope.mode !== 'all'" class="checkbox-line"
      ><input
        type="checkbox"
        :checked="config.scope.includeChildren"
        @change="
          scope({
            includeChildren: ($event.target as HTMLInputElement).checked,
          })
        "
      />包含下级部门</label
    >
  </div>
  <div class="form-group">
    <label>默认值</label
    ><select
      :value="config.defaultMode"
      aria-label="组织字段默认值方式"
      @change="
        patch({
          defaultMode: ($event.target as HTMLSelectElement)
            .value as OrganizationFieldConfig['defaultMode'],
          defaultIds: [],
        })
      "
    >
      <option value="none">
        指定{{ isDepartment ? "部门" : "成员" }} / 无
      </option>
      <option v-if="!isDepartment" value="currentUser">当前成员</option>
      <option v-if="isDepartment" value="currentDepartment">
        当前成员主部门
      </option>
      <option v-if="!isDepartment" value="departmentManager">
        当前成员主部门负责人
      </option></select
    ><IdentityInput
      v-if="config.defaultMode === 'none'"
      class="spaced-control"
      :model-value="config.defaultIds"
      :kind="isDepartment ? 'department' : 'member'"
      :multiple="multiple"
      label="组织字段默认值"
      @update:model-value="
        patch({
          defaultIds: Array.isArray($event) ? $event : $event ? [$event] : [],
        })
      "
    />
    <p class="field-hint">默认值仍受选择范围约束。</p>
  </div>
</template>
