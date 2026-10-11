<script setup lang="ts">
import { hasFieldValue } from "@platform/contracts";
import { computed, ref, provide, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter, onBeforeRouteLeave } from "vue-router";
import { useWorkspaceStore } from "../../stores/workspace";
import { copy, type FormSchema, type FormValues } from "../../domain/form";
import {
  accessConfig,
  eligibleGroups,
  groupsForEntry,
  memberSchema,
  visibleValues,
  memberContext,
  canEntry,
  creationSchema,
  fillingIssue,
  entryAccessSchema,
  type MemberAction,
} from "../../domain/access";
import { entryDefinition, renderDataTitle } from "../../domain/collaboration";
import { displayValue, scopeFields } from "../../domain/relations";
import { defaultDetailSettings } from "../../domain/presentation";
import type { FormEntry } from "../../domain/workspace";
import { runtimeDataKey } from "../../composables/useRuntimeData";
import BaseDialog from "../../components/BaseDialog.vue";
import AppIcon from "../../components/AppIcon.vue";
import FormRuntime from "./components/FormRuntime.vue";
import RecordBody from "./components/RecordBody.vue";
import RecordPrintDialog from "./components/RecordPrintDialog.vue";
import RecordPayment from "../payments/RecordPayment.vue";
import { downloadCsv } from "../../services/downloadCsv";
import { downloadExcel } from "../../services/excel";
import { recordExcelExport } from "../../domain/records";
import { sameWorkspaceValue } from "../../domain/workspaceSync";
import RecordExportDialog from "./components/RecordExportDialog.vue";
import RecordImportDialog from "./components/RecordImportDialog.vue";
const store = useWorkspaceStore(),
  route = useRoute(),
  router = useRouter(),
  formId = String(route.params.formId);
const form = computed(() => store.data.forms.find((f) => f.id === formId)),
  member = ref(store.data.organization.currentUserId),
  selection = ref("*"),
  query = ref(""),
  page = ref(1),
  dialog = ref(""),
  record = ref<FormEntry>(),
  dirty = ref(false),
  confirmExit = ref(false),
  printOpen = ref(false),
  revision = ref(0),
  snapshot = ref<FormValues>({}),
  permissionSnapshot = ref<FormSchema>(),
  exportError = ref(""),
  exportOpen = ref(false),
  exportingFile = ref(false),
  exportFormat = ref("xlsx"),
  exportIds = ref(false);
const importOpen = ref(false);
const context = computed(() => memberContext(store.data, member.value));
const lastPaymentEntry = ref("");
watch([member, selection], () => (lastPaymentEntry.value = ""));
provide(runtimeDataKey, context);
const groups = computed(() =>
    eligibleGroups(store.data, formId, member.value, ""),
  ),
  config = computed(() => accessConfig(store.data, formId));
watch(
  [member, groups, () => config.value.allowMerged],
  () => {
    if (selection.value === "*" && config.value.allowMerged) return;
    if (!groups.value.some((g) => g.id === selection.value))
      selection.value = config.value.allowMerged
        ? "*"
        : groups.value[0]?.id || "";
  },
  { immediate: true },
);
watch([member, selection, query], () => (page.value = 1));
const chosen = computed(() =>
  eligibleGroups(store.data, formId, member.value, selection.value),
);
const canCreate = computed(() =>
    chosen.value.some((g) => g.actions.includes("create")),
  ),
  fillIssue = computed(() => fillingIssue(store.data, formId, member.value));
