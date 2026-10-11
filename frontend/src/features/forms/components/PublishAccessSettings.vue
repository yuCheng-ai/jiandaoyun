<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import { copy, uid } from "../../../domain/form";
import type { FormRecord } from "../../../domain/workspace";
import {
  accessConfig,
  accessIssues,
  defaultAccess,
  memberActions,
  type AccessGroup,
} from "../../../domain/access";
import { resolveIdentities } from "../../../domain/organization";
import { useWorkspaceStore } from "../../../stores/workspace";
import AccessGroupEditor from "./AccessGroupEditor.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
import EditorDraftNotice from "../../../components/shared/EditorDraftNotice.vue";
import { useEditorDraft } from "../../../composables/useEditorDraft";
import { restoreAccessSettingsDraft } from "../../../domain/accessDraftAdapters";
import { sameWorkspaceValue } from "../../../domain/workspaceSync";
const props = defineProps<{ form: FormRecord }>(),
  store = useWorkspaceStore(),
  router = useRouter();
const config = ref(copy(accessConfig(store.data, props.form.id))),
  initial = ref(JSON.stringify(config.value)),
  errors = ref<string[]>([]),
  editing = ref<AccessGroup>(),
  editorOpen = ref(false),
  showArchived = ref(false),
  leaving = ref(false),
  saving = ref(false),
  reloading = ref(false);
