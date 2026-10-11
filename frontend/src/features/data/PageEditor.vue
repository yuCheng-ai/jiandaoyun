<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import {
  composeFormSchema,
  dataModelChanges,
  pageForModel,
  type PublishedDataModel,
  type PagePublishImpact,
} from "@platform/contracts";
import { platformApi } from "../../repositories/platformApi";
import { usePageDesignerStore } from "../../stores/pageDesigner";
import { usePlatformSession } from "../../stores/platformSession";
import {
  fieldRegistry,
  findField,
  flattenFields,
  parseSchema,
  type FieldType,
} from "../../domain/form";
import {
  modelFields,
  pageFieldNames,
  pageFieldConflicts,
  planFieldReuse,
} from "../../domain/pageDesigner";
import { applicationDataLocation } from "../../domain/applicationNavigation";
import { newForm } from "../../domain/workspace";
import { useFormDesigner, type FieldDrop } from "../forms/useFormDesigner";
import { useDesignerPanels } from "../../composables/useDesignerPanels";
import FieldCanvas from "../forms/components/FieldCanvas.vue";
import FormPreview from "./ServerFormPreview.vue";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import ManualChoiceEditor from "../forms/components/ManualChoiceEditor.vue";
import ChoiceSettings from "../forms/components/ChoiceSettings.vue";
import FieldValueRules from "./FieldValueRules.vue";
import DateRangeInspector from "../forms/components/DateRangeInspector.vue";
import { serverFieldTypes, isChoiceField } from "@platform/contracts";
import PagePublishDialog from "./PagePublishDialog.vue";
const store = usePageDesignerStore(),
  session = usePlatformSession(),
  router = useRouter(),
  route = useRoute();
const data = computed(() => store.data!);
const base = newForm(data.value.draft.applicationId || "", store.state.title);
const facade = computed(() => ({
  ...base,
  get title() {
    return store.state.title;
  },
  set title(value) {
    store.state.title = value;
  },
  get schema() {
    return store.state.schema;
  },
  set schema(value) {
    store.state.schema = value;
  },
}));
const notice = ref(""),
  fieldMode = ref("new"),
  query = ref(""),
  inspector = ref("field");
const {
  showPalette,
  showInspector,
  inspectField,
  togglePalette,
  toggleInspector,
} = useDesignerPanels();
const preview = ref(false),
  publishing = ref(false),
  reloading = ref(false);
const editor = useFormDesigner(facade, (message) => {
  notice.value = message;
});
const discarding = ref(false);
async function locateField() {
  const id = route.query.field;
  if (typeof id !== "string" || !findField(store.state.schema.fields, id))
    return;
  editor.select(id);
  editor.activeParent.value =
    store.state.schema.fields.find(
      (field) =>
        field.type === "subform" &&
        field.children.some((child) => child.id === id),
    )?.id || null;
  inspector.value = "field";
  inspectField();
  await nextTick();
  document
    .querySelector<HTMLElement>(
      `.field-design-card[data-field-id="${CSS.escape(id)}"]`,
    )
    ?.scrollIntoView({ block: "nearest" });
}
watch(() => route.query.field, locateField);
const palette = fieldRegistry.filter((item) =>
  serverFieldTypes.includes(item.type),
);
const baseFields = computed(() => modelFields(data.value.model));
const chosenBase = computed(() =>
  baseFields.value.find((item) => item.field.id === editor.selected.value?.id),
);
const dataLocation = computed(() =>
  applicationDataLocation(
    data.value.draft.applicationId!,
    data.value.draft.definitionId,
  ),
);
const parentName = computed(() =>
  editor.activeParent.value
    ? findField(store.state.schema.fields, editor.activeParent.value)?.label
    : "主数据",
);
const usedFields = computed(
  () =>
    new Set(flattenFields(store.state.schema.fields).map((field) => field.id)),
);
const available = computed(() => {
  return baseFields.value.filter(
    (item) =>
      item.parentId === (editor.activeParent.value || undefined) &&
      item.field.name.includes(query.value),
  );
});
const fieldSource = computed(() => {
  const selected = editor.selected.value;
  if (!selected) return "";
  const parent =
    baseFields.value.find((item) =>
      item.field.children.some((child) => child.id === selected.id),
    )?.field.name ||
    store.state.schema.fields.find((field) =>
      field.children.some((child) => child.id === selected.id),
    )?.label;
  return `${data.value.object.title}${parent ? ` / ${parent}` : ""}`;
});
async function useExisting(id: string) {
  if (!usedFields.value.has(id)) return reuse(id);
  const item = baseFields.value.find((item) => item.field.id === id);
  if (!item) return;
  editor.select(id);
  editor.activeParent.value = item.parentId || null;
  inspector.value = "field";
  inspectField();
  await nextTick();
  document
    .querySelector<HTMLElement>(
      `.field-design-card[data-field-id="${CSS.escape(id)}"]`,
    )
    ?.scrollIntoView({ block: "nearest" });
}
const conflicts = computed(() => pageFieldConflicts(data.value, store.state));
const selectedConflict = computed(() =>
  conflicts.value.find((item) => item.field.id === editor.selected.value?.id),
);
const reuseReview = ref<ReturnType<typeof planFieldReuse>>(),
  reusePending = ref("");
