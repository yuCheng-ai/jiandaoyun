<script setup lang="ts">
import PublishAccessSettings from "./components/PublishAccessSettings.vue";
import RecordPayment from "../payments/RecordPayment.vue";
import { computed, ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { entryTitle } from "../../domain/collaboration";
import CustomButtonBar from "../../components/shared/CustomButtonBar.vue";
import AppIcon from "../../components/AppIcon.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import DesignerHeader from "../../components/shared/DesignerHeader.vue";
import FormFilling from "./components/FormFilling.vue";
import FormRuntime from "./components/FormRuntime.vue";
import { quickFillDesignSchema } from "../../domain/quickFill";
import RecordBody from "./components/RecordBody.vue";
import RecordPrintDialog from "./components/RecordPrintDialog.vue";
import RecordList from "./components/RecordList.vue";
import { useWorkspaceStore, syncFormWorkflow } from "../../stores/workspace";
import {
  flattenFields,
  countFormFields,
  copy,
  type FormValues,
} from "../../domain/form";
import { validate } from "../../domain/workflow";
import { validateFieldConfiguration } from "../../domain/fieldValidation";
import { newForm, type FormEntry } from "../../domain/workspace";
const route = useRoute(),
  router = useRouter(),
  store = useWorkspaceStore();
const formId = String(route.params.formId);
store.openForm(formId);
const form = computed(
  () =>
    store.drafts[formId] || newForm(String(route.params.appId), "未找到表单"),
);
const section = computed(() => String(route.params.section));
const dialog = ref(""),
  record = ref<FormEntry | null>(null),
  errors = ref<string[]>([]);
const runtimeKey = ref(0);
const editRuntime = ref<InstanceType<typeof FormRuntime>>();
const printOpen = ref(false);
const editDirty = ref(false),
  confirmRecordClose = ref(false);
function closeDialog() {
  if (dialog.value === "edit-record" && editDirty.value)
    confirmRecordClose.value = true;
  else dialog.value = "";
}
function discardRecordEdit() {
  editRuntime.value?.discardEdits();
  dialog.value = "";
  editDirty.value = false;
}
onMounted(() => {
  if (!store.drafts[formId]) router.replace(`/apps/${route.params.appId}`);
});
const savedForm = computed(() => store.data.forms.find((f) => f.id === formId));
const published = computed(() => savedForm.value?.published);
const runtimeSchema = computed(() =>
  published.value
    ? quickFillDesignSchema({
        schema: published.value.schema,
        workflow: published.value.workflow,
        kind: form.value.kind,
      })
    : form.value.schema,
);
const editBase = ref<FormValues>();
function editRecord(entry: FormEntry) {
  record.value = entry;
  editBase.value = copy(entry.values);
  editDirty.value = false;
  confirmRecordClose.value = false;
  dialog.value = "edit-record";
  runtimeKey.value++;
}
async function persistEdit(values: FormValues) {
  if (
    !record.value ||
    !(await store.updateEntry(
      record.value.id,
      values,
      undefined,
      undefined,
      undefined,
      editBase.value,
    ))
  )
    return false;
  store.notify("记录已更新，流程位置保持不变");
  editDirty.value = false;
  dialog.value = "record";
  return true;
}
const editSchema = computed(() => {
  const schema = copy(recordDefinition.value?.schema || runtimeSchema.value);
  for (const field of flattenFields(schema.fields))
    if (field.type === "serial") field.editable = true;
  schema.settings.allowDraft = false;
  schema.settings.cacheDraft = false;
  schema.settings.submitLabel = "保存修改";
  schema.settings.allowSubmit = true;
  return schema;
});
const publishing = ref(false);
const publishFailed = ref(false);
const recordDefinition = computed(() =>
  record.value
    ? (form.value.versions || []).find(
        (v) => v.version === record.value!.definitionVersion,
      ) || published.value
    : undefined,
);
async function publish() {
  if (publishing.value) return;
  publishFailed.value = false;
  syncFormWorkflow(form.value);
  errors.value = validateFieldConfiguration(form.value.schema, store.data);
  if (!form.value.title.trim()) errors.value.push("请填写表单名称");
  if (!form.value.schema.fields.length) errors.value.push("请先添加表单字段");
  for (const field of flattenFields(form.value.schema.fields)) {
    if (field.required && field.type === "subform" && !field.children.length)
      errors.value.push("请为必填子表单添加字段");
  }
  if (form.value.kind === "workflow")
    errors.value.push(
      ...validate(
        form.value.workflow,
        store.data.organization,
        form.value.schema,
      ).map((e) => e.message),
    );
  if (errors.value.length) {
    dialog.value = "publish-errors";
    return;
  }
  publishing.value = true;
  try {
    if (await store.publishForm(formId))
      store.notify(`已发布版本 V${published.value?.version}`);
    else {
      publishFailed.value = true;
      errors.value = [store.storageError || "发布未完成，设计已保留，请重试。"];
      dialog.value = "publish-errors";
    }
  } catch {
    publishFailed.value = true;
    errors.value = ["发布失败，设计已保留，请重试。"];
    dialog.value = "publish-errors";
  } finally {
    publishing.value = false;
  }
}
function openRecord(entry: FormEntry) {
  record.value = entry;
  dialog.value = "record";
}
async function process(action: "approved" | "rejected") {
  if (!record.value || !(await store.processEntry(record.value.id, action)))
    return;
  if (record.value.pluginError) {
    store.notify(`流程停在插件节点：${record.value.pluginError}`, "warning");
    return;
  }
  store.notify(
    action === "rejected"
      ? "已退回申请"
      : record.value.status === "approved"
        ? "流程已完成"
        : "已进入下一节点",
  );
}
</script>
<template>
  <div class="application form-section-page">
    <DesignerHeader
      v-model:title="form.title"
      :app-id="form.appId"
      :form-id="formId"
      :active="section === 'fill' ? 'publish' : section"
      @help="dialog = 'help'"
    />
    <main class="form-section-shell">
      <section
        v-if="section === 'publish'"
        class="publish-content"
        aria-label="表单发布"
      >
        <header class="publication-status" :aria-busy="publishing">
          <div class="publication-overview">
            <span class="publication-icon"
              ><AppIcon :name="published ? 'success' : 'form'" :size="22"
            /></span>
            <div>
              <h2>{{ published ? "表单已发布" : "发布表单" }}</h2>
              <p>
                {{
                  published
                    ? `当前版本 V${published.version} · ${new Date(published.publishedAt).toLocaleString("zh-CN")}`
                    : "发布后即可填写和收集数据"
                }}
              </p>
            </div>
          </div>
          <button
            class="button primary"
            :disabled="publishing"
            @click="publish"
          >
            {{
              publishing ? "正在发布…" : published ? "发布新版本" : "发布表单"
            }}
          </button>
        </header>
        <PublishAccessSettings
          :form="published && savedForm ? savedForm : form"
        >
          <details class="publish-version-list">
            <summary>版本记录</summary>
            <div
              v-for="version in [...(savedForm?.versions || [])].reverse()"
              :key="version.version"
            >
              <span class="status-tag published">V{{ version.version }}</span>
              <span>{{
                new Date(version.publishedAt).toLocaleString("zh-CN")
              }}</span>
              <span>{{ countFormFields(version.schema.fields) }} 个字段</span>
            </div>
            <p v-if="!savedForm?.versions.length" class="muted">
              暂无已发布版本
            </p>
          </details>
        </PublishAccessSettings>
      </section>
      <RecordList
        v-else-if="section === 'data'"
        :form="form"
        :schema="runtimeSchema"
        @view="openRecord"
        @edit="editRecord"
      />
      <template v-else-if="section === 'fill'">
        <header
          v-if="!runtimeSchema.settings.externalStyle"
          class="fill-page-header"
        >
          <h2>{{ published?.title || form.title }}</h2>
        </header>
        <FormFilling :form-id="formId" external-style />
      </template>
    </main>
    <BaseDialog
      :open="!!dialog"
      :busy="dialog === 'edit-record' && store.writePending"
      :title="
        dialog === 'record'
          ? '数据详情'
          : dialog === 'edit-record'
            ? '编辑记录'
            : dialog === 'publish-errors'
              ? publishFailed
                ? '发布未完成'
                : '发布前请完善配置'
              : '使用说明'
      "
      :width="['record', 'edit-record'].includes(dialog) ? '760px' : '520px'"
      @close="closeDialog"
      ><template v-if="dialog === 'edit-record' && record"
        ><div v-if="confirmRecordClose" class="config-discard" tabindex="-1">
          <span>修改尚未保存。</span
          ><button class="button" @click="confirmRecordClose = false">
            继续编辑</button
          ><button class="button" @click="discardRecordEdit">放弃修改</button>
        </div>
        <p class="field-hint">
          编辑此记录 V{{ record.definitionVersion }}
          的字段，保存后保持当前流程位置。
        </p>
        <FormRuntime
          :key="runtimeKey"
          ref="editRuntime"
          :schema="editSchema"
          row-permission-mode="unrestricted"
          :form-id="formId"
          :initial-values="record.values"
          :entry-id="record.id"
          :preview="false"
          :edit-serial="true"
          :row-baseline="record.values"
          :cache-key="`edit-${record.id}`"
          @change="editDirty = true"
          :persist-values="persistEdit"
          :existing-values="
            store.data.entries
              .filter(
                (e) =>
                  e.formId === formId &&
                  e.id !== record?.id &&
                  e.status !== 'draft' &&
                  !e.deletedAt,
              )
              .map((e) => e.values)
          " /></template
      ><template v-else-if="dialog === 'publish-errors'"
        ><ul class="validation-issues">
          <li v-for="error in errors" :key="error">{{ error }}</li>
        </ul></template
      ><template v-else-if="dialog === 'record' && record"
        ><h3 class="record-data-title">{{ entryTitle(record, store.data) }}</h3>
        <p v-if="record.deletedAt" class="config-warning">
          此记录已移入回收站，可以查看或打印；恢复后可继续处理。
        </p>
        <dl
          v-if="recordDefinition?.extensions?.detail?.showMetadata"
          class="record-meta"
        >
          <div>
            <dt>记录编号</dt>
            <dd>{{ record.id }}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{{ new Date(record.createdAt).toLocaleString("zh-CN") }}</dd>
          </div>
          <div>
            <dt>表单版本</dt>
            <dd>V{{ record.definitionVersion }}</dd>
          </div>
        </dl>
        <CustomButtonBar
          v-if="
            !record.deletedAt && record.status !== 'draft' && recordDefinition
          "
          :buttons="recordDefinition.extensions?.buttons || []"
          position="detail"
          :schema="recordDefinition.schema"
          :values="record.values"
          :form-id="formId"
          :entry-id="record.id"
        />
        <RecordPayment :entry-id="record.id" />
        <RecordBody
          v-if="recordDefinition?.extensions?.detail"
          :schema="recordDefinition.schema"
          :values="record.values"
          :settings="recordDefinition.extensions.detail"
          :entry-id="record.id"
          interactive
        />
        <FormRuntime
          v-else
          :schema="recordDefinition?.schema || runtimeSchema"
          :form-id="formId"
          :initial-values="record.values"
          :entry-id="record.id"
          readonly
        />
        <div
          v-if="record.pluginError && !record.deletedAt"
          class="config-errors"
          role="alert"
        >
          <p>{{ record.pluginError }}</p>
          <p class="field-hint">
            重试沿用此记录提交时的配置版本。修改设计草稿只影响发布后的新记录。
          </p>
          <button class="button" @click="store.retryEntryPlugin(record.id)">
            重试当前插件
          </button>
        </div>
        <div
          v-if="
            record.history.length &&
            recordDefinition?.extensions?.detail?.showHistory !== false
          "
          class="entry-history"
        >
          <h3>操作记录</h3>
          <div v-for="(item, index) in record.history" :key="index">
            <AppIcon name="success" /><span
              >{{ item.label }} · {{ item.action
              }}<small>{{
                new Date(item.time).toLocaleString("zh-CN")
              }}</small></span
            >
          </div>
        </div></template
      >
      <p v-else class="dialog-description">
        表单设计、流程配置和发布版本分别保存。发布后修改设计不会影响已发布版本，发布新版本后填写页面才会更新。
      </p>
      <template #footer
        ><button class="button" @click="closeDialog">关闭</button
        ><button
          v-if="dialog === 'publish-errors' && !publishFailed"
          class="button primary"
          @click="
            dialog = '';
            router.push(`/apps/${form.appId}/forms/${formId}/design`);
          "
        >
          返回表单设计</button
        ><button
          v-if="dialog === 'publish-errors' && publishFailed"
          class="button primary"
          @click="
            dialog = '';
            publish();
          "
        >
          重试发布</button
        ><button
          v-if="dialog === 'record' && record"
          class="button"
          @click="printOpen = true"
        >
          <AppIcon name="print" />打印记录</button
        ><button
          v-if="
            dialog === 'record' &&
            record &&
            !record.deletedAt &&
            record.status !== 'draft' &&
            recordDefinition
          "
          class="button"
          @click="editRecord(record)"
        >
          <AppIcon name="edit" />编辑</button
        ><template
          v-if="
            dialog === 'record' &&
            record?.status === 'submitted' &&
            !record.deletedAt &&
            !record.pluginError &&
            form.kind === 'workflow'
          "
          ><button class="button" @click="process('rejected')">退回</button
          ><button class="button primary" @click="process('approved')">
            同意
          </button></template
        ></template
      ></BaseDialog
    >
    <RecordPrintDialog
      v-if="record"
      :open="printOpen"
      :schema="recordDefinition?.schema || runtimeSchema"
      :title="recordDefinition?.title || form.title"
      :entry="record"
      :templates="recordDefinition?.extensions?.printTemplates || []"
      @close="printOpen = false"
    />
  </div>
</template>
