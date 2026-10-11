<script setup lang="ts">
import AppIcon from "../../components/AppIcon.vue";
import { useRoleApplications } from "../../composables/useRoleApplications";
import type { RoleGrant, GrantAction } from "../../domain/organization";
const props = defineProps<{ modelValue: RoleGrant[] }>();
const emit = defineEmits<{ "update:modelValue": [grants: RoleGrant[]] }>();
const catalog = useRoleApplications();
function patch(index: number, value: Partial<RoleGrant>) {
  emit(
    "update:modelValue",
    props.modelValue.map((g, i) => (i === index ? { ...g, ...value } : g)),
  );
}
function action(index: number, key: GrantAction, checked: boolean) {
  const g = props.modelValue[index]!;
  patch(index, {
    actions: checked
      ? [...new Set([...g.actions, key])]
      : g.actions.filter((a) => a !== key),
  });
}
function form(index: number, id: string, checked: boolean) {
  const g = props.modelValue[index]!;
  patch(index, {
    formIds: checked
      ? [...new Set([...g.formIds, id])]
      : g.formIds.filter((f) => f !== id),
  });
}
</script>
<template>
  <div class="role-grants">
    <p class="field-hint">
      每条授权分别限定操作和数据范围。管理数据允许查看、编辑和删除；表单已启用权限组时，以表单权限组为准。
    </p>
    <p v-if="catalog.loading.value" class="field-hint" role="status">
      正在读取应用…
    </p>
    <p v-if="catalog.error.value" class="field-error" role="alert">
      {{ catalog.error.value }}
      <button type="button" class="text-button" @click="catalog.load">
        重新读取
      </button>
    </p>
    <article
      v-for="(grant, index) in modelValue"
      :key="index"
      class="role-grant-card"
    >
      <header>
        <strong>授权 {{ index + 1 }}</strong
        ><button
          type="button"
          class="icon-button"
          :aria-label="`删除授权${index + 1}`"
          @click="
            emit(
              'update:modelValue',
              modelValue.filter((_, i) => i !== index),
            )
          "
        >
          <AppIcon name="trash" />
        </button>
      </header>
      <div class="admin-form-grid">
        <label
          >应用<select
            :value="grant.appId"
            :aria-label="`授权${index + 1}应用`"
            @change="
              patch(index, {
                appId: ($event.target as HTMLSelectElement).value,
                formIds: [],
              })
            "
          >
            <option value="*">全部应用</option>
            <option
              v-for="app in catalog.applications.value"
              :key="app.id"
              :value="app.sourceId === grant.appId ? app.sourceId : app.id"
            >
              {{ app.name }}
            </option>
            <option
              v-if="grant.appId !== '*' && !catalog.find(grant.appId)"
              :value="grant.appId"
            >
              原应用（暂不可用）
            </option>
          </select></label
        ><label
          >数据范围<select
            :value="grant.dataScope"
            :aria-label="`授权${index + 1}数据范围`"
            @change="
              patch(index, {
                dataScope: ($event.target as HTMLSelectElement)
                  .value as RoleGrant['dataScope'],
              })
            "
          >
            <option value="self">本人提交的数据</option>
            <option value="department">所在部门的数据</option>
            <option value="all">全部数据</option>
          </select></label
        >
      </div>
      <div class="role-grant-actions">
        <label
          v-for="item in [
            { key: 'view', label: '查看表单' },
            { key: 'submit', label: '填写提交' },
            { key: 'manage', label: '管理数据' },
          ]"
          :key="item.key"
          ><input
            type="checkbox"
            :checked="grant.actions.includes(item.key as GrantAction)"
            :aria-label="`授权${index + 1} ${item.label}`"
            @change="
              action(
                index,
                item.key as GrantAction,
                ($event.target as HTMLInputElement).checked,
              )
            "
          />{{ item.label }}</label
        >
      </div>
      <details v-if="grant.appId !== '*'" class="grant-form-select">
        <summary>
          {{
            grant.formIds.length
              ? `指定 ${grant.formIds.length} 张表单`
              : "全部表单"
          }}
        </summary>
        <p class="field-hint">不勾选表示该应用全部表单。</p>
        <label v-for="f in catalog.forms(grant.appId)" :key="f.id"
          ><input
            type="checkbox"
            :checked="grant.formIds.includes(f.id)"
            @change="
              form(index, f.id, ($event.target as HTMLInputElement).checked)
            "
          />{{ f.title }}</label
        >
      </details>
      <p
        v-if="
          grant.appId !== '*' && catalog.find(grant.appId)?.connected === false
        "
        class="field-hint"
      >
        此应用尚未接入账号访问，原授权保留。
      </p>
      <p
        v-if="
          grant.formIds.some(
            (id) => !catalog.forms(grant.appId).some((form) => form.id === id),
          )
        "
        class="field-hint"
      >
        部分原表单暂不可用，已保留其授权选择。
      </p>
    </article>
    <div v-if="!modelValue.length" class="empty-grants">
      暂无授权，成员仍可能通过其他角色获得权限。
    </div>
    <button
      type="button"
      class="button"
      @click="
        emit('update:modelValue', [
          ...modelValue,
          {
            appId: '*',
            formIds: [],
            actions: ['view', 'submit'],
            dataScope: 'self',
          },
        ])
      "
    >
      <AppIcon name="add" />添加授权
    </button>
  </div>
</template>
