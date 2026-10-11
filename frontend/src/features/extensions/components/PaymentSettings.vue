<script setup lang="ts">
import { computed, ref } from "vue";
import { isNumericField } from "@platform/contracts";
import { useRouter } from "vue-router";
import BaseDialog from "../../../components/BaseDialog.vue";
import MerchantEditor from "../../payments/MerchantEditor.vue";
import DataFilterEditor from "../../forms/components/DataFilterEditor.vue";
import { useWorkspaceStore } from "../../../stores/workspace";
import { copy, type FormSchema } from "../../../domain/form";
import { scopeFields } from "../../../domain/relations";
import {
  newPayment,
  paymentFields,
  paymentIssues,
  paymentMethods,
  parsePayment,
  paymentResults,
  paymentResultTargets,
  type PaymentConfig,
} from "../../../domain/payments";
import { useDraftDismiss } from "../../../composables/useDraftDismiss";
import { restorePaymentDraft } from "../../../domain/extensionDraftAdapters";
const props = defineProps<{
  formId: string;
  schema: FormSchema;
  config?: PaymentConfig;
}>();
const store = useWorkspaceStore(),
  router = useRouter(),
  open = ref(false),
  merchantOpen = ref(false),
  draft = ref(newPayment()),
  errors = ref<string[]>([]),
  saving = ref(false);
const merchants = computed(() => store.data.paymentMerchants || []),
  fields = computed(() => paymentFields(props.schema));
const timingLabels = {
  submit: "提交后立即支付",
  detail: "查看记录时支付",
  both: "提交后支付，也可稍后继续",
};
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => open.value,
    () => draft.value,
    () => (open.value = false),
    {
      key: () => `payment:${props.formId}`,
      title: () => "在线支付配置",
      context: () => ({
        schema: props.schema,
        original: props.config || null,
        member: store.data.organization.currentUserId,
      }),
      restore: (value) => {
        draft.value = restorePaymentDraft(value);
        errors.value = [];
        confirmDiscard.value = false;
      },
    },
  );
