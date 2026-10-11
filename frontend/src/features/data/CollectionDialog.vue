<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import {
  defaultCollectionRules,
  type CollectionConfiguration,
  type CollectionRules,
} from "@platform/contracts";
import BaseDialog from "../../components/BaseDialog.vue";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { platformApi, PlatformError } from "../../repositories/platformApi";
import {
  collectionInstant,
  collectionRuleDisplay,
  collectionRuleLabels,
  localCollectionTime,
  mergeCollectionRules,
} from "../../domain/collectionRules";
const props = defineProps<{ definitionId: string; title: string }>();
const emit = defineEmits<{
  close: [];
  saved: [configuration: CollectionConfiguration];
}>();
const base = ref<CollectionConfiguration>(),
  rules = ref(defaultCollectionRules()),
  startsAt = ref(""),
  endsAt = ref("");
const busy = ref(false),
  error = ref(""),
  stale = ref(false),
  latest = ref<CollectionConfiguration>();
const choices = ref<Partial<Record<keyof CollectionRules, "mine" | "latest">>>(
  {},
);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const edits = () => ({
  ...rules.value,
  startsAt: startsAt.value,
  endsAt: endsAt.value,
});
const { requestClose, confirmDiscard, discard, markSaved } = useDraftDismiss(
  () => true,
  edits,
  () => emit("close"),
);
onBeforeRouteLeave(() => {
  requestClose();
  return false;
});
function inputRules(): CollectionRules {
  return {
    ...rules.value,
    startsAt: collectionInstant(startsAt.value),
    endsAt: collectionInstant(endsAt.value),
  };
}
function adopt(configuration: CollectionConfiguration) {
  base.value = configuration;
  rules.value = { ...configuration.rules };
  startsAt.value = localCollectionTime(configuration.rules.startsAt);
  endsAt.value = localCollectionTime(configuration.rules.endsAt);
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    adopt(
      await platformApi<CollectionConfiguration>(
        `/definitions/${props.definitionId}/collection-rules`,
      ),
    );
    markSaved();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value || !base.value || stale.value) return;
  busy.value = true;
  error.value = "";
  try {
    const saved = await platformApi<CollectionConfiguration>(
      `/definitions/${props.definitionId}/collection-rules`,
      "PUT",
      { expectedRevision: base.value.revision, rules: inputRules() },
    );
    adopt(saved);
    markSaved();
    emit("saved", saved);
  } catch (cause) {
    error.value = (cause as Error).message;
    stale.value = cause instanceof PlatformError && cause.status === 409;
  } finally {
    busy.value = false;
  }
}
async function compare() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    inputRules();
    latest.value = await platformApi<CollectionConfiguration>(
      `/definitions/${props.definitionId}/collection-rules`,
    );
    choices.value = {};
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
const review = computed(() => {
  if (!base.value || !latest.value) return;
  try {
    return mergeCollectionRules(
      base.value.rules,
      inputRules(),
      latest.value.rules,
    );
  } catch {
    return;
  }
});
const canMerge = computed(
  () =>
    review.value && review.value.conflicts.every((key) => choices.value[key]),
);
function merge() {
  if (!review.value || !canMerge.value || !latest.value) return;
  const result = { ...review.value.rules };
  for (const key of review.value.conflicts)
    if (choices.value[key] === "latest")
      Object.assign(result, { [key]: latest.value.rules[key] });
  const original = latest.value;
  adopt({ ...original, rules: result });
  base.value = original;
  latest.value = undefined;
  stale.value = false;
  error.value = "";
  // This only updates the editing baseline. It does not acknowledge or save the user's changes.
}
onMounted(load);
</script>
<template>
  <BaseDialog
    :open="true"
    :title="`收集设置 · ${title}`"
    width="650px"
    :busy="busy"
    @close="requestClose"
  >
    <p class="collab-help">
      同一业务数据的所有页面共用这些设置。仅限制新提交；已有记录仍可处理，草稿不占数量。
    </p>
    <p v-if="busy" class="collab-notice" role="status">正在处理收集设置…</p>
    <div
      v-if="confirmDiscard"
      class="config-discard collab-notice"
      tabindex="-1"
    >
      有尚未保存的设置。<button class="button" @click="confirmDiscard = false">
        继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </div>
    <template v-if="base">
      <p class="collab-help">
        已收集
        {{
          base.submittedRecords
        }}
        条正式记录。归档记录不计入数量，归档后可再次提交。
      </p>
      <label class="collab-check"
        ><input
          v-model="rules.enabled"
          type="checkbox"
          :disabled="busy"
        />接受新提交</label
      >
      <div class="collection-time-grid">
        <label class="collab-field"
          >开始时间<input
            v-model="startsAt"
            type="datetime-local"
            step="any"
            :disabled="busy" /></label
        ><label class="collab-field"
          >截止时间<input
            v-model="endsAt"
            type="datetime-local"
            step="any"
            :disabled="busy"
        /></label>
      </div>
      <p class="collab-help">
        时间按 {{ zone }} 显示；留空表示不限。到达截止时间即停止新提交。
      </p>
      <label class="collab-field"
        >数量上限<input
          v-model.number="rules.limit"
          type="number"
          min="0"
          step="1"
          :disabled="busy"
      /></label>
      <p class="collab-help">
        0 表示不限；已收集数量达到上限后，所有页面停止新提交。
      </p>
      <label class="collab-check"
        ><input
          v-model="rules.allowRepeat"
          type="checkbox"
          :disabled="busy"
        />允许同一成员重复提交</label
      >
      <p class="collab-help">
        关闭后，每位成员仅可提交一条未归档的正式记录；换页面或权限组仍按同一成员检查。此设置适用于登录成员。
      </p>
    </template>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <button v-if="stale" class="button" :disabled="busy" @click="compare">
      对照最新设置
    </button>
    <section
      v-if="latest && review"
      class="collection-review"
      aria-label="对照最新收集设置"
    >
      <p>
        你的输入已保留。互不冲突的修改可以合并；同一项的不同修改需先选择。合并后仍需点击保存。
      </p>
      <dl>
        <template
          v-for="key in Object.keys(
            collectionRuleLabels,
          ) as (keyof CollectionRules)[]"
          :key="key"
          ><dt>{{ collectionRuleLabels[key] }}</dt>
          <dd>
            最新：{{ collectionRuleDisplay(key, latest.rules[key])
            }}<template v-if="review.conflicts.includes(key)"
              >；我的：{{ collectionRuleDisplay(key, inputRules()[key]) }}
              <select
                v-model="choices[key]"
                :aria-label="`${collectionRuleLabels[key]}冲突选择`"
              >
                <option value="">请选择</option>
                <option value="mine">保留我的设置</option>
                <option value="latest">采用最新设置</option>
              </select></template
            >
          </dd></template
        >
      </dl>
      <button class="button" :disabled="!canMerge || busy" @click="merge">
        合并到当前设置
      </button>
    </section>
    <template #footer
      ><button class="button" :disabled="busy" @click="requestClose">
        取消</button
      ><button v-if="!base" class="button" :disabled="busy" @click="load">
        重新读取</button
      ><button
        class="button primary"
        :disabled="busy || !base || stale"
        @click="save"
      >
        保存收集设置
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.collab-check {
  display: flex;
  align-items: center;
  gap: 8px;
}
.collab-check input {
  width: auto;
}
.collection-time-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}
.collection-review {
  border-top: 1px solid #e1e6ef;
  margin-top: 16px;
  padding-top: 12px;
}
.collection-review dt {
  margin-top: 8px;
  font-weight: 600;
}
.collection-review dd {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}
@media (max-width: 560px) {
  .collection-time-grid {
    grid-template-columns: 1fr;
  }
}
</style>
