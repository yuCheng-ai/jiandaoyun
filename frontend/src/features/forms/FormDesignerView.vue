<script setup lang="ts">
import FieldRecycleList from "./components/FieldRecycleList.vue";
import { computed, nextTick, ref, onMounted, onBeforeUnmount } from "vue";
import { visibilityConditions, textVisibilityRules } from "../../domain/visibility";
import { formulaReferences } from "../../domain/formula";
import { validationReferences } from "../../domain/formValidation";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import DesignerHeader from "../../components/shared/DesignerHeader.vue";
import FieldCanvas from "./components/FieldCanvas.vue";
import FieldInspector from "./components/FieldInspector.vue";
import FormSettingsInspector from "./components/FormSettingsInspector.vue";
import FormPreview from "./components/FormPreview.vue";
import {
  fieldRegistry,
  fieldTypePatch,
  fieldTypeChangeIssue,
  flattenFields,
  type FormField,
  type FieldType,
} from "../../domain/form";
import { fieldExtensionImpacts } from "../../domain/extensions";
import { frontendEventReferences } from "../../domain/frontendEvents";
import { referenceDependencies, resolveChoices } from "../../domain/relations";
import { accessConfig, accessFieldImpacts } from "../../domain/access";
import { newForm } from "../../domain/workspace";
import { useWorkspaceStore, syncFormWorkflow } from "../../stores/workspace";
import { useFormDesigner } from "./useFormDesigner";
import { useDesignerPanels } from "../../composables/useDesignerPanels";
const route = useRoute(),
  router = useRouter(),
  store = useWorkspaceStore();
const formId = String(route.params.formId);
const found = store.openForm(formId);
const form = computed(
  () =>
    store.drafts[formId] || newForm(String(route.params.appId), "未找到表单"),
);
const editor = useFormDesigner(
  form,
  (message) => store.notify(message, "warning"),
  () => store.inspectLatest().workspace?.forms || store.data.forms,
);
const tab = ref("field");
const preview = ref(false),
  dialog = ref(""),
  saving = ref(false);
const {
  showPalette,
  showInspector,
  inspectField,
  togglePalette,
  toggleInspector,
} = useDesignerPanels();
const savedSchema = computed(
  () => store.data.forms.find((f) => f.id === formId)?.schema,
);
const savedCalculatedIds = computed(() => {
  const saved = store.data.forms.find((f) => f.id === formId);
  return new Set(
    flattenFields([
      ...(saved?.schema.fields || []),
      ...(saved?.fieldTrash || []).map((item) => item.field),
    ])
      .filter((field) => field.type === "calculated")
      .map((field) => field.id),
  );
});
const dirty = computed(
  () =>
    JSON.stringify(form.value.schema) !== JSON.stringify(savedSchema.value) ||
    JSON.stringify(form.value.fieldTrash || []) !==
      JSON.stringify(
        store.data.forms.find((f) => f.id === formId)?.fieldTrash || [],
      ) ||
    form.value.title !== store.data.forms.find((f) => f.id === formId)?.title,
);
function select(id: string, event: MouseEvent | KeyboardEvent) {
  editor.select(id, event);
  tab.value = "field";
  inspectField();
}
function add(type: FieldType) {
  editor.add(type);
  tab.value = "field";
  inspectField();
}
async function addChild(type: FieldType, parentId: string) {
  if (!editor.add(type, parentId)) return;
  tab.value = "field";
  inspectField();
  await nextTick();
  document.getElementById("field-title")?.focus();
}
function paletteDrag(type: FieldType, event: DragEvent) {
  event.dataTransfer?.setData(
    "application/x-form-field",
    JSON.stringify({ type }),
  );
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}
const pendingType = ref<{ id: string; type: FieldType }>();
function applyType(field: FormField, type: FieldType) {
  const issue = fieldTypeChangeIssue(field, type);
  if (issue) return store.notify(issue, "warning");
  const patch = fieldTypePatch(field, type);
  if (!patch) return;
  try {
    let rules = form.value.schema.settings.rules;
    if (type === "text") {
      const latest = field.choiceSource.mode === "form" ? store.inspectLatest?.() : undefined;
      if (latest && !latest.workspace) throw Error("来源数据暂时无法读取，请稍后重试切换字段类型");
      rules = textVisibilityRules(rules, field, resolveChoices(
        { ...field, choiceSource: { ...field.choiceSource, filters: [] } }, latest?.workspace || store.data, {},
      ));
    }
    editor.transact(() => {
      Object.assign(field, patch);
      form.value.schema.settings.rules = rules;
    });
  } catch (error) {
    store.notify((error as Error).message, "warning");
  }
}
function updateField(patch: Partial<FormField>) {
  const field = editor.selected.value;
  if (!field) return;
  if (patch.type && patch.type !== field.type) {
    if (field.masked && (field.type === "text" || patch.type === "text")) {
      pendingType.value = { id: field.id, type: patch.type };
      dialog.value = "type";
    } else applyType(field, patch.type);
  } else Object.assign(field, patch);
}
function confirmType() {
  const pending = pendingType.value;
  const field = pending && flattenFields(form.value.schema.fields).find(field => field.id === pending.id);
  if (field && pending) applyType(field, pending.type);
  pendingType.value = undefined;
  dialog.value = "";
}
async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    editor.checkpoint();
    syncFormWorkflow(form.value);
    if (await store.saveForm(formId)) store.notify("表单已保存");
  } finally {
    saving.value = false;
  }
}
const pendingRemoval = ref<string[]>([]),
  removalImpacts = ref<string[]>([]);