function edit() {
  draft.value = parsePayment(copy(props.config || newPayment()));
  errors.value = [];
  open.value = true;
}
async function save() {
  if (saving.value) return;
  errors.value = draft.value.enabled
    ? paymentIssues(draft.value, props.schema, store.data)
    : [];
  if (errors.value.length) return;
  saving.value = true;
  try {
    if (await store.savePayment(props.formId, copy(draft.value))) {
      markSaved();
      open.value = false;
      store.notify("支付配置已保存，发布新版本后生效");
    } else
      errors.value = [
        store.storageError || "保存未完成，支付配置已保留，请重试。",
      ];
  } catch {
    errors.value = ["保存失败，支付配置已保留，请重试。"];
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <div class="payment-settings">
    <div class="payment-notice">
      本地模拟支付。可以体验收银台、失败重试与退款，不会产生真实收款。
    </div>
    <article class="payment-summary">
      <div>
        <span class="mode-tag">{{
          config?.enabled ? "已配置 · 发布后生效" : "尚未启用"
        }}</span>
        <h2>让表单记录关联一笔订单</h2>
        <p>
          {{
            config
              ? timingLabels[config.timing]
              : "设置收款金额与支付时机，订单结果会显示在记录详情中。"
          }}
        </p>
      </div>
      <button class="button primary" @click="edit">
        {{ config ? "编辑支付配置" : "配置在线支付" }}
      </button>
    </article>
    <div class="payment-summary">
      <div>
        <h3>商户与订单</h3>
        <p>管理演示商户、查看支付记录与模拟退款。</p>
      </div>
      <button class="button" @click="router.push('/admin/payments')">
        打开支付管理
      </button>
    </div>
    <BaseDialog
      :open="open"
      :draft-key="draftKey"
      :busy="saving"
      title="在线支付配置"
      width="720px"
      @close="!saving && requestClose()"
    >
      <div v-if="confirmDiscard" class="config-discard" tabindex="-1">
        <span>支付配置尚未保存。</span
        ><button class="button" @click="confirmDiscard = false">继续编辑</button
        ><button class="button" @click="discard">放弃修改</button>
      </div>
      <ul v-if="errors.length" class="config-errors" role="alert">
        <li v-for="error in errors" :key="error">{{ error }}</li>
      </ul>
      <label class="payment-enabled"
        ><input v-model="draft.enabled" type="checkbox" />启用在线支付<span
          class="mode-tag"
          >本地模拟</span
        ></label
      >
      <div class="payment-inline">
        <label class="config-label"
          >收款商户<select v-model="draft.merchantId">
            <option value="">请选择商户</option>
            <option
              v-for="m in merchants"
              :key="m.id"
              :value="m.id"
              :disabled="!m.enabled"
            >
              {{ m.name }}{{ m.enabled ? "" : "（已停用）" }}
            </option>
          </select></label
        ><button class="button" @click="merchantOpen = true">
          添加演示商户
        </button>
      </div>
      <div class="payment-grid">
        <label class="config-label"
          >金额来源<select
            v-model="draft.amount.source"
            @change="draft.amount.value = ''"
          >
            <option value="fixed">固定金额</option>
            <option value="field">表单字段</option>
          </select></label
        ><label class="config-label"
          >支付金额（元）<input
            v-if="draft.amount.source === 'fixed'"
            v-model="draft.amount.value"
            inputmode="decimal"
            placeholder="例如：100.00"
          /><select v-else v-model="draft.amount.value">
            <option value="">请选择数字字段</option>
            <option
              v-for="f in fields.filter(isNumericField)"
              :key="f.id"
              :value="f.id"
            >
              {{ f.label }}
            </option>
          </select></label
        >
      </div>
      <p class="field-hint">
        0–100,000 元，最多两位小数。零元订单显示“无需支付”。
      </p>
      <div class="payment-grid">
        <label class="config-label"
          >说明来源<select
            v-model="draft.description.source"
            @change="draft.description.value = ''"
          >
            <option value="fixed">固定文字</option>
            <option value="field">表单字段</option>
          </select></label
        ><label class="config-label"
          >订单说明<input
            v-if="draft.description.source === 'fixed'"
            v-model="draft.description.value"
            maxlength="256"
          /><select v-else v-model="draft.description.value">
            <option value="">请选择字段</option>
            <option v-for="f in fields" :key="f.id" :value="f.id">
              {{ f.label }}
            </option>
          </select></label
        >
      </div>
      <div class="payment-grid">
        <label class="config-label"
          >支付时机<select v-model="draft.timing">
            <option
              v-for="(label, key) in timingLabels"
              :key="key"
              :value="key"
            >
              {{ label }}
            </option>
          </select></label
        ><label class="config-label"
          >订单有效期（分钟）<input
            v-model.number="draft.expiresMinutes"
            type="number"
            min="1"
            max="1440"
        /></label>
      </div>
      <fieldset class="payment-methods">
        <legend>支付方式</legend>
        <label v-for="(label, key) in paymentMethods" :key="key"
          ><input v-model="draft.methods" type="checkbox" :value="key" />{{
            label
          }}</label
        >
      </fieldset>
      <h3>满足条件时允许支付</h3>
      <DataFilterEditor
        v-model="draft.filters"
        :source-fields="scopeFields(schema.fields)"
        :local-fields="scopeFields(schema.fields)"
        hint="不设置条件时，所有已提交记录都可以支付；待支付订单在付款前会再次检查。"
      />
      <p class="field-hint">
        成员入口只允许记录提交人支付。金额或说明改变后，待支付订单会重新确认；已支付订单保留原金额。
      </p>
      <section aria-label="支付结果回填" class="payment-result-settings">
        <h3>支付结果回填 <small>可选</small></h3>
        <p class="field-hint">
          支付成功、零元订单确认或退款后，自动更新下列字段。可选择只读字段，建议使用非必填的独立结果字段。
        </p>
        <div
          v-for="(mapping, index) in draft.resultMappings"
          :key="index"
          class="payment-result-row"
        >
          <label class="config-label"
            >支付结果<select
              v-model="mapping.source"
              :aria-label="`第 ${index + 1} 项支付结果`"
              @change="mapping.targetId = ''"
            >
              <option
                v-for="(result, key) in paymentResults"
                :key="key"
                :value="key"
              >
                {{ result.label }}
              </option>
            </select></label
          >
          <label class="config-label"
            >回填字段<select
              v-model="mapping.targetId"
              :aria-label="`第 ${index + 1} 项回填字段`"
            >
              <option value="">请选择匹配类型的字段</option>
              <option
                v-for="field in paymentResultTargets(schema, mapping.source)"
                :key="field.id"
                :value="field.id"
              >
                {{ field.label }}
              </option>
            </select></label
          >
          <button
            class="button"
            :aria-label="`移除第 ${index + 1} 项回填`"
            @click="draft.resultMappings!.splice(index, 1)"
          >
            移除
          </button>
        </div>
        <button
          class="button"
          :disabled="(draft.resultMappings?.length || 0) >= 32"
          @click="
            (draft.resultMappings ||= []).push({
              source: 'status',
              targetId: '',
            })
          "
        >
          添加结果回填
        </button>
        <p class="field-hint">
          回填后可在智能助手中选择“支付成功”“零元订单确认”或“退款成功”继续处理。不会额外触发“修改数据”规则；金额为原订单金额，退款为累计退款。
        </p>
      </section>
      <template #footer
        ><button class="button" @click="requestClose">取消</button
        ><button class="button primary" @click="save">
          保存支付配置
        </button></template
      >
    </BaseDialog>
    <MerchantEditor
      :open="merchantOpen"
      @close="merchantOpen = false"
      @saved="draft.merchantId = $event.id"
    />
  </div>
</template>