const context = () => ({
  original: accessConfig(store.data, props.form.id),
  schema: props.form.published?.schema || props.form.schema,
  member: store.data.organization.currentUserId,
});
const initialMember = ref(store.data.organization.currentUserId);
const stale = computed(
  () =>
    !sameWorkspaceValue(
      JSON.parse(initial.value),
      accessConfig(store.data, props.form.id),
    ) || initialMember.value !== store.data.organization.currentUserId,
);
watch(
  () => props.form.id,
  () => {
    config.value = copy(accessConfig(store.data, props.form.id));
    initial.value = JSON.stringify(config.value);
    initialMember.value = store.data.organization.currentUserId;
    errors.value = [];
    editorOpen.value = false;
    editing.value = undefined;
  },
);
const dirty = computed(() => initial.value !== JSON.stringify(config.value));
const busy = computed(() => saving.value);
const recovery = useEditorDraft(
  {
    key: () => `access-settings:${props.form.id}`,
    title: () => `发布设置 · ${props.form.title}`,
    context,
    restore: (value) => {
      config.value = restoreAccessSettingsDraft(value);
      errors.value = [];
    },
  },
  () => true,
  () => config.value,
  () => dirty.value,
);
const groups = computed(() =>
  config.value.groups.filter((g) => g.archived === showArchived.value),
);
const url = computed(
  () =>
    `${location.origin}${location.pathname}#/apps/${props.form.appId}/forms/${props.form.id}/members`,
);
async function save() {
  if (busy.value || editorOpen.value) return false;
  if (stale.value) {
    errors.value = [
      "发布设置或当前成员已变化，当前修改已保留，请重新核对后保存。",
    ];
    return false;
  }
  errors.value = accessIssues(config.value, props.form, store.data);
  if (errors.value.length) return false;
  saving.value = true;
  const submitted = copy(config.value);
  try {
    if (
      await store.saveFormAccess(
        props.form.id,
        submitted,
        JSON.parse(initial.value),
      )
    ) {
      initial.value = JSON.stringify(submitted);
      initialMember.value = store.data.organization.currentUserId;
      recovery.clear();
      store.notify("发布访问设置已生效");
      return true;
    }
    errors.value = accessIssues(submitted, props.form, store.data);
    if (!errors.value.length)
      errors.value = [
        store.storageError || "保存未完成，发布设置修改已保留，请重试。",
      ];
  } catch {
    errors.value = ["保存失败，发布设置修改已保留，请重试。"];
  } finally {
    saving.value = false;
  }
  return false;
}
function apply(group: AccessGroup) {
  if (busy.value) return "正在保存，请稍后重试。";
  const next = copy(config.value),
    i = next.groups.findIndex((g) => g.id === group.id);
  if (i < 0) next.groups.push(group);
  else next.groups[i] = group;
  const issues = accessIssues(
    { ...defaultAccess(), groups: [group] },
    props.form,
    store.data,
  );
  if (issues.length) {
    return issues[0];
  }
  const previous = config.value;
  config.value = next;
  // Preserve the parent draft before acknowledging the transfer and clearing the child copy.
  recovery.flush();
  if (dirty.value && !recovery.retained.value) {
    config.value = previous;
    recovery.flush();
    return "发布设置暂存未完成，权限组输入已保留，请重试。";
  }
  errors.value = [];
}
function actionLabels(group: AccessGroup) {
  return group.actions.map((a) => memberActions[a]).join("、");
}
function duplicate(group: AccessGroup) {
  config.value.groups.push({
    ...copy(group),
    id: uid("access"),
    name: group.name + "（副本）",
    enabled: false,
  });
}
function move(group: AccessGroup, direction: number) {
  const list = config.value.groups,
    i = list.findIndex((g) => g.id === group.id),
    next = i + direction;
  if (next >= 0 && next < list.length)
    [list[i], list[next]] = [list[next]!, list[i]!];
}
let decision: ((v: boolean) => void) | undefined;
function guard() {
  if (busy.value || editorOpen.value) return false;
  if (!dirty.value) return true;
  decision?.(false);
  leaving.value = true;
  return new Promise<boolean>((resolve) => (decision = resolve));
}
function resolveLeave(allow: boolean) {
  leaving.value = false;
  decision?.(allow);
  decision = undefined;
}
function discardAndLeave() {
  recovery.clear();
  resolveLeave(true);
}
function reload() {
  recovery.clear();
  config.value = copy(accessConfig(store.data, props.form.id));
  initial.value = JSON.stringify(config.value);
  initialMember.value = store.data.organization.currentUserId;
  errors.value = [];
  reloading.value = false;
}
async function saveAndLeave() {
  if (await save()) resolveLeave(true);
}
onBeforeRouteLeave(guard);
onBeforeRouteUpdate(guard);
function beforeUnload(e: BeforeUnloadEvent) {
  if (busy.value || (dirty.value && !recovery.retained.value))
    e.preventDefault();
}
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  decision?.(false);
});
</script>
<template>
  <section class="access-settings" :aria-busy="busy">
    <div class="access-settings-heading">
      <div>
        <h3>访问与填写设置</h3>
        <p class="field-hint">保存后立即生效，已有记录的访问权限也会更新。</p>
      </div>
      <span class="status-tag">{{ dirty ? "有未保存修改" : "已保存" }}</span>
    </div>
    <EditorDraftNotice
      :draft-key="recovery.key.value"
      :disabled="busy || editorOpen"
    />
    <p v-if="busy" role="status">正在保存发布设置，请稍候…</p>
    <p v-if="stale" class="access-warning" role="alert">
      发布设置或当前成员已变化，当前输入仍保留。<button
        class="button"
        :disabled="busy || editorOpen"
        @click="reloading = true"
      >
        重新读取发布设置
      </button>
    </p>
    <div :inert="busy || undefined">
      <div class="access-toggle-grid">
        <label
          ><input
            type="checkbox"
            v-model="config.publicEnabled"
          />开放本地填写链接</label
        >
        <label
          ><input
            type="checkbox"
            v-model="config.filling.enabled"
          />允许收集新数据</label
        >
        <label
          >开始时间<input
            type="datetime-local"
            v-model="config.filling.startsAt"
        /></label>
        <label
          >结束时间<input type="datetime-local" v-model="config.filling.endsAt"
        /></label>
        <label
          >收集数量上限<input
            type="number"
            min="0"
            step="1"
            v-model.number="config.filling.limit"
          /><small>0 表示不限；回收站数据不计入。</small></label
        >
        <label
          ><input
            type="checkbox"
            v-model="config.filling.allowRepeat"
          />允许同一成员重复提交</label
        >
      </div>
      <div class="access-settings-heading">
        <div>
          <h3>对成员发布</h3>
          <p class="field-hint">按权限组分配成员、操作、数据范围和字段权限。</p>
        </div>
        <label
          ><input
            type="checkbox"
            v-model="config.membersEnabled"
          />启用成员访问</label
        >
      </div>
      <div class="access-toolbar">
        <label
          ><input
            type="checkbox"
            v-model="config.allowMerged"
          />提供“全部有权限的数据”</label
        ><label><input type="checkbox" v-model="showArchived" />已归档</label
        ><button
          class="button"
          @click="
            config.groups
              .filter((g) => !g.archived)
              .forEach((g) => (g.enabled = false))
          "
        >
          停用全部组</button
        ><button
          class="button primary"
          @click="
            editing = undefined;
            editorOpen = true;
          "
        >
          新建权限组
        </button>
      </div>
      <p v-if="!groups.length" class="access-empty">
        {{
          showArchived
            ? "没有已归档的权限组"
            : "尚未配置权限组，添加成员后即可体验对应权限。"
        }}
      </p>
      <article
        v-for="group in groups"
        :key="group.id"
        class="access-group-card"
      >
        <div>
          <strong>{{ group.name }}</strong
          ><span class="status-tag"
            >{{
              resolveIdentities(store.data.organization, group.identities)
                .length
            }}
            位有效成员</span
          ><label v-if="!group.archived"
            ><input
              type="checkbox"
              v-model="group.enabled"
              :aria-label="`启用${group.name}`"
            />启用</label
          >
        </div>
        <p>
          {{ actionLabels(group) }} ·
          {{
            {
              all: "全部数据",
              self: "本人数据",
              department: "同部门数据",
              custom: "筛选条件",
            }[group.scope]
          }}
        </p>
        <div class="access-group-actions">
          <button
            class="text-button"
            @click="
              editing = group;
              editorOpen = true;
            "
          >
            编辑</button
          ><button class="text-button" @click="duplicate(group)">复制</button
          ><button
            class="text-button"
            @click="move(group, -1)"
            :disabled="config.groups[0]?.id === group.id"
          >
            上移</button
          ><button
            class="text-button"
            @click="move(group, 1)"
            :disabled="config.groups.at(-1)?.id === group.id"
          >
            下移</button
          ><button
            class="text-button"
            @click="group.archived = !group.archived"
          >
            {{ group.archived ? "恢复" : "归档" }}
          </button>
        </div>
      </article>
      <ul v-if="errors.length" class="config-errors" role="alert">
        <li v-for="error in errors" :key="error">{{ error }}</li>
      </ul>
      <div class="access-save-row">
        <button class="button primary" :disabled="busy" @click="save">
          保存发布设置</button
        ><button
          class="button"
          :disabled="!form.published"
          @click="router.push(`/apps/${form.appId}/forms/${form.id}/members`)"
        >
          体验成员视图
        </button>
      </div>
      <label class="access-link-label"
        >成员入口<input
          readonly
          :value="url"
          aria-label="成员入口链接"
          @focus="($event.target as HTMLInputElement).select()"
      /></label>
      <p class="scope-note">
        成员视图可在本地切换身份体验。链接使用当前浏览器的数据，不代表已开放互联网访问或接入登录认证。
      </p>
    </div>
  </section>
  <AccessGroupEditor
    :open="editorOpen"
    :form="form"
    :group="editing"
    :parent-context="config"
    :apply-group="apply"
    @close="editorOpen = false"
  />
  <BaseDialog
    :open="reloading"
    title="重新读取发布设置"
    :busy="busy"
    @close="reloading = false"
    ><p>当前未保存的发布设置将被放弃，并读取最新已保存配置。</p>
    <template #footer
      ><button class="button" @click="reloading = false">继续编辑</button
      ><button class="button danger" @click="reload">
        放弃并重新读取
      </button></template
    ></BaseDialog
  >
  <BaseDialog
    :open="leaving"
    title="发布设置尚未保存"
    :busy="busy"
    @close="resolveLeave(false)"
    ><p>离开将丢弃当前发布设置修改。</p>
    <ul v-if="errors.length" class="config-errors" role="alert">
      <li v-for="error in errors" :key="error">{{ error }}</li>
    </ul>
    <template #footer
      ><button class="button" @click="resolveLeave(false)">继续编辑</button
      ><button class="button" @click="discardAndLeave">放弃修改</button
      ><button class="button primary" @click="saveAndLeave">
        保存并离开
      </button></template
    ></BaseDialog
  >
</template>
