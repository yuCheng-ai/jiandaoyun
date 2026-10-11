<script setup lang="ts">
import { ref, watch } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import { copy, uid } from "../../domain/form";
import { paymentMethods, type PaymentMerchant } from "../../domain/payments";
import { useDraftDismiss } from "../../composables/useDraftDismiss";
import { restoreMerchantDraft } from "../../domain/extensionDraftAdapters";
const props = defineProps<{ open: boolean; merchant?: PaymentMerchant }>();
const emit = defineEmits<{ close: []; saved: [merchant: PaymentMerchant] }>();
const store = useWorkspaceStore();
const original = ref<PaymentMerchant | null>(null);
const saving = ref(false),
  error = ref("");
const draft = ref<PaymentMerchant>({
  id: "",
  name: "",
  enabled: true,
  methods: ["wechat", "alipay"],
  note: "",
});
watch(
  () => props.open,
  (open) => {
    if (open) {
      error.value = "";
      original.value = props.merchant ? copy(props.merchant) : null;
      draft.value = props.merchant
        ? copy(props.merchant)
        : {
            id: uid("merchant"),
            name: "",
            enabled: true,
            methods: ["wechat", "alipay"],
            note: "",
          };
    }
  },
  { immediate: true },
);
const { confirmDiscard, requestClose, discard, markSaved, draftKey } =
  useDraftDismiss(
    () => props.open,
    () => draft.value,
    () => emit("close"),
    {
      key: () => `merchant:${props.merchant?.id || "new"}`,
      title: () => `演示商户 · ${draft.value.name || "未命名商户"}`,
      context: () => ({
        original: props.merchant || null,
        member: store.data.organization.currentUserId,
      }),
      restore: (value) => {
        draft.value = restoreMerchantDraft(value, props.merchant?.id);
        error.value = "";
        confirmDiscard.value = false;
      },
    },
  );
async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    if (await store.savePaymentMerchant(copy(draft.value), original.value)) {
      markSaved();
      emit("saved", copy(draft.value));
      emit("close");
      store.notify("演示商户已保存");
    } else
      error.value =
        store.storageError ||
        "保存未完成，商户修改已保留，请检查名称和支付方式后重试。";
  } catch {
    error.value = "保存失败，商户修改已保留，请重试。";
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <BaseDialog
    :open="open"
    :draft-key="draftKey"
    :busy="saving"
    :title="merchant ? '编辑演示商户' : '添加演示商户'"
    @close="!saving && requestClose()"
  >
    <div v-if="confirmDiscard" class="config-discard" tabindex="-1">
      <span>商户修改尚未保存。</span
      ><button class="button" @click="confirmDiscard = false">继续编辑</button
      ><button class="button" @click="discard">放弃修改</button>
    </div>
    <p class="payment-notice">
      用于本地支付流程演示，不开通真实商户，也不收集支付密钥。
    </p>
    <p v-if="error" role="alert" class="field-error">{{ error }}</p>
    <label class="config-label"
      >商户名称<input
        v-model="draft.name"
        maxlength="60"
        placeholder="例如：青禾服务 · 演示商户"
    /></label>
    <fieldset class="payment-methods">
      <legend>支持的支付方式</legend>
      <label v-for="(label, key) in paymentMethods" :key="key"
        ><input v-model="draft.methods" type="checkbox" :value="key" />{{
          label
        }}</label
      >
    </fieldset>
    <label class="config-label"
      >备注<textarea v-model="draft.note" rows="3" />
    </label>
    <label><input v-model="draft.enabled" type="checkbox" />启用商户</label>
    <p class="field-hint">
      停用后无法新建或完成待支付订单；历史已支付订单仍可查看与模拟退款。
    </p>
    <template #footer
      ><button class="button" @click="requestClose">取消</button
      ><button class="button primary" @click="save">保存商户</button></template
    >
  </BaseDialog>
</template>
