<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  money,
  orderState,
  paymentMethods,
  paymentStates,
  settledPayment,
  type PaymentMethod,
} from "../../domain/payments";
import type { PaymentMemberScope } from "../../stores/paymentActions";
const props = defineProps<{
  orderId: string;
  scope?: PaymentMemberScope;
  origin?: "submit" | "detail";
}>();
const emit = defineEmits<{ close: []; reopen: [id: string] }>();
const store = useWorkspaceStore(),
  method = ref<PaymentMethod>("wechat"),
  scenario = ref<"success" | "failed">("success"),
  now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(timer));
const order = computed(() =>
  store.data.paymentOrders?.find((o) => o.id === props.orderId),
);
const state = computed(() =>
  order.value ? orderState(order.value, now.value) : "cancelled",
);
const remaining = computed(() =>
  Math.max(
    0,
    Math.min(
      order.value?.expiresMinutes || 0,
      Math.ceil((Date.parse(order.value?.expiresAt || "") - now.value) / 60000),
    ),
  ),
);
watch(
  () => props.orderId,
  () => {
    method.value = order.value?.methods[0] || "wechat";
    scenario.value = "success";
  },
  { immediate: true },
);
async function pay() {
  await store.finishPayment(
    props.orderId,
    method.value,
    scenario.value,
    props.scope,
  );
}
async function retry() {
  if (order.value) {
    const next = await store.startPayment(
      order.value.entryId,
      props.origin || "detail",
      props.scope,
    );
    if (next) emit("reopen", next.id);
  }
}
</script>
<template>
  <BaseDialog
    :open="!!orderId"
    title="模拟收银台"
    width="540px"
    @close="emit('close')"
  >
    <template v-if="order"
      ><p class="payment-notice">
        仅演示支付流程，不会向微信或支付宝发起扣款。
      </p>
      <div class="checkout-amount">
        <span>{{ order.description }}</span
        ><strong>{{ money(order.amountCents) }}</strong
        ><span class="payment-status" :data-state="state">{{
          paymentStates[state]
        }}</span>
      </div>
      <dl class="payment-meta">
        <div>
          <dt>收款商户</dt>
          <dd>{{ order.merchantName }}</dd>
        </div>
        <div>
          <dt>本地订单号</dt>
          <dd>{{ order.id }}</dd>
        </div>
        <div>
          <dt>表单版本</dt>
          <dd>V{{ order.definitionVersion }}</dd>
        </div>
        <div v-if="order.refundedCents">
          <dt>已退金额</dt>
          <dd>{{ money(order.refundedCents) }}</dd>
        </div>
      </dl>
      <template v-if="state === 'pending'"
        ><p class="field-hint">
          有效期剩余约 {{ remaining }} 分钟。关闭窗口后可从记录详情继续支付。
        </p>
        <fieldset class="payment-methods">
          <legend>选择支付方式</legend>
          <label v-for="m in order.methods" :key="m"
            ><input
              v-model="method"
              type="radio"
              :value="m"
              name="payment-method"
            />{{ paymentMethods[m] }}</label
          >
        </fieldset>
        <label class="config-label"
          >模拟支付结果<select v-model="scenario">
            <option value="success">支付成功</option>
            <option value="failed">支付失败</option>
          </select></label
        ></template
      >
      <p v-else-if="state === 'paid'" class="payment-success" role="status">
        模拟支付已完成，记录已保存。未发生真实扣款。
      </p>
      <p v-else-if="state === 'failed'" class="config-warning" role="status">
        这次模拟支付失败，表单数据仍然保留。可以重试或稍后处理。
      </p>
      <p v-else-if="state === 'free'" class="payment-success">
        这笔订单金额为零，无需付款。
      </p>
      <p
        v-else-if="state === 'expired' || state === 'cancelled'"
        class="config-warning"
      >
        订单已关闭。重新发起时会按当前记录确认金额和条件。
      </p>
      <details class="payment-history">
        <summary>订单动态（{{ order.history.length }}）</summary>
        <ol>
          <li v-for="(h, i) in order.history" :key="i">
            <time>{{ new Date(h.at).toLocaleString("zh-CN") }}</time
            >{{ h.message }}
          </li>
        </ol>
      </details>
    </template>
    <p v-else>这笔订单不存在，请重新打开记录。</p>
    <template #footer
      ><button class="button" @click="emit('close')">
        {{ state === "pending" ? "稍后支付" : "关闭" }}</button
      ><button
        v-if="state === 'pending'"
        class="button"
        @click="store.cancelPayment(orderId, scope)"
      >
        取消订单</button
      ><button v-if="state === 'pending'" class="button primary" @click="pay">
        模拟确认支付</button
      ><button
        v-else-if="order && !settledPayment(state)"
        class="button primary"
        @click="retry"
      >
        重新发起支付
      </button></template
    >
  </BaseDialog>
</template>