const canImport = computed(() =>
  chosen.value.some((g) => g.actions.includes("import")),
);
function openImport() {
  if (!store.refreshForRead()) {
    store.notify("暂时无法读取最新数据，请稍后再次导入。", "warning");
    return;
  }
  if (canImport.value && form.value?.published) importOpen.value = true;
}
function recordSchema(
  e: FormEntry,
  editing = false,
  action: MemberAction = "view",
) {
  if (action !== "view")
    return entryAccessSchema(
      store.data,
      e,
      member.value,
      selection.value,
      action,
    );
  const d = entryDefinition(e, store.data);
  return d
    ? memberSchema(
        d.schema,
        groupsForEntry(store.data, e, member.value, selection.value),
        editing,
      )
    : undefined;
}
function title(e: FormEntry, action: MemberAction = "view") {
  const d = entryDefinition(e, store.data),
    schema = recordSchema(e, false, action);
  return schema && d
    ? renderDataTitle(
        d.extensions?.collaboration,
        schema,
        e.values,
        context.value,
        `${d.title} · ${e.id.slice(-6)}`,
      )
    : "记录";
}
const entries = computed(() =>
  store.data.entries
    .filter(
      (e) =>
        e.formId === formId &&
        canEntry(store.data, e, member.value, "view", selection.value),
    )
    .filter((e) => {
      const schema = recordSchema(e)!;
      return `${title(e)} ${scopeFields(schema.fields)
        .filter((f) => f.visible)
        .map((f) =>
          displayValue(f, visibleValues(schema, e.values)[f.id], context.value),
        )
        .join(" ")}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase());
    }),
);
const pages = computed(() => Math.max(1, Math.ceil(entries.value.length / 20))),
  rows = computed(() =>
    entries.value.slice((page.value - 1) * 20, page.value * 20),
  );
watch(pages, (n) => (page.value = Math.min(page.value, n)));
const columns = computed(() =>
  scopeFields(form.value?.published?.schema.fields || []).filter(
    (f) =>
      hasFieldValue(f) &&
      entries.value.some(
        (e) =>
          recordSchema(e)?.fields &&
          scopeFields(recordSchema(e)!.fields).some(
            (c) => c.id === f.id && c.visible,
          ),
      ),
  ),
);
function cell(e: FormEntry, id: string, action: MemberAction = "view") {
  const schema = recordSchema(e, false, action)!,
    f = scopeFields(schema.fields).find((f) => f.id === id);
  return f?.visible
    ? displayValue(f, visibleValues(schema, e.values)[id], context.value)
    : "—";
}
const activeSchema = computed(() =>
  record.value
    ? recordSchema(record.value, dialog.value === "edit")
    : undefined,
);
const activeValues = computed(() =>
  record.value
    ? // The local runtime evaluates conditions/calculations against the complete
      // record; the permission schema controls every rendered field.
      copy(record.value.values)
    : {},
);
const printSchema = computed(() =>
  record.value ? recordSchema(record.value, false, "print") : undefined,
);
const printEntry = computed(() =>
  record.value && printSchema.value
    ? {
        ...record.value,
        values: copy(record.value.values),
        history: [],
      }
    : undefined,
);
const draftSchema = computed(() =>
  form.value?.published ? creationSchema(form.value) : undefined,
);
function open(e: FormEntry, mode: string) {
  record.value = e;
  snapshot.value = copy(e.values);
  permissionSnapshot.value = copy(recordSchema(e, mode === "edit"));
  dialog.value = mode;
  dirty.value = false;
  revision.value++;
}
function create() {
  dialog.value = "create";
  record.value = undefined;
  dirty.value = false;
  revision.value++;
}
async function save(values: FormValues) {
  if (dialog.value === "create") {
    const entry = await store.memberSubmit(
      formId,
      member.value,
      selection.value,
      values,
    );
    if (!entry) return false;
    lastPaymentEntry.value = entry.id;
  } else if (
    !record.value ||
    !(await store.memberUpdate(
      record.value.id,
      member.value,
      selection.value,
      values,
      snapshot.value,
      permissionSnapshot.value,
    ))
  )
    return false;
  dirty.value = false;
  dialog.value = "";
  store.notify("成员操作已保存");
  return true;
}
async function remove() {
  if (
    record.value &&
    (await store.memberDelete(record.value.id, member.value, selection.value))
  ) {
    dialog.value = "";
    store.notify("记录已移入回收站，管理员可恢复");
  }
}
function close() {
  if (dirty.value) confirmExit.value = true;
  else dialog.value = "";
}
const editRuntime = ref<InstanceType<typeof FormRuntime>>();
let pending: ((allow: boolean) => void) | undefined;
onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  confirmExit.value = true;
  return new Promise<boolean>((resolve) => (pending = resolve));
});
function exit(discard: boolean) {
  confirmExit.value = false;
  if (discard) {
    editRuntime.value?.discardEdits();
    dirty.value = false;
    dialog.value = "";
  }
  pending?.(discard);
  pending = undefined;
}
function unload(e: BeforeUnloadEvent) {
  if (!dirty.value) return;
  editRuntime.value?.flushDraft();
  if (!editRuntime.value?.retainedDraft) e.preventDefault();
}
window.addEventListener("beforeunload", unload);
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", unload);
  pending?.(false);
});
const exportable = computed(() =>
  entries.value.filter((e) =>
    canEntry(store.data, e, member.value, "export", selection.value),
  ),
);
function openExport() {
  exportError.value = "";
  exportOpen.value = true;
  if (!store.refreshForRead())
    exportError.value = "暂时无法读取最新数据，请稍后再次导出。";
}
function prepareExport() {
  const allowed = exportable.value;
  if (!allowed.length)
    throw Error("当前结果没有可导出的记录，请核对权限或筛选条件。");
  const records = allowed.map((entry) => {
    const schema = recordSchema(entry, false, "export");
    if (!schema) throw Error("记录原表单版本不可用，请核对后导出");
    return {
      entry: { ...entry, values: visibleValues(schema, entry.values) },
      schema: {
        ...schema,
        fields: scopeFields(schema.fields)
          .filter((f) => f.visible)
          .map((f) => ({
            ...f,
            children:
              f.type === "subform"
                ? scopeFields(f.children).filter((child) => child.visible)
                : f.children,
          })),
      },
      extra: [...(exportIds.value ? [entry.id] : []), title(entry, "export")],
    };
  });
  const exportedFields = columns.value.flatMap((f) => {
    const visible = records
      .map((r) => scopeFields(r.schema.fields).find((c) => c.id === f.id))
      .filter((c) => !!c);
    if (!visible.length) return [];
    return [
      {
        ...f,
        children:
          f.type === "subform"
            ? f.children.filter((child) =>
                visible.some((c) =>
                  scopeFields(c.children).some((v) => v.id === child.id),
                ),
              )
            : f.children,
      },
    ];
  });
  const headers = [...(exportIds.value ? ["data_id"] : []), "数据标题"];
  return {
    count: allowed.length,
    csv: [
      [...headers, ...exportedFields.map((f) => f.label)],
      ...allowed.map((e) => [
        ...(exportIds.value ? [e.id] : []),
        title(e, "export"),
        ...exportedFields.map((f) => cell(e, f.id, "export")),
      ]),
    ],
    excel:
      exportFormat.value === "csv"
        ? undefined
        : recordExcelExport(context.value, exportedFields, headers, records),
  };
}
async function exportRows() {
  if (exportingFile.value) return;
  exportError.value = "";
  exportingFile.value = true;
  let prepared = false;
  try {
    if (!store.refreshForRead())
      throw Error("暂时无法读取最新数据，请稍后再次导出。");
    const output = prepareExport();
    const actor = member.value,
      group = selection.value;
    prepared = true;
    const filename = form.value?.published?.title || "成员数据";
    if (exportFormat.value === "csv")
      downloadCsv(filename + ".csv", output.csv);
    else
      await downloadExcel(
        filename + ".xlsx",
        output.excel!.rows,
        output.excel!.fieldIds,
        output.excel!.merges,
        () => {
          if (!store.refreshForRead())
            throw Error("暂时无法读取最新数据，请稍后再次导出。");
          if (
            actor !== member.value ||
            group !== selection.value ||
            !sameWorkspaceValue(output, prepareExport())
          )
            throw Error("待导出的数据或权限已变化，请核对当前结果后重新导出。");
        },
      );
    store.notify(`已请求导出 ${output.count} 条有导出权限的记录`);
    exportOpen.value = false;
  } catch (error) {
    exportError.value =
      !prepared && error instanceof Error
        ? error.message
        : "未能发起下载，当前筛选和导出设置已保留，请核对权限后再次导出。";
  } finally {
    exportingFile.value = false;
  }
}
</script>
<template>
  <div class="application member-portal">
    <header class="member-header">
      <button
        class="icon-button"
        aria-label="返回发布设置"
        @click="router.push(`/apps/${form?.appId}/forms/${formId}/publish`)"
      >
        <AppIcon name="back" />
      </button>
      <div>
        <h1>{{ form?.published?.title || "表单不可用" }}</h1>
        <small>成员视图 · 本地体验</small>
      </div>
    </header>
    <main class="member-content">
      <p class="access-context-note">
        切换成员可检查真实的本地操作效果；当前浏览器未接入账号认证。
      </p>
      <fieldset
        class="member-filters"
        :disabled="!!dialog || printOpen || exportOpen || importOpen"
      >
        <label
          >体验成员<select v-model="member">
            <option
              v-for="e in store.data.organization.employees.filter(
                (e) => e.status === 'active',
              )"
              :key="e.id"
              :value="e.id"
            >
              {{ e.name }}
            </option>
          </select></label
        ><label
          >权限组<select v-model="selection">
            <option v-if="config.allowMerged && groups.length" value="*">
              全部有权限的数据
            </option>
            <option v-for="g in groups" :key="g.id" :value="g.id">
              {{ g.name }}
            </option>
          </select></label
        >
      </fieldset>
      <div v-if="!chosen.length" class="access-empty">
        <h2>当前成员没有可用的访问权限</h2>
        <p>请在发布设置中启用成员访问，并为该成员分配有效权限组。</p>
      </div>
      <template v-else>
        <div class="member-summary">
          <span>{{ chosen.map((g) => g.name).join("、") }}</span
          ><span>{{ entries.length }} 条可查看记录</span>
        </div>
        <div class="access-toolbar">
          <input
            v-model="query"
            aria-label="搜索有权限的数据"
            placeholder="搜索可见字段和标题"
          /><button class="button" v-if="canImport" @click="openImport">
            导入</button
          ><button
            class="button"
            v-if="
              entries.some((e) =>
                canEntry(store.data, e, member, 'export', selection),
              )
            "
            @click="openExport"
          >
            导出当前结果</button
          ><button
            class="button primary"
            v-if="canCreate"
            :disabled="!!fillIssue"
            @click="create"
          >
            新增数据
          </button>
        </div>
        <p v-if="canCreate && fillIssue" class="access-warning">
          {{ fillIssue }}
        </p>
        <RecordPayment
          v-if="lastPaymentEntry"
          :key="lastPaymentEntry"
          :entry-id="lastPaymentEntry"
          :scope="{ actorId: member, selection }"
          auto-start
        />
        <div class="member-table-scroll">
          <table class="forms-table">
            <thead>
              <tr>
                <th>数据标题</th>
                <th v-for="f in columns" :key="f.id">{{ f.label }}</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in rows" :key="entry.id">
                <td>
                  <button class="text-button" @click="open(entry, 'view')">
                    {{ title(entry) }}
                  </button>
                </td>
                <td v-for="f in columns" :key="f.id">
                  {{ cell(entry, f.id) }}
                </td>
                <td>
                  <div class="member-row-actions">
                    <button class="text-button" @click="open(entry, 'view')">
                      查看</button
                    ><button
                      v-if="
                        canEntry(store.data, entry, member, 'edit', selection)
                      "
                      class="text-button"
                      @click="open(entry, 'edit')"
                    >
                      编辑</button
                    ><button
                      v-if="
                        canEntry(store.data, entry, member, 'delete', selection)
                      "
                      class="text-button danger"
                      @click="open(entry, 'delete')"
                    >
                      删除</button
                    ><button
                      v-if="
                        canEntry(store.data, entry, member, 'print', selection)
                      "
                      class="text-button"
                      @click="
                        record = entry;
                        printOpen = true;
                      "
                    >
                      打印
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!rows.length" class="access-empty">
            {{
              query
                ? "没有匹配的可见数据"
                : "暂无可查看的数据；有添加权限时可先新增记录。"
            }}
          </p>
        </div>
        <div class="member-pagination">
          <button class="button" :disabled="page === 1" @click="page--">
            上一页</button
          ><span>{{ page }} / {{ pages }}</span
          ><button class="button" :disabled="page === pages" @click="page++">
            下一页
          </button>
        </div>
      </template>
    </main>
    <BaseDialog
      :open="['create', 'view', 'edit'].includes(dialog)"
      :title="
        dialog === 'create'
          ? '新增数据'
          : dialog === 'edit'
            ? '编辑记录'
            : '记录详情'
      "
      width="850px"
      @close="close"
    >
      <FormRuntime
        v-if="dialog === 'create' && draftSchema"
        ref="editRuntime"
        :key="revision"
        :schema="draftSchema"
        :quick-fill="form?.published?.extensions?.quickFill"
        :form-id="formId"
        :cache-key="`member-create-${selection}`"
        :preview="false"
        :persist-values="save"
        @change="dirty = true"
      />
      <FormRuntime
        v-else-if="dialog === 'edit' && record && activeSchema"
        ref="editRuntime"
        :key="revision"
        :schema="activeSchema"
        :initial-values="activeValues"
        :row-permission-mode="record.status === 'draft' ? 'fill' : 'record'"
        :row-baseline="record.status === 'draft' ? undefined : activeValues"
        editable-validation-only
        :entry-id="record.id"
        :form-id="formId"
        :cache-key="`member-edit-${selection}`"
        :preview="false"
        :persist-values="save"
        @change="dirty = true"
      />
      <template v-else-if="record && activeSchema"
        ><h3>{{ title(record) }}</h3>
        <RecordPayment
          :entry-id="record.id"
          :scope="{ actorId: member, selection }" />
        <RecordBody
          :schema="activeSchema"
          :values="activeValues"
          :settings="defaultDetailSettings()"
          :entry-id="record.id"
          interactive
      /></template>
    </BaseDialog>
    <BaseDialog
      :open="dialog === 'delete'"
      title="删除这条记录？"
      @close="dialog = ''"
      ><p>记录将移入回收站，管理员可以恢复。</p>
      <template #footer
        ><button class="button" @click="dialog = ''">取消</button
        ><button class="button primary" @click="remove">
          移入回收站
        </button></template
      ></BaseDialog
    >
    <BaseDialog :open="confirmExit" title="修改尚未保存" @close="exit(false)"
      ><p>离开将丢失当前修改。</p>
      <template #footer
        ><button class="button" @click="exit(false)">继续编辑</button
        ><button class="button" @click="exit(true)">放弃修改</button></template
      ></BaseDialog
    >
    <RecordExportDialog
      :open="exportOpen"
      :count="exportable.length"
      :busy="exportingFile"
      :error="exportError"
      v-model:format="exportFormat"
      v-model:include-ids="exportIds"
      @close="exportOpen = false"
      @export="exportRows"
    />
    <RecordImportDialog
      v-if="importOpen && form?.published"
      :form="form"
      :member="{ actorId: member, selection }"
      @close="importOpen = false"
    />
    <RecordPrintDialog
      v-if="record && printSchema && printEntry"
      :open="
        printOpen && canEntry(store.data, record, member, 'print', selection)
      "
      :schema="printSchema"
      :title="title(record, 'print')"
      :templates="[]"
      :entry="printEntry"
      @close="printOpen = false"
    />
  </div>
</template>
