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
import AppIcon from "../../../components/AppIcon.vue";
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
const collectionOpen = ref(false);
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
watch(
  config,
  () => {
    errors.value = [];
  },
  { deep: true },
);
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
const fillLink = ref<HTMLInputElement>();
const memberLink = ref<HTMLInputElement>();
const fillUrl = computed(
  () =>
    `${location.origin}${location.pathname}#/apps/${props.form.appId}/forms/${props.form.id}/fill`,
);
const collectionSummary = computed(() => {
  const filling = config.value.filling;
  return [
    filling.startsAt || filling.endsAt ? "指定填写时间" : "不限填写时间",
    !Number.isInteger(filling.limit) || filling.limit < 0
      ? "请完善收集数量"
      : filling.limit
        ? `最多 ${filling.limit} 条`
        : "不限收集数量",
    filling.allowRepeat ? "允许重复提交" : "每位成员限提交一次",
  ].join(" · ");
});
async function copyLink(kind: "fill" | "member") {
  try {
    await navigator.clipboard.writeText(
      kind === "fill" ? fillUrl.value : url.value,
    );
    store.notify("链接已复制");
  } catch {
    const input = kind === "fill" ? fillLink.value : memberLink.value;
    input?.focus();
    input?.select();
    store.notify("自动复制未完成，请复制已选中的链接。", "warning");
  }
}
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
  if (errors.value.length) {
    collectionOpen.value = true;
    return false;
  }
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
    target =
      groups.value[
        groups.value.findIndex((g) => g.id === group.id) + direction
      ],
    next = target ? list.findIndex((g) => g.id === target.id) : -1;
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
    <EditorDraftNotice
      :draft-key="recovery.key.value"
      :disabled="busy || editorOpen"
    />
    <p v-if="stale" class="access-warning" role="alert">
      发布设置或当前成员已变化，当前输入仍保留。
      <button
        class="button"
        :disabled="busy || editorOpen"
        @click="reloading = true"
      >
        重新读取发布设置
      </button>
    </p>
    <div :inert="busy || undefined">
      <section class="access-section" aria-labelledby="fill-link-heading">
        <div class="access-settings-heading">
          <div class="access-section-title">
            <AppIcon name="link" :size="20" />
            <div>
              <h3 id="fill-link-heading">填写链接</h3>
              <p class="field-hint">通过链接填写表单，提交新数据。</p>
            </div>
          </div>
          <button
            class="switch"
            role="switch"
            :aria-checked="config.publicEnabled"
            aria-label="启用填写链接"
            :class="{ on: config.publicEnabled }"
            @click="config.publicEnabled = !config.publicEnabled"
          >
            <span />
          </button>
        </div>
        <div v-if="config.publicEnabled" class="access-section-body">
          <div v-if="form.published" class="publish-link-line">
            <input
              ref="fillLink"
              :value="fillUrl"
              readonly
              aria-label="表单填写链接"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button class="button" @click="copyLink('fill')">复制链接</button>
            <button
              class="button"
              @click="router.push(`/apps/${form.appId}/forms/${form.id}/fill`)"
            >
              打开表单<AppIcon name="right" />
            </button>
          </div>
          <p v-else class="field-hint">发布表单后生成填写链接。</p>
          <p class="access-local-note">
            链接仅在当前浏览器使用，尚未开放互联网访问。
          </p>
        </div>
      </section>
      <section class="access-section" aria-labelledby="collection-heading">
        <div class="access-settings-heading">
          <div class="access-section-title">
            <AppIcon name="form" :size="20" />
            <div>
              <h3 id="collection-heading">收集新数据</h3>
              <p class="field-hint">
                {{
                  config.filling.enabled
                    ? "通过填写链接或成员入口提交数据。"
                    : "已暂停新提交，已有数据保留。"
                }}
              </p>
            </div>
          </div>
          <button
            class="switch"
            role="switch"
            :aria-checked="config.filling.enabled"
            aria-label="允许收集新数据"
            :class="{ on: config.filling.enabled }"
            @click="config.filling.enabled = !config.filling.enabled"
          >
            <span />
          </button>
        </div>
        <details
          :open="collectionOpen"
          @toggle="collectionOpen = ($event.target as HTMLDetailsElement).open"
          class="access-collection access-section-body"
        >
          <summary>
            <span>填写设置</span
            ><span class="access-collection-summary">{{
              collectionSummary
            }}</span
            ><AppIcon name="down" />
          </summary>
          <div class="access-toggle-grid">
            <label
              >开始时间<input
                type="datetime-local"
                v-model="config.filling.startsAt"
              /><small>留空表示不限</small></label
            >
            <label
              >结束时间<input
                type="datetime-local"
                v-model="config.filling.endsAt"
              /><small>留空表示不限</small></label
            >
            <label
              >收集数量上限<input
                type="number"
                min="0"
                step="1"
                v-model.number="config.filling.limit"
              /><small>0 表示不限，回收站数据不计入</small></label
            >
            <label class="access-repeat"
              ><input
                type="checkbox"
                v-model="config.filling.allowRepeat"
              />允许同一成员重复提交</label
            >
          </div>
        </details>
      </section>
      <section class="access-section" aria-labelledby="members-heading">
        <div class="access-settings-heading">
          <div class="access-section-title">
            <AppIcon name="people" :size="20" />
            <div>
              <h3 id="members-heading">成员权限</h3>
              <p class="field-hint">设置哪些成员可以查看、填写或管理数据。</p>
            </div>
          </div>
          <button
            class="switch"
            role="switch"
            :aria-checked="config.membersEnabled"
            aria-label="启用成员访问"
            :class="{ on: config.membersEnabled }"
            @click="config.membersEnabled = !config.membersEnabled"
          >
            <span />
          </button>
        </div>
        <div v-if="config.membersEnabled" class="access-section-body">
          <div class="access-toolbar">
            <button
              class="button primary"
              @click="
                editing = undefined;
                editorOpen = true;
              "
            >
              <AppIcon name="add" />新建权限组
            </button>
            <button
              class="text-button"
              :aria-pressed="showArchived"
              @click="showArchived = !showArchived"
            >
              {{ showArchived ? "返回权限组" : "已归档" }}
            </button>
            <button
              v-if="config.groups.some((g) => !g.archived && g.enabled)"
              class="text-button"
              @click="
                config.groups
                  .filter((g) => !g.archived)
                  .forEach((g) => (g.enabled = false))
              "
            >
              停用全部组
            </button>
          </div>
          <p v-if="!groups.length" class="access-empty">
            {{
              showArchived
                ? "没有已归档的权限组"
                : "尚未添加权限组，先选择成员，再设置操作和字段权限。"
            }}
          </p>
          <article
            v-for="group in groups"
            :key="group.id"
            class="access-group-card"
          >
            <div>
              <strong>{{ group.name }}</strong
              ><span class="access-group-count"
                >{{
                  resolveIdentities(store.data.organization, group.identities)
                    .length
                }}
                位成员</span
              >
              <label v-if="!group.archived"
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
                编辑
              </button>
              <button class="text-button" @click="duplicate(group)">
                复制
              </button>
              <button
                class="text-button"
                @click="move(group, -1)"
                :disabled="groups[0]?.id === group.id"
              >
                上移
              </button>
              <button
                class="text-button"
                @click="move(group, 1)"
                :disabled="groups.at(-1)?.id === group.id"
              >
                下移
              </button>
              <button
                class="text-button"
                @click="group.archived = !group.archived"
              >
                {{ group.archived ? "恢复" : "归档" }}
              </button>
            </div>
          </article>
          <label
            v-if="config.groups.some((g) => !g.archived)"
            class="access-merge"
            ><input
              type="checkbox"
              v-model="config.allowMerged"
            />提供“全部有权限的数据”入口</label
          >
          <div v-if="form.published" class="publish-link-line member-link-line">
            <input
              ref="memberLink"
              :value="url"
              readonly
              aria-label="成员入口链接"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button class="button" @click="copyLink('member')">复制链接</button>
            <button
              class="button"
              @click="
                router.push(`/apps/${form.appId}/forms/${form.id}/members`)
              "
            >
              体验成员视图
            </button>
          </div>
          <p class="access-local-note">
            成员视图使用本地身份体验，尚未接入登录认证。
          </p>
        </div>
      </section>
    </div>
    <slot />
    <footer class="access-save-bar">
      <ul v-if="errors.length" class="config-errors" role="alert">
        <li v-for="error in errors" :key="error">{{ error }}</li>
      </ul>
      <div class="access-save-row">
        <span role="status" :class="{ 'access-unsaved': dirty }">{{
          busy
            ? "正在保存发布设置…"
            : dirty
              ? "填写与权限设置有未保存修改"
              : "设置已保存"
        }}</span>
        <button
          class="button primary"
          :disabled="busy || !dirty || editorOpen"
          @click="save"
        >
          保存发布设置
        </button>
      </div>
    </footer>
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