const reuseError = ref("");
function reviewReuse() {
  const conflict = selectedConflict.value;
  reuseError.value = "";
  if (!conflict?.existing) return;
  try {
    reuseReview.value = planFieldReuse(
      data.value,
      store.state,
      conflict.field.id,
      conflict.existing.id,
    );
    reusePending.value = conflict.field.id;
  } catch (cause) {
    reuseError.value = (cause as Error).message;
  }
}
function confirmReuse() {
  if (!reuseReview.value) return;
  try {
    const plan = planFieldReuse(
      data.value,
      store.state,
      reusePending.value,
      reuseReview.value.replacement.id,
    );
    const target = plan.parentId
      ? findField(store.state.schema.fields, plan.parentId)!.children
      : store.state.schema.fields;
    editor.transact(() =>
      target.splice(
        target.findIndex((field) => field.id === reusePending.value),
        1,
        plan.replacement,
      ),
    );
    editor.select(plan.replacement.id);
    editor.activeParent.value = plan.parentId || null;
    reuseReview.value = undefined;
    notice.value = "已改用已有字段，保留本页显示设置；可撤销恢复。";
  } catch (cause) {
    reuseError.value = (cause as Error).message;
  }
}
function locateConflict() {
  if (conflicts.value[0]) {
    editor.select(conflicts.value[0].field.id);
    inspector.value = "field";
    inspectField();
  }
}
const publicationImpact = ref<PagePublishImpact>();
async function preparePublication() {
  publicationImpact.value = undefined;
  publishing.value = true;
  publicationImpact.value = await store.preparePublication();
}
const modelUpdate = ref(false),
  modelLoading = ref(false),
  modelError = ref("");