function requestRemove(ids = editor.selectedIds.value) {
  pendingRemoval.value = [...ids];
  const expanded = flattenFields(form.value.schema.fields)
    .filter((f) => ids.includes(f.id))
    .flatMap((f) => flattenFields([f]).map((child) => child.id));
  removalImpacts.value = [
    ...fieldExtensionImpacts(form.value, expanded),
    ...(form.value.schema.settings.frontendEvents || [])
      .filter((event) =>
        frontendEventReferences(event).some((id) => expanded.includes(id)),
      )
      .map((event) => `前端事件「${event.name}」的触发、输入或回填`),
    ...accessFieldImpacts(accessConfig(store.data, formId), expanded),
  ];
  for (const owner of [
    form.value,
    ...store.activeForms.filter((other) => other.id !== formId),
  ])
    for (const field of flattenFields(owner.schema.fields)) {
      if (owner.id === formId && expanded.includes(field.id)) continue;
      const dependencies = referenceDependencies(field);
      if (
        dependencies.external.some(source => source.formId === formId &&
          source.fields.some((id) => expanded.includes(id))) ||
        (owner.id === formId &&
          dependencies.local.some((id) => expanded.includes(id)))
      )
        removalImpacts.value.push(
          `「${owner.title}」的「${field.label}」数据来源或填充规则`,
        );
    }
  for (const field of flattenFields(form.value.schema.fields)) {
    if (
      !expanded.includes(field.id) &&
      field.subformMobile?.summary === "custom" &&
      field.subformMobile.fieldIds.some((id) => expanded.includes(id))
    )
      removalImpacts.value.push(`「${field.label}」移动端简报`);
    if (
      !expanded.includes(field.id) &&
      field.serial?.rules.some(
        (rule) => rule.type === "field" && expanded.includes(rule.fieldId),
      )
    )
      removalImpacts.value.push(`「${field.label}」流水号规则`);
    if (
      !expanded.includes(field.id) &&
      formulaReferences(field.expression).some((id) => expanded.includes(id))
    )
      removalImpacts.value.push("「" + field.label + "」计算公式");
    if (
      !expanded.includes(field.id) &&
      field.location?.rangeMode === "field" &&
      expanded.includes(field.location.centerFieldId)
    )
      removalImpacts.value.push(`「${field.label}」定位范围`);
    if (
      !expanded.includes(field.id) &&
      field.ocr?.mappings.some((mapping) => expanded.includes(mapping.fieldId))
    )
      removalImpacts.value.push(`「${field.label}」识别规则`);
    if (expanded.includes(field.id) || !field.dateRange) continue;
    for (const [key, label] of [
      ["earliest", "最早可选时间"],
      ["latest", "最晚可选时间"],
    ] as const) {
      const bound = field.dateRange[key];
      if (bound.mode === "field" && expanded.includes(bound.fieldId))
        removalImpacts.value.push(`「${field.label}」${label}`);
    }
  }
  for (const node of form.value.workflow.nodes)
    if (
      node.data.kind === "condition" &&
      expanded.includes(node.data.conditionFieldId)
    )
      removalImpacts.value.push(`条件节点「${node.data.label}」`);
  for (const rule of form.value.schema.settings.rules)
    if (
      visibilityConditions(rule).some((condition) =>
        expanded.includes(condition.sourceId),
      ) ||
      rule.targetIds.some((id) => expanded.includes(id))
    )
      removalImpacts.value.push("表单条件显隐规则");
  (form.value.schema.settings.validations || []).forEach((rule, index) => {
    if (validationReferences(rule).some((id) => expanded.includes(id)))
      removalImpacts.value.push(`数据校验 ${index + 1}`);
  });
  if (
    expanded.some((id) =>
      Object.hasOwn(form.value!.schema.settings.hiddenValueRules || {}, id),
    )
  )
    removalImpacts.value.push("特殊字段赋值规则");
  if (removalImpacts.value.length) dialog.value = "impact";
  else editor.remove(ids);
}
function confirmRemove() {
  editor.remove(pendingRemoval.value);
  dialog.value = "";
}
async function keydown(event: KeyboardEvent) {
  if (dialog.value || preview.value || saving.value) return;
  if (document.querySelector('dialog[open][aria-modal="true"]')) return;
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    await save();
    return;
  }
  const el = event.target as HTMLElement;
  if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable) return;
  if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? editor.redo() : editor.undo();
  } else if (modifier && event.key.toLowerCase() === "y") {
    event.preventDefault();
    editor.redo();
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    requestRemove();
  } else if (event.key === "Escape") editor.selectedIds.value = [];
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault();
}
onMounted(() => {
  if (!found) {
    router.replace(`/apps/${route.params.appId}`);
    return;
  }
  document.title = `${form.value.title} · 表单设计器`;
  window.addEventListener("keydown", keydown);
  window.addEventListener("beforeunload", beforeUnload);
});
onBeforeUnmount(() => {
  editor.checkpoint();
  syncFormWorkflow(form.value);
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>
<template>
  <div class="application form-designer">
    <DesignerHeader
      v-model:title="form.title"
      :app-id="form.appId"
      :form-id="formId"
      active="design"
      @help="dialog = 'help'"
    />
    <main class="form-designer-shell">
      <div class="form-editor-toolbar">
        <button class="text-button guide-button" @click="dialog = 'help'">
          <AppIcon name="help" class="blue-icon" />查看新手引导</button
        ><button
          class="icon-button mobile-editor-toggle"
          aria-label="切换字段库"
          @click="togglePalette"
        >
          <AppIcon name="menu" /></button
        ><button
          class="icon-button mobile-editor-toggle"
          aria-label="切换属性面板"
          @click="toggleInspector"
        >
          <AppIcon name="settings" />
        </button>
        <div class="toolbar-spacer" />
        <span v-if="saving || dirty" class="editor-save-state" role="status">{{
          saving ? "正在保存…" : "尚未保存"
        }}</span>
        <button class="button" :disabled="saving" @click="preview = true">
          预览
        </button>
        <button class="button primary" :disabled="saving" @click="save">
          保存
        </button>
        <button
          class="icon-button form-share-button"
          aria-label="表单发布与访问链接"
          :disabled="saving"
          @click="router.push(`/apps/${form.appId}/forms/${formId}/publish`)"
        >
          <AppIcon name="share" />
        </button>
      </div>
      <div class="form-editor-body" :inert="saving || undefined">
        <aside v-show="showPalette" class="field-palette">
          <div v-if="editor.activeParent.value" class="insertion-target">
            <span
              >添加到：{{
                flattenFields(form.schema.fields).find(
                  (f) => f.id === editor.activeParent.value,
                )?.label
              }}</span
            ><button
              class="icon-button"
              aria-label="改为添加到主表单"
              @click="editor.activeParent.value = null"
            >
              <AppIcon name="close" :size="14" />
            </button>
          </div>
          <div class="palette-scroll">
            <section
              v-for="group in ['常用', '高级', '关联']"
              :key="group"
              class="palette-section"
            >
              <header>
                <h3>{{ group }}</h3>
              </header>
              <div class="palette-grid">
                <button
                  v-for="item in fieldRegistry.filter((d) => d.group === group)"
                  :key="item.type"
                  class="palette-field"
                  :data-field-type="item.type"
                  draggable="true"
                  :aria-label="`添加${item.label}`"
                  @dragstart="paletteDrag(item.type, $event)"
                  @click="add(item.type)"
                >
                  <AppIcon :name="item.icon" :size="14" /><span>{{
                    item.label
                  }}</span>
                </button>
              </div>
            </section>
          </div>
          <button class="field-recycle" @click="dialog = 'trash'">
            <AppIcon name="trash" />字段回收站<span
              v-if="editor.trash.value.length"
              >{{ editor.trash.value.length }}</span
            >
          </button>
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
            :class="{ empty: !form.schema.fields.length }"
          >
            <FieldCanvas
              :layout="form.schema.settings.layout"
              :fields="form.schema.fields"
              :selected-ids="editor.selectedIds.value"
              :active-tab-id="editor.activeTabId.value"
              @select="select"
              @context="editor.setContext"
              @drop="editor.drop"
              @duplicate="editor.duplicate"
              @remove="requestRemove([$event])"
              @move="editor.move"
            />
          </div>
        </section>
        <aside v-show="showInspector" class="form-property-panel">
          <div class="property-tabs" role="tablist" aria-label="表单配置类型">
            <button
              role="tab"
              :aria-selected="tab === 'field'"
              :class="{ active: tab === 'field' }"
              @click="tab = 'field'"
            >
              字段属性</button
            ><button
              role="tab"
              :aria-selected="tab === 'form'"
              :class="{ active: tab === 'form' }"
              @click="tab = 'form'"
            >
              表单属性
            </button>
          </div>
          <div class="form-property-scroll">
            <FieldInspector
              v-if="tab === 'field' && editor.selected.value"
              :key="editor.selected.value.id"
              :field="editor.selected.value"
              :schema="form.schema"
              :form-id="formId"
              :calculated-type-locked="
                savedCalculatedIds.has(editor.selected.value.id)
              "
              manage-subform
              :apply-schema="
                (schema) =>
                  editor.transact(() => {
                    form.schema = schema;
                  })
              "
              @update="updateField"
              @add-child="addChild"
              @select-child="select"
              @duplicate-child="(id) => editor.duplicate(id, false)"
              @remove-child="(id) => requestRemove([id])"
              @drop-child="editor.drop"
              @select-tab="(id) => editor.setContext(editor.selected.value!.id, id)"
            />
            <div
              v-else-if="tab === 'field' && editor.selectedIds.value.length > 1"
              class="multi-field-properties"
            >
              <h3>已选择 {{ editor.selectedIds.value.length }} 个字段</h3>
              <button
                class="button full-width"
                @click="
                  editor.transact(() =>
                    flattenFields(form.schema.fields)
                      .filter((f) => editor.selectedIds.value.includes(f.id))
                      .forEach((f) => (f.required = true)),
                  )
                "
              >
                全部设为必填</button
              ><button
                class="button full-width danger"
                @click="requestRemove()"
              >
                删除所选字段
              </button>
            </div>
            <div v-else-if="tab === 'field'" class="field-inspector-empty">
              点击选择字段来设置属性；<br />按住 Ctrl 或 Command
              可选择多个字段；<br />按住 Shift 可连续选择。
            </div>
            <FormSettingsInspector
              v-else
              :schema="form.schema"
              :title="form.title"
              :form-id="formId"
            />
          </div>
        </aside>
      </div>
    </main>
    <FormPreview
      v-if="preview"
      :schema="form.schema"
      :form-id="formId"
      :title="form.title"
      @close="preview = false"
    />
    <BaseDialog
      :open="!!dialog"
      :title="
        (
          {
            type: '切换字段类型',
            help: '表单设计指南',
            impact: '删除字段会影响这些配置',
            trash: '字段回收站',
          } as Record<string, string>
        )[dialog] || '表单设计'
      "
      width="560px"
      @close="dialog = ''"
    >
      <p v-if="dialog === 'type'" class="dialog-description">切换字段类型后，此字段不再脱敏显示。是否继续？</p>
      <div v-else-if="dialog === 'impact'">
        <p class="dialog-description">
          这些配置正在使用所选字段。删除后仍保留引用，发布前需要修复；也可以从字段回收站恢复。
        </p>
        <ul>
          <li v-for="impact in removalImpacts" :key="impact">{{ impact }}</li>
        </ul>
      </div>
      <template v-else-if="dialog === 'help'"
        ><div class="editor-help">
          <p>
            点击或拖拽左侧字段到画布，选中字段后在右侧设置标题、校验、选项和默认值。
          </p>
          <p>拖动字段可调整顺序。子表单和标签页可继续放入字段。</p>
          <p>
            「表单属性」可设置字段显隐条件、布局和提交按钮。「预览」支持电脑与手机尺寸，并使用实际填写校验。
          </p>
          <p>
            ⌘ / Ctrl S 保存，Z 撤销，Y 重做；Delete
            删除选中字段。切换表单与流程时保留本次编辑草稿。
          </p>
        </div></template
      >
      <div v-else-if="dialog === 'trash'">
        <FieldRecycleList :items="editor.trash.value" @restore="index => editor.restore(index) && store.notify('字段已恢复')" />
      </div>
      <template #footer
        ><button class="button" @click="dialog = ''">
          {{ dialog === "impact" ? "保留字段" : dialog === "type" ? "取消" : "关闭" }}</button
        ><button v-if="dialog === 'type'" class="button primary" @click="confirmType">切换</button><button
          v-if="dialog === 'impact'"
          class="button danger"
          @click="confirmRemove"
        >
          仍然删除字段
        </button>
      </template>
    </BaseDialog>
  </div>
</template>
