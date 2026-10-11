<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
  type RouteLocationNormalized,
} from "vue-router";
import { useWorkspaceStore } from "../../../stores/workspace";
import { accessConfig, fillingIssue } from "../../../domain/access";
import { fillingSession } from "../../../domain/fillingSession";
import { copy, type FormValues } from "../../../domain/form";
import { quickFillDesignSchema } from "../../../domain/quickFill";
import FormRuntime from "./FormRuntime.vue";
import ExternalFormFrame from "./ExternalFormFrame.vue";
import RecordPayment from "../../payments/RecordPayment.vue";
import BaseDialog from "../../../components/BaseDialog.vue";
const props = defineProps<{ formId: string; externalStyle?: boolean }>();
const store = useWorkspaceStore(),
  route = useRoute(),
  router = useRouter();
const form = computed(() =>
  store.data.forms.find((item) => item.id === props.formId),
);
const editingDraftId = ref(String(route.query.draft || ""));
// One filling session owns its original publication and draft baseline.
const filling = copy(
  fillingSession(
    store.data,
    props.formId,
    editingDraftId.value,
    store.data.organization.currentUserId,
  ),
);
const prefillToken = String(route.query.prefill || "");
const prefill = prefillToken
  ? store.consumePrefill(
      prefillToken,
      props.formId,
      filling.definition?.version || 0,
    )
  : undefined;
onMounted(() => {
  if (prefillToken && !prefill)
    store.notify("带入数据已失效，请从原记录重新打开表单", "warning");
});
const schema = computed(
  () =>
    filling.definition &&
    quickFillDesignSchema({
      schema: filling.definition.schema,
      workflow: filling.definition.workflow,
      kind: form.value?.kind || "form",
    }),
);
const restriction = computed(() =>
  filling.draft &&
  filling.draft.createdBy !== store.data.organization.currentUserId
    ? "只能继续填写自己保存的草稿。"
    : filling.issue ||
      (!accessConfig(store.data, props.formId).publicEnabled
        ? "本地填写链接已关闭"
        : fillingIssue(
            store.data,
            props.formId,
            store.data.organization.currentUserId,
          )),
);
const runtime = ref<InstanceType<typeof FormRuntime>>(),
  lastSubmittedId = ref("");
async function persistValues(values: FormValues, draft: boolean) {
  if (restriction.value) {
    store.notify(restriction.value, "warning");
    return false;
  }
  const entry = await store.submitEntry(
    props.formId,
    values,
    draft ? "draft" : "submitted",
    editingDraftId.value,
  );
  if (!entry) return false;
  if (!draft) lastSubmittedId.value = entry.id;
  editingDraftId.value = draft ? entry.id : "";
  store.notify(draft ? "填写草稿已保存" : "数据已保存到当前工作台");
  return true;
}
function syncDraftLocation() {
  if (editingDraftId.value)
    void router.replace({
      query: {
        ...route.query,
        ...(!route.params.formId ? { form: props.formId } : {}),
        draft: editingDraftId.value,
      },
    });
}
function startAnother() {
  lastSubmittedId.value = "";
  if (route.query.draft || route.query.prefill) {
    const { draft, prefill, ...query } = route.query;
    void router.replace({ query });
  }
}
const leaveAction = ref<() => void | Promise<void>>();
function canLeave(action: () => void | Promise<void>) {
  if (runtime.value?.pending) {
    store.notify("正在保存，请稍候", "warning");
    return false;
  }
  if (!runtime.value?.hasChanges) return true;
  runtime.value.flushDraft();
  if (runtime.value.retainedDraft) return true;
  leaveAction.value = action;
  return false;
}
function guard(to: RouteLocationNormalized) {
  return canLeave(() => {
    runtime.value?.discardEdits();
    void router.push(to.fullPath);
  });
}
async function runAfterLeave(action: () => void | Promise<void>) {
  if (canLeave(action)) await action();
}
defineExpose({ runAfterLeave });
onBeforeRouteLeave(guard);
onBeforeRouteUpdate(guard);
function discardAndLeave() {
  const action = leaveAction.value;
  leaveAction.value = undefined;
  void action?.();
}
</script>
<template>
  <div
    v-if="restriction || !schema"
    class="application-form-unavailable"
    role="status"
  >
    <p>{{ restriction || "表单尚未发布" }}</p>
    <button
      v-if="form"
      class="button"
      @click="router.push(`/apps/${form.appId}/forms/${form.id}/publish`)"
    >
      查看发布设置
    </button>
  </div>
  <div v-else class="application-fill-scroll">
    <ExternalFormFrame
      :appearance="externalStyle ? schema.settings.externalStyle : undefined"
      :title="filling.definition!.title"
    >
      <FormRuntime
        ref="runtime"
        :schema="schema"
        :form-id="formId"
        :external="true"
        :preview="false"
        :existing-values="
          store.data.entries
            .filter(
              (entry) =>
                entry.formId === formId &&
                entry.status !== 'draft' &&
                !entry.deletedAt,
            )
            .map((entry) => entry.values)
        "
        :initial-values="filling.draft?.values || prefill"
        :entry-id="filling.draft?.id"
        :buttons="filling.definition!.extensions?.buttons || []"
        :quick-fill="filling.definition!.extensions?.quickFill"
        :cache-key="`${filling.definition!.version}-${prefillToken}`"
        :persist-values="persistValues"
        @draft="syncDraftLocation"
        @continue="startAnother"
      />
      <RecordPayment
        v-if="lastSubmittedId"
        :key="lastSubmittedId"
        :entry-id="lastSubmittedId"
        auto-start
      />
    </ExternalFormFrame>
  </div>
  <BaseDialog
    :open="!!leaveAction"
    title="离开当前表单？"
    width="420px"
    @close="leaveAction = undefined"
  >
    <p>填写内容尚未保存。</p>
    <template #footer
      ><button class="button" @click="leaveAction = undefined">继续填写</button
      ><button class="button" @click="discardAndLeave">
        放弃填写并离开
      </button></template
    >
  </BaseDialog>
</template>

<style scoped>
.application-fill-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