const latestModel = ref<PublishedDataModel>();
const modelChanges = computed(() =>
  latestModel.value
    ? dataModelChanges(data.value.model, latestModel.value.model)
    : undefined,
);
async function inspectModel() {
  modelUpdate.value = true;
  modelLoading.value = true;
  modelError.value = "";
  store.error = "";
  latestModel.value = undefined;
  try {
    const latest = await platformApi<PublishedDataModel>(
      `/data-objects/${data.value.draft.definitionId}/published-model`,
    );
    if (!latest.object.latestVersion)
      throw new Error(
        "数据对象尚未发布。当前页面可继续编辑；数据管理如有独立修改，请先发布，再回到本页采用。",
      );
    latestModel.value = latest;
  } catch (cause) {
    modelError.value = (cause as Error).message;
  } finally {
    modelLoading.value = false;
  }
}
function add(
  type: FieldType,
  parentId = editor.activeParent.value,
  index?: number,
) {
  const existing = pageFieldNames(
    data.value,
    store.state,
    parentId || undefined,
  );
  const original = fieldRegistry.find((item) => item.type === type)!.label;
  let label = original;
  let counter = 2;
  while (existing.has(label)) label = `${original} ${counter++}`;
  const field = editor.add(type, parentId, undefined, index, { label });
  if (!field) return;
  notice.value = "";
  inspector.value = "field";
  inspectField();
}
function reuse(
  id: string,
  parentId = editor.activeParent.value,
  index?: number,
) {
  const existing = baseFields.value.find(
    (item) => item.field.id === id && item.parentId === (parentId || undefined),
  );
  if (
    !existing ||
    flattenFields(store.state.schema.fields).some((field) => field.id === id)
  ) {
    notice.value = "请选择当前范围内尚未放入页面的已有字段。";
    return;
  }
  const schema = { version: 1 as const, fields: [existing.field] };
  const field = parseSchema(composeFormSchema(schema, pageForModel(schema)))
    .fields[0]!;
  const target = parentId
    ? findField(store.state.schema.fields, parentId)?.children
    : store.state.schema.fields;
  if (!target) return;
  editor.transact(() => target.splice(index ?? target.length, 0, field));
  editor.select(field.id);
  editor.activeParent.value = parentId;
  inspector.value = "field";
  notice.value = `已将「${existing.field.name}」放入本页，仍使用原数据字段。`;
  inspectField();
}
function drag(event: DragEvent, payload: object) {
  event.dataTransfer?.setData(
    "application/x-form-field",
    JSON.stringify(payload),
  );
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}
function drop(payload: FieldDrop & { existingId?: string }) {
  if (store.busy) return;
  if (payload.existingId)
    return reuse(payload.existingId, payload.parentId || null, payload.index);
  if (payload.type)
    return add(payload.type, payload.parentId || null, payload.index);
  const existing = baseFields.value.find(
    (item) => item.field.id === payload.id,
  );
  if (existing && existing.parentId !== payload.parentId) {
    notice.value =
      "已有字段的业务归属不随拖动改变。请在原范围内调整位置，或新增对应明细字段。";
    return;
  }
  editor.drop(payload);
}
function remove(id: string) {
  const existing = baseFields.value.some((item) => item.field.id === id);
  editor.remove([id]);
  notice.value = existing
    ? "已移除页面控件，数据字段与已有值保留；可从“已有字段”重新放入。"
    : "已取消这个新增字段，可撤销恢复。";
}
async function save() {
  if (await store.save()) notice.value = "草稿已保存，正式页面尚未改变。";
}
async function publish() {
  if (
    publicationImpact.value &&
    (await store.publish(publicationImpact.value))
  ) {
    publishing.value = false;
    notice.value = "页面已发布。";
  } else publicationImpact.value = undefined;
}
async function reload() {
  await store.load(data.value.draft.id);
  reloading.value = false;
}
const leaveTo = ref(""),
  leaveApproved = ref(false);
