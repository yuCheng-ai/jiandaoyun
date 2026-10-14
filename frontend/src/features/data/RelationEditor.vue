<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import { valueMappingCompatible } from "@platform/contracts";
import type {
  DataModel,
  DefinitionSummary,
  RelationDefinition,
  RelationSpec,
} from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi, PlatformError } from "../../repositories/platformApi";
import { useNotices } from "../../stores/notices";
const { notify } = useNotices();
const props = defineProps<{
  sourceId: string;
  objects: DefinitionSummary[];
  relation?: RelationDefinition;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const saved = ref(props.relation);
const spec = ref<RelationSpec>(
  props.relation
    ? JSON.parse(JSON.stringify(props.relation.spec))
    : {
        title: "",
        sourceDefinitionId: props.sourceId,
        targetDefinitionId: "",
        cardinality: "many",
        inverseCardinality: "many",
        labelFieldId: "",
        columns: [],
        filters: [],
        mappings: [],
        valueMode: "live",
      },
);
const models = ref<Record<string, DataModel>>({}),
  busy = ref(false),
  error = ref("");
const conflict = ref(false),
  reloadConfirm = ref(false);
let createFingerprint = "",
  createKey = "";
const sourceModel = computed(() => models.value[spec.value.sourceDefinitionId]);
const sourceFields = computed(
  () =>
    (spec.value.sourceSubformId
      ? sourceModel.value?.fields.find(
          (f) => f.id === spec.value.sourceSubformId,
        )?.children
      : sourceModel.value?.fields
    )?.filter((f) => f.kind !== "subform") || [],
);
const targetFields = computed(
  () =>
    models.value[spec.value.targetDefinitionId]?.fields.filter(
      (f) => f.kind !== "subform",
    ) || [],
);
const { requestClose, confirmLeave, confirmDiscard, discard, markSaved } =
  useDraftDismiss(
    () => true,
    () => spec.value,
    () => emit("close"),
  );
// 同一应用切换表单也会重建编辑器，和离开页面共用未保存确认。
const allowNavigation = () => !busy.value && confirmLeave();
onBeforeRouteLeave(allowNavigation);
onBeforeRouteUpdate(allowNavigation);
async function loadModels() {
  busy.value = true;
  error.value = "";
  try {
    const entries = await Promise.all(
      props.objects
        .filter((o) => o.latestVersion)
        .map(
          async (o) =>
            [
              o.id,
              await platformApi<DataModel>(
                `/data-objects/${o.id}/versions/${o.latestVersion}`,
              ),
            ] as const,
        ),
    );
    models.value = Object.fromEntries(entries);
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(loadModels);
function changeTarget() {
  spec.value.labelFieldId = targetFields.value[0]?.id || "";
  spec.value.columns = [];
  spec.value.filters = [];
  spec.value.mappings = [];
}
function changeScope() {
  spec.value.filters = [];
  spec.value.mappings = [];
}
function addFilter() {
  spec.value.filters.push({
    id: `filter_${crypto.randomUUID().replaceAll("-", "")}`,
    sourceFieldId: targetFields.value[0]?.id || "",
    operator: "equals",
    source: "constant",
    value: "",
  });
}
function addMapping() {
  spec.value.mappings.push({
    fromTargetFieldId: targetFields.value[0]?.id || "",
    toSourceFieldId: "",
  });
}
function sourceChoices(targetId: string) {
  const field = targetFields.value.find((f) => f.id === targetId);
  return sourceFields.value.filter(
    (f) => field && valueMappingCompatible(field, f),
  );
}
async function save(publish: boolean) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  conflict.value = false;
  try {
    if (
      !spec.value.title.trim() ||
      !spec.value.targetDefinitionId ||
      !spec.value.labelFieldId
    )
      throw new Error("请填写关系名称、目标数据及记录标题。");
    const fingerprint = JSON.stringify(spec.value);
    if (fingerprint !== createFingerprint) {
      createFingerprint = fingerprint;
      createKey = crypto.randomUUID();
    }
    saved.value = await platformApi<RelationDefinition>(
      saved.value ? `/relations/${saved.value.id}` : "/relations",
      saved.value ? "PUT" : "POST",
      {
        spec: spec.value,
        expectedRevision: saved.value?.revision,
        ...(!saved.value ? { requestId: createKey } : {}),
      },
    );
    markSaved();
    if (publish) {
      saved.value = await platformApi<RelationDefinition>(
        `/relations/${saved.value.id}/publish`,
        "POST",
        { expectedRevision: saved.value.revision },
      );
      emit("saved");
    } else {
      notify("关系草稿已保存");
    }
  } catch (cause) {
    error.value = (cause as Error).message;
    conflict.value = cause instanceof PlatformError && cause.status === 409;
  } finally {
    busy.value = false;
  }
}
async function reloadSaved() {
  if (!saved.value) return;
  busy.value = true;
  try {
    const latest = (
      await platformApi<RelationDefinition[]>(
        `/relations?definitionId=${spec.value.sourceDefinitionId}`,
      )
    ).find((r) => r.id === saved.value!.id);
    if (!latest) throw new Error("关系已不可用，请关闭后重新检查。");
    saved.value = latest;
    spec.value = JSON.parse(JSON.stringify(latest.spec));
    markSaved();
    error.value = "";
    conflict.value = false;
    reloadConfirm.value = false;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <BaseDialog
    :open="true"
    :title="saved ? `关系配置 · ${saved.spec.title}` : '新建数据关系'"
    width="860px"
    :busy="busy"
    @close="requestClose"
  >
    <p class="collab-help">
      先确定哪些业务记录需要关联，再设置选择条件和展示内容。字段回填仅在建立关联时执行。
    </p>
    <p v-if="error" class="collab-error" role="alert">
      {{ error }}
      <button v-if="!sourceModel" class="text-button" @click="loadModels">
        重新加载字段</button
      ><button
        v-if="conflict && saved"
        class="text-button"
        @click="reloadConfirm = true"
      >
        检查最新配置
      </button>
    </p>
    <div v-if="reloadConfirm" class="collab-notice">
      重新读取将替换当前输入。<button
        class="button"
        @click="reloadConfirm = false"
      >
        保留输入</button
      ><button class="button" @click="reloadSaved">放弃输入并读取</button>
    </div>
    <div
      v-if="confirmDiscard"
      class="config-discard collab-notice"
      tabindex="-1"
    >
      有未保存的关系配置。<button
        class="button"
        @click="confirmDiscard = false"
      >
        继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </div>
    <label class="collab-field"
      >关系名称<input
        v-model="spec.title"
        maxlength="100"
        placeholder="例如：关联交付单"
    /></label>
    <div class="relation-grid">
      <label class="collab-field"
        >来源数据<input
          :value="objects.find((o) => o.id === spec.sourceDefinitionId)?.title"
          disabled
      /></label>
      <label class="collab-field"
        >关联位置<select
          v-model="spec.sourceSubformId"
          :disabled="!!saved"
          @change="changeScope"
        >
          <option :value="undefined">整条记录</option>
          <option
            v-for="field in sourceModel?.fields.filter(
              (f) => f.kind === 'subform',
            )"
            :key="field.id"
            :value="field.id"
          >
            每一行{{ field.name }}
          </option>
        </select></label
      >
      <label class="collab-field"
        >目标数据<select
          v-model="spec.targetDefinitionId"
          :disabled="!!saved"
          @change="changeTarget"
        >
          <option value="">请选择已发布的数据对象</option>
          <option
            v-for="object in objects.filter((o) => o.latestVersion)"
            :key="object.id"
            :value="object.id"
          >
            {{ object.title }}
          </option>
        </select></label
      >
      <label class="collab-field"
        >可关联数量<select
          v-model="spec.cardinality"
          :disabled="!!spec.mappings.length"
        >
          <option value="many">多条记录</option>
          <option value="one">一条记录</option>
        </select></label
      >
      <label class="collab-field"
        >目标归属<select v-model="spec.inverseCardinality">
          <option value="many">允许多个来源关联同一目标</option>
          <option value="one">一个目标只能归属一个来源位置</option>
        </select></label
      >
      <label class="collab-field"
        >关联内容显示<select v-model="spec.valueMode">
          <option value="live">显示目标当前数据</option>
          <option value="snapshot">保留建立关联时的数据</option>
        </select></label
      >
    </div>
    <p class="collab-help">
      {{
        spec.valueMode === "snapshot"
          ? "保留关联时的展示值，查看时仍检查成员当前权限。"
          : "目标数据更新后，关联区域显示最新值。"
      }}
      重新发布仅改变后续新关联，已有关系保留原版本。
    </p>
    <template v-if="targetFields.length">
      <label class="collab-field"
        >记录标题<select v-model="spec.labelFieldId">
          <option
            v-for="field in targetFields"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name }}
          </option>
        </select></label
      >
      <fieldset class="relation-options">
        <legend>展示字段</legend>
        <label v-for="field in targetFields" :key="field.id"
          ><input
            v-model="spec.columns"
            type="checkbox"
            :value="field.id"
            :disabled="
              spec.columns.length >= 12 && !spec.columns.includes(field.id)
            "
          />
          {{ field.name }}</label
        >
      </fieldset>
      <div class="collab-toolbar relation-section-title">
        <strong>选择条件</strong
        ><button
          class="text-button"
          :disabled="spec.filters.length >= 10"
          @click="addFilter"
        >
          添加筛选条件
        </button>
      </div>
      <p class="collab-help">
        所有条件同时满足才可选择；本表字段使用已保存的记录或明细行值。
      </p>
      <div
        v-for="(filter, index) in spec.filters"
        :key="filter.id"
        class="relation-rule"
      >
        <select
          v-model="filter.sourceFieldId"
          :aria-label="`筛选 ${index + 1} 目标字段`"
        >
          <option
            v-for="field in targetFields"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name }}
          </option>
        </select>
        <select
          v-model="filter.operator"
          :aria-label="`筛选 ${index + 1} 比较方式`"
          @change="
            filter.operator === 'notEmpty' &&
            ((filter.source = 'constant'), (filter.value = ''))
          "
        >
          <option value="equals">等于</option>
          <option value="notEquals">不等于</option>
          <option value="contains">包含</option>
          <option value="greater">大于</option>
          <option value="less">小于</option>
          <option value="notEmpty">不为空</option>
        </select>
        <template v-if="filter.operator !== 'notEmpty'"
          ><select
            v-model="filter.source"
            :aria-label="`筛选 ${index + 1} 值来源`"
            @change="filter.value = ''"
          >
            <option value="constant">固定值</option>
            <option value="field">本表字段</option></select
          ><select
            v-if="
              filter.source === 'constant' &&
              ['choice', 'choices'].includes(
                targetFields.find((field) => field.id === filter.sourceFieldId)
                  ?.kind || '',
              )
            "
            v-model="filter.value"
            :aria-label="`筛选 ${index + 1} 固定值`"
          >
            <option value="">请选择选项</option>
            <option
              v-for="option in targetFields.find(
                (field) => field.id === filter.sourceFieldId,
              )?.settings.options || []"
              :key="option.id"
              :value="option.id"
            >
              {{ option.label }}
            </option></select
          ><input
            v-else-if="filter.source === 'constant'"
            v-model="filter.value"
            :aria-label="`筛选 ${index + 1} 固定值`"
            maxlength="1000"
          /><select
            v-else
            v-model="filter.value"
            :aria-label="`筛选 ${index + 1} 本表字段`"
          >
            <option value="">请选择</option>
            <option
              v-for="field in sourceFields"
              :key="field.id"
              :value="field.id"
            >
              {{ field.name }}
            </option>
          </select></template
        >
        <button
          class="text-button"
          :aria-label="`删除筛选 ${index + 1}`"
          @click="spec.filters.splice(index, 1)"
        >
          删除
        </button>
      </div>
      <div class="collab-toolbar relation-section-title">
        <strong>建立关联时回填</strong
        ><button
          class="text-button"
          :disabled="
            spec.cardinality !== 'one' ||
            spec.mappings.length >= 20 ||
            !sourceFields.length
          "
          @click="addMapping"
        >
          添加字段回填
        </button>
      </div>
      <p class="collab-help">
        选择一条记录时可将目标值写入本表字段，提交前展示覆盖内容。目标后续变化和解除关联均不会自动改写已回填值。
      </p>
      <div
        v-for="(mapping, index) in spec.mappings"
        :key="index"
        class="relation-rule"
      >
        <select
          v-model="mapping.fromTargetFieldId"
          :aria-label="`回填 ${index + 1} 目标字段`"
          @change="mapping.toSourceFieldId = ''"
        >
          <option
            v-for="field in targetFields"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name }}
          </option></select
        ><span>→</span
        ><select
          v-model="mapping.toSourceFieldId"
          :aria-label="`回填 ${index + 1} 本表字段`"
        >
          <option value="">请选择类型兼容的字段</option>
          <option
            v-for="field in sourceChoices(mapping.fromTargetFieldId)"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name }}
          </option></select
        ><button
          class="text-button"
          :aria-label="`删除回填 ${index + 1}`"
          @click="spec.mappings.splice(index, 1)"
        >
          删除
        </button>
      </div>
    </template>
    <template #footer
      ><button class="button" @click="requestClose">关闭</button
      ><button class="button" :disabled="!sourceModel" @click="save(false)">
        保存草稿</button
      ><button
        class="button primary"
        :disabled="!sourceModel"
        @click="save(true)"
      >
        保存并发布
      </button></template
    >
  </BaseDialog>
</template>
