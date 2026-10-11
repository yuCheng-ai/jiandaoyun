<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  paymentDefinition,
  quotePayment,
  orderState,
  paymentStates,
  money,
  settledPayment,
} from "../../domain/payments";
import { canEntry, eligibleGroups } from "../../domain/access";
import type { PaymentMemberScope } from "../../stores/paymentActions";
import PaymentCheckout from "./PaymentCheckout.vue";
const props = defineProps<{
  entryId: string;
  scope?: PaymentMemberScope;
  autoStart?: boolean;
}>();
const store = useWorkspaceStore(),
  orderId = ref(""),
  now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(timer));
const entry = computed(() =>
  store.data.entries.find((e) => e.id === props.entryId),
);
const config = computed(
  () =>
    entry.value &&
    paymentDefinition(entry.value, store.data)?.extensions?.payment,
);
const orders = computed(() =>
  (store.data.paymentOrders || []).filter((o) => o.entryId === props.entryId),
);
const latest = computed(
  () => orders.value.find((o) => settledPayment(o.status)) || orders.value[0],
);
const state = computed(
  () => latest.value && orderState(latest.value, now.value),
);
const eligible = computed(
  () =>
    !!entry.value &&
    (!props.scope ||
      (entry.value.createdBy === props.scope.actorId &&
        (props.autoStart ||
          canEntry(
            store.data,
            entry.value,
            props.scope.actorId,
            "view",
            props.scope.selection,
          )))),
);
const quote = computed(() => {
  if (!entry.value || !eligible.value) return { error: "" };
  try {
    return {
      value: quotePayment(entry.value, {
        ...store.data,
        organization: {
          ...store.data.organization,
          currentUserId:
            props.scope?.actorId || store.data.organization.currentUserId,
        },
      }),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
const canStart = computed(
  () =>
    eligible.value &&
    (!props.scope ||
      (!!entry.value &&
        (canEntry(
          store.data,
          entry.value,
          props.scope.actorId,
          "view",
          props.scope.selection,
        ) ||
          (origin.value === "submit" &&
            eligibleGroups(
              store.data,
              entry.value.formId,
              props.scope.actorId,
              props.scope.selection,
            ).some((g) => g.actions.includes("create")))))) &&
    !!quote.value.value &&
    (!latest.value || !settledPayment(latest.value.status)) &&
    (!!orders.value.length ||
      config.value?.timing !== "submit" ||
      props.autoStart),
);
const origin = computed(() =>
  props.autoStart && config.value?.timing !== "detail" ? "submit" : "detail",
);
async function start() {
  if (!canStart.value) return;
  const order = await store.startPayment(
    props.entryId,
    origin.value,
    props.scope,
  );
  if (order) orderId.value = order.id;
}
watch(
  () => props.entryId,
  async () => {
    orderId.value = "";
    if (
      props.autoStart &&
      config.value?.enabled &&
      config.value.timing !== "detail"
    )
      await start();
  },
  { immediate: true },
);
</script>
<template>
  <section
    v-if="eligible && entry?.status !== 'draft' && (config?.enabled || latest)"
    class="record-payment"
    aria-label="记录支付信息"
  >
    <div>
      <strong>{{ autoStart ? "本次提交的支付信息" : "支付信息" }}</strong
      ><span class="mode-tag">本地模拟</span>
      <p>
        {{
          latest?.description ||
          quote.value?.description ||
          "按当前记录确认支付"
        }}
      </p>
      <small
        >记录 {{ entryId.slice(-8) }} ·
        {{ state ? paymentStates[state] : "尚未发起" }}</small
      >
    </div>
    <strong v-if="latest || quote.value" class="payment-card-amount">{{
      money(latest?.amountCents ?? quote.value!.amountCents)
    }}</strong>
    <button v-if="canStart" class="button primary" @click="start">
      {{ latest ? "继续支付" : "发起支付" }}</button
    ><button v-if="latest" class="button" @click="orderId = latest.id">
      查看订单
    </button>
    <p
      v-if="quote.error && !settledPayment(latest?.status || 'pending')"
      class="field-hint payment-card-note"
    >
      {{ quote.error }}
    </p>
    <p
      v-if="
        latest && quote.value && latest.amountCents !== quote.value.amountCents
      "
      class="field-hint payment-card-note"
    >
      当前记录金额为 {{ money(quote.value.amountCents) }}。{{
        settledPayment(latest.status)
          ? "历史支付保留订单确认的金额，不会重复收款。"
          : "继续支付时将关闭旧订单，并重新确认金额。"
      }}
    </p>
    <PaymentCheckout
      v-if="orderId"
      :order-id="orderId"
      :scope="scope"
      :origin="origin"
      @close="orderId = ''"
      @reopen="orderId = $event"
    />
  </section>
</template>