function guard(to: { fullPath: string }) {
  if (store.busy) return false;
  if (store.dirty && !leaveApproved.value) {
    leaveTo.value = to.fullPath;
    return false;
  }
  return true;
}
onBeforeRouteLeave(guard);
onBeforeRouteUpdate(guard);
function leave() {
  leaveApproved.value = true;
  router.push(leaveTo.value);
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (store.dirty) event.preventDefault();
}
function keyboard(event: KeyboardEvent) {
  if (
    data.value.draft.archivedAt ||
    store.busy ||
    discarding.value ||
    publishing.value ||
    preview.value ||
    leaveTo.value ||
    reloading.value ||
    modelUpdate.value ||
    reuseReview.value
  )
    return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    save();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? editor.redo() : editor.undo();
  }
}
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("keydown", keyboard);
  locateField();
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("keydown", keyboard);
});
</script>
<template>
  <div class="application form-designer server-page-designer">
    <header class="app-header">
      <div class="document-identity">
        <button
          class="icon-button back-button"
          aria-label="返回应用配置"
          :disabled="store.busy"
          @click="
            router.push(
              `/applications/${data.draft.applicationId}${data.draft.archivedAt ? '?pages=archived' : ''}`,
            )
          "
        >
          <AppIcon name="back" /></button
        ><input
          v-model="store.state.title"
          class="document-title"
          aria-label="页面名称"
          maxlength="100"
          :disabled="store.busy || !!data.draft.archivedAt"
        />
      </div>
      <span class="page-header-context"
        >表单页面 · {{ data.object.title }}</span
      >
      <div class="header-utilities">{{ session.user?.name }}</div>
    </header>
    <main class="form-designer-shell">
      <div v-if="!data.draft.archivedAt" class="form-editor-toolbar">
        <button
          class="icon-button"
          aria-label="撤销"
          :disabled="store.busy || !editor.canUndo.value"
          @click="editor.undo"
        >
          <AppIcon name="undo" />
        </button>
        <button
          class="icon-button"
          aria-label="重做"
          :disabled="store.busy || !editor.canRedo.value"
          @click="editor.redo"
        >
          <AppIcon name="redo" />
        </button>
        <button
          class="icon-button mobile-editor-toggle"
          aria-label="切换字段库"
          @click="togglePalette"
        >
          <AppIcon name="menu" />
        </button>
        <button
          class="icon-button mobile-editor-toggle"
          aria-label="切换属性面板"
          @click="toggleInspector"
        >
          <AppIcon name="settings" />
        </button>
        <span class="page-model-label">数据：{{ data.object.title }}</span
        ><RouterLink
          :to="dataLocation"
          class="text-button"
          target="_blank"
          rel="noopener"
          >管理共享数据</RouterLink
        ><button
          class="text-button"
          :disabled="store.busy"
          @click="inspectModel"
        >
          更新可用字段{{
            data.draft.definitionVersion
              ? ` V${data.draft.definitionVersion}`
              : ""
          }}
        </button>
        <div class="toolbar-spacer" />
        <span class="editor-save-state" role="status"
          >{{
            store.busy ? "正在保存…" : store.dirty ? "尚未保存" : "草稿已保存"
          }}{{
            data.draft.latestVersion
              ? ` · 已发布 V${data.draft.latestVersion}`
              : ""
          }}</span
        >
        <button
          v-if="data.draft.latestVersion"
          class="text-button"
          :disabled="store.busy"
          @click="discarding = true"
        >
          放弃页面草稿
        </button>
        <button class="button" :disabled="store.busy" @click="preview = true">
          预览</button
        ><button
          class="button"
          :disabled="store.busy || !!conflicts.length"
          @click="save"
        >
          保存草稿</button
        ><button
          class="button primary"
          :disabled="store.busy || !!conflicts.length"
          @click="preparePublication"
        >
          发布
        </button>
      </div>
      <div v-else class="page-editor-message" role="status">
        页面已归档，当前可查看保留的草稿；恢复后才能编辑和发布。<button
          class="button"
          @click="preview = true"
        >
          预览草稿
        </button>
      </div>
      <div v-if="store.error" class="page-editor-message error" role="alert">
        {{ store.error }}
        <button class="text-button" @click="reloading = true">重新读取</button>
      </div>
      <div
        v-else-if="notice || store.feedback"
        class="page-editor-message"
        role="status"
      >
        {{ notice || store.feedback
        }}<button
          class="icon-button"
          aria-label="关闭提示"
          @click="
            notice = '';
            store.feedback = '';
          "
        >
          <AppIcon name="close" :size="14" />
        </button>
      </div>
      <div
        v-if="conflicts.length"
        class="page-editor-message error"
        role="alert"
      >
        有 {{ conflicts.length }} 个同名新增字段，请选择复用或更名。<button
          class="text-button"
          @click="locateConflict"
        >
          定位字段
        </button>
      </div>
      <div
        class="form-editor-body"
        :class="{ 'archived-page-canvas': data.draft.archivedAt }"
        :inert="store.busy || !!data.draft.archivedAt || undefined"
      >
        <aside
          v-show="showPalette && !data.draft.archivedAt"
          class="field-palette"
        >
          <div class="property-tabs">
            <button
              :class="{ active: fieldMode === 'new' }"
              @click="fieldMode = 'new'"
            >
              新建字段</button
            ><button
              :class="{ active: fieldMode === 'existing' }"
              @click="fieldMode = 'existing'"
            >
              已有字段
            </button>
          </div>
          <div class="insertion-target">
            <span>添加到：{{ parentName }}</span
            ><button
              v-if="editor.activeParent.value"
              class="icon-button"
              aria-label="改为添加到主数据"
              @click="editor.activeParent.value = null"
            >
              <AppIcon name="close" :size="14" />
            </button>
          </div>
          <div class="palette-scroll">
            <div class="palette-search">
              <AppIcon name="search" /><input
                v-model="query"
                aria-label="搜索字段"
                placeholder="搜索字段"
              />
            </div>
            <section v-if="fieldMode === 'new'" class="palette-section">
              <header><h3>常用字段</h3></header>
              <div class="palette-grid">
                <button
                  v-for="item in palette.filter((item) =>
                    item.label.includes(query),
                  )"
                  :key="item.type"
                  class="palette-field"
                  :data-field-type="item.type"
                  :aria-label="`添加${item.label}`"
                  draggable="true"
                  @dragstart="drag($event, { type: item.type })"
                  @click="add(item.type)"
                >
                  <AppIcon :name="item.icon" :size="14" />{{ item.label }}
                </button>
              </div>
              <p class="field-hint">
                新增字段随页面草稿保存，发布后可供其他页面使用。
              </p>
            </section>
            <section v-else class="palette-section">
              <p class="field-hint">
                字段来自「{{ data.object.title }}」{{
                  editor.activeParent.value ? `的「${parentName}」明细` : ""
                }}。添加到本页后仍填写同一份数据。
              </p>
              <div class="page-existing-fields">
                <button
                  v-for="item in available"
                  :key="item.field.id"
                  class="palette-field"
                  :class="{ placed: usedFields.has(item.field.id) }"
                  :draggable="!usedFields.has(item.field.id)"
                  :aria-label="`${usedFields.has(item.field.id) ? '定位' : '使用'}${item.field.name}`"
                  @dragstart="
                    !usedFields.has(item.field.id) &&
                    drag($event, { existingId: item.field.id })
                  "
                  @click="useExisting(item.field.id)"
                >
                  <AppIcon
                    :name="usedFields.has(item.field.id) ? 'done' : 'link'"
                    :size="14"
                  /><span>{{ item.field.name }}</span
                  ><small v-if="usedFields.has(item.field.id)">已在本页</small>
                </button>
              </div>
              <p v-if="!available.length" class="field-hint">
                {{
                  query
                    ? "没有找到匹配的已有字段。"
                    : "当前范围暂无共享字段。可从“新建字段”添加，发布后进入此数据对象。"
                }}
              </p>
            </section>
          </div>
        </aside>
        <section
          class="form-design-scroll"
          aria-label="表单设计画布"
          @click.self="
            editor.selectedIds.value = [];
            editor.activeParent.value = null;
          "
        >
          <div
            class="form-design-sheet"
            :class="{ empty: !store.state.schema.fields.length }"
          >
            <FieldCanvas
              :fields="store.state.schema.fields"
              :selected-ids="editor.selectedIds.value"
              :active-tab-id="editor.activeTabId.value"
              :layout="store.state.schema.settings.layout"
              :allow-duplicate="false"
              @select="
                (id, event) => {
                  editor.select(id, event);
                  inspector = 'field';
                  inspectField();
                }
              "
              @context="editor.setContext"
              @drop="drop"
              @remove="remove"
              @move="editor.move"
            />
          </div>
        </section>
        <aside
          v-show="showInspector && !data.draft.archivedAt"
          class="form-property-panel"
        >
          <div class="property-tabs">
            <button
              :class="{ active: inspector === 'field' }"
              @click="inspector = 'field'"
            >
              控件属性</button
            ><button
              :class="{ active: inspector === 'page' }"
              @click="inspector = 'page'"
            >
              页面属性
            </button>
          </div>
          <div class="form-property-scroll">
            <div
              v-if="inspector === 'field' && editor.selected.value"
              class="field-inspector"
            >
              <div class="page-binding-note">
                <strong>{{
                  chosenBase
                    ? `数据字段：${chosenBase.field.name}`
                    : "本页新增字段"
                }}</strong
                ><br />归属：{{ fieldSource }}<br v-if="!chosenBase" /><span
                  v-if="!chosenBase"
                  >发布后可供其他页面使用。</span
                >
              </div>
              <div class="form-group">
                <label for="page-control-label">{{
                  chosenBase ? "本页显示名称" : "字段名称"
                }}</label
                ><input
                  id="page-control-label"
                  v-model="editor.selected.value.label"
                  maxlength="100"
                />
              </div>
              <div
                v-if="selectedConflict"
                class="field-reuse-notice"
                role="alert"
              >
                <p>
                  {{
                    selectedConflict.existing
                      ? `当前数据已有「${selectedConflict.existing.name}」。`
                      : "本页已有同名待发布字段，请修改名称。"
                  }}
                </p>
                <template v-if="selectedConflict.existing"
                  ><p v-if="selectedConflict.alreadyPlaced">
                    这个已有字段已在画布中，可定位查看后取消重复的新字段。
                  </p>
                  <p v-else>
                    复用后填写同一份业务值；需要另一份信息时，请为新字段取不同名称。
                  </p>
                  <button
                    v-if="selectedConflict.alreadyPlaced"
                    class="button"
                    @click="editor.select(selectedConflict.existing.id)"
                  >
                    定位已有控件</button
                  ><button v-else class="button" @click="reviewReuse">
                    使用已有字段
                  </button></template
                >
                <p v-if="reuseError" class="collab-error">{{ reuseError }}</p>
              </div>
              <div class="form-group">
                <label for="page-placeholder">填写提示</label
                ><input
                  id="page-placeholder"
                  v-model="editor.selected.value.placeholder"
                />
              </div>
              <div class="form-group">
                <label for="page-description">说明</label
                ><textarea
                  id="page-description"
                  v-model="editor.selected.value.description"
                  rows="3"
                />
              </div>
              <div class="form-group">
                <label class="checkbox-line"
                  ><input
                    v-model="editor.selected.value.required"
                    type="checkbox"
                    :disabled="chosenBase?.field.required"
                  />本页提交时必填</label
                >
                <p v-if="chosenBase?.field.required" class="field-hint">
                  数据对象已要求此字段必填。
                </p>
                <label class="checkbox-line"
                  ><input
                    v-model="editor.selected.value.editable"
                    type="checkbox"
                  />允许在本页编辑</label
                ><label class="checkbox-line"
                  ><input
                    v-model="editor.selected.value.visible"
                    type="checkbox"
                  />在本页显示</label
                >
                <p class="field-hint">成员还需具备对应字段权限。</p>
              </div>
              <div class="form-group">
                <label for="page-width">控件宽度</label
                ><select
                  id="page-width"
                  v-model.number="editor.selected.value.width"
                >
                  <option :value="12">整行</option>
                  <option :value="6">半行</option>
                  <option :value="4">三分之一</option>
                </select>
              </div>
              <div
                v-if="editor.selected.value.type !== 'subform'"
                class="form-group"
              >
                <label v-if="!isChoiceField(editor.selected.value.type)"
                  >数据规则</label
                ><ManualChoiceEditor
                  v-if="isChoiceField(editor.selected.value.type)"
                  :field="editor.selected.value"
                  appearance
                  :readonly-options="!!chosenBase"
                  @update="Object.assign(editor.selected.value!, $event)"
                /><FieldValueRules
                  v-else
                  :field="editor.selected.value"
                  :fields="store.state.schema.fields"
                  :parent-id="editor.activeParent.value || undefined"
                  :disabled="!!chosenBase"
                  @update="Object.assign(editor.selected.value!, $event)"
                />
                <p v-if="chosenBase" class="field-hint">
                  {{
                    isChoiceField(editor.selected.value.type)
                      ? "选项名称和默认值在数据管理中修改。"
                      : "此处显示共享规则；如需修改，请进入应用的数据管理检查影响。"
                  }}
                </p>
              </div>
              <ChoiceSettings
                :field="editor.selected.value"
                @update="Object.assign(editor.selected.value!, $event)"
              />
              <DateRangeInspector
                v-if="editor.selected.value.type === 'datetime'"
                :field="editor.selected.value"
                :fields="store.state.schema.fields"
                @update="Object.assign(editor.selected.value!, $event)"
              />
              <button
                class="button danger full-width"
                @click="remove(editor.selected.value!.id)"
              >
                {{ chosenBase ? "移除本页控件" : "取消新增字段" }}
              </button>
            </div>
            <div
              v-else-if="inspector === 'field'"
              class="field-inspector-empty"
            >
              选择画布中的字段，设置当前页面的展示和填写方式。
            </div>
            <div v-else class="field-inspector">
              <div class="form-group">
                <label for="page-layout">页面列数</label
                ><select
                  id="page-layout"
                  v-model.number="store.state.schema.settings.layout"
                >
                  <option :value="1">一列</option>
                  <option :value="2">两列</option>
                  <option :value="3">三列</option>
                </select>
              </div>
              <div class="form-group">
                <label for="submit-label">提交按钮文字</label
                ><input
                  id="submit-label"
                  v-model="store.state.schema.settings.submitLabel"
                />
              </div>
              <p class="field-hint">
                页面布局独立保存，不改变数据结构与其他页面。
              </p>
            </div>
          </div>
        </aside>
      </div>
    </main>
    <FormPreview
      v-if="preview"
      :schema="store.state.schema"
      :form-id="data.draft.id"
      :title="store.state.title"
      @close="preview = false"
    />
    <BaseDialog
      :open="modelUpdate"
      title="更新可用数据字段"
      width="560px"
      :busy="modelLoading"
      @close="modelUpdate = false"
    >
      <p v-if="modelLoading" role="status">正在检查已发布字段…</p>
      <p v-if="modelError || store.error" class="collab-error" role="alert">
        {{ modelError || store.error }}
      </p>
      <template v-if="latestModel && modelChanges"
        ><p>
          {{
            data.draft.definitionVersion
              ? `本页采用数据 V${data.draft.definitionVersion}`
              : "本页仍使用初始数据草稿"
          }}，最新数据为 V{{ latestModel.object.latestVersion }}。
        </p>
        <p v-if="modelChanges.added.length">
          新增字段：{{
            modelChanges.added.map((item) => item.field.name).join("、")
          }}
        </p>
        <p v-if="modelChanges.renamed.length">
          名称调整：{{
            modelChanges.renamed.map((item) => item.field.name).join("、")
          }}
        </p>
        <p v-if="modelChanges.changed.length">
          约束调整：{{
            modelChanges.changed.map((item) => item.field.name).join("、")
          }}
        </p>
        <p v-if="modelChanges.removed.length">
          已移除字段：{{
            modelChanges.removed.map((item) => item.field.name).join("、")
          }}
        </p>
        <p class="collab-help">
          更新后保留当前布局和未保存修改。新增字段出现在“已有字段”中，由你选择放入页面；保存并发布后正式页面才会改变。
        </p>
        <p v-if="modelChanges.removed.length" class="collab-help">
          本页仍在使用的已移除字段，需要先移除控件才能更新。
        </p>
      </template>
      <template #footer
        ><button class="button" @click="modelUpdate = false">继续编辑</button
        ><button v-if="modelError" class="button" @click="inspectModel">
          重试</button
        ><button
          class="button primary"
          :disabled="!latestModel || modelLoading"
          @click="latestModel && store.adopt(latestModel)"
        >
          采用已发布字段
        </button></template
      >
    </BaseDialog>
    <PagePublishDialog
      v-if="publishing"
      :impact="publicationImpact"
      :busy="store.busy"
      :error="store.error"
      @close="publishing = false"
      @retry="preparePublication"
      @confirm="publish"
    />
    <BaseDialog
      :open="!!reuseReview"
      title="复用已有字段"
      width="560px"
      @close="reuseReview = undefined"
    >
      <p>以下控件将绑定已有数据，保留本页名称、宽度和填写设置：</p>
      <ul>
        <li v-for="binding in reuseReview?.bindings" :key="binding.fieldId">
          {{ binding.name }}
        </li>
      </ul>
      <p v-if="reuseReview?.additions.length">
        仍作为新增明细列：{{ reuseReview.additions.join("、") }}，随本页发布。
      </p>
      <p class="collab-help">其他页面和已有数据保持原样。</p>
      <p v-if="reuseError" class="collab-error" role="alert">
        {{ reuseError }}
      </p>
      <template #footer
        ><button class="button" @click="reuseReview = undefined">
          继续编辑</button
        ><button class="button primary" @click="confirmReuse">
          确认复用
        </button></template
      >
    </BaseDialog>
    <BaseDialog
      :open="!!leaveTo"
      title="保留当前修改"
      :busy="store.busy"
      @close="leaveTo = ''"
      ><p>页面还有未保存的修改。</p>
      <p v-if="store.error" class="collab-error" role="alert">
        {{ store.error }}
      </p>
      <template #footer
        ><button class="button" @click="leaveTo = ''">继续编辑</button
        ><button class="button danger" @click="leave">放弃修改并离开</button
        ><button
          class="button primary"
          :disabled="store.busy"
          @click="
            async () => {
              if (await store.save()) leave();
            }
          "
        >
          保存并离开
        </button></template
      ></BaseDialog
    >
    <BaseDialog
      :open="reloading"
      title="重新读取页面"
      :busy="store.busy"
      @close="reloading = false"
      ><p>将读取服务端草稿，并放弃当前尚未保存的输入。</p>
      <template #footer
        ><button class="button" @click="reloading = false">保留输入</button
        ><button class="button" @click="reload">
          放弃输入并读取
        </button></template
      ></BaseDialog
    >
    <BaseDialog
      :open="discarding"
      title="放弃页面草稿"
      :busy="store.busy"
      @close="discarding = false"
    >
      <p>
        将恢复本页最近发布的 V{{
          data.draft.latestVersion
        }}，放弃已保存草稿和当前未保存的修改，包括布局、控件及尚未发布的新字段。
      </p>
      <p>
        共享数据字段、已有记录和其他页面保持原样。恢复后不能通过本页撤销按钮找回这些草稿修改。
      </p>
      <p v-if="store.error" class="collab-error" role="alert">
        {{ store.error }}
      </p>
      <template #footer
        ><button class="button" @click="discarding = false">继续编辑</button
        ><button
          class="button danger"
          :disabled="store.busy"
          @click="store.discardDraft"
        >
          确认放弃页面草稿
        </button></template
      >
    </BaseDialog>
  </div>
</template>
<style scoped>
.field-reuse-notice {
  margin: 12px 0;
  padding: 10px;
  background: #fff7e8;
  border: 1px solid #f3d49c;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
}
.field-reuse-notice p {
  margin: 0 0 8px;
}
.archived-page-canvas :deep(.field-card-tools),
.archived-page-canvas :deep(.subform-design-heading button) {
  display: none;
}
</style>
