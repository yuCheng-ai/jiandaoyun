<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import AdminLayout from "../organization/AdminLayout.vue";
import BaseDialog from "../../components/BaseDialog.vue";
import MerchantEditor from "./MerchantEditor.vue";
import PaymentCheckout from "./PaymentCheckout.vue";
import { useWorkspaceStore } from "../../stores/workspace";
import {
  money,
  orderState,
  paymentStates,
  paymentMethods,
  type PaymentMerchant,
  type PaymentOrder,
} from "../../domain/payments";
const store = useWorkspaceStore(),
  router = useRouter(),
  tab = ref("orders"),
  query = ref(""),
  state = ref("all");
const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(timer));
const stateOf = (order: PaymentOrder) => orderState(order, now.value);
const methodNames = (merchant: PaymentMerchant) =>
  merchant.methods.map((k) => paymentMethods[k]).join("、");
const merchantOpen = ref(false),
  editing = ref<PaymentMerchant>(),
  orderId = ref(""),
  refund = ref<PaymentOrder>(),
  refundAmount = ref(""),
  refundReason = ref("");
const merchants = computed(() =>
  (store.data.paymentMerchants || []).filter((m) =>
    (m.name + m.note).includes(query.value),
  ),
);
const orders = computed(() =>
  (store.data.paymentOrders || []).filter(
    (o) =>
      (state.value === "all" || stateOf(o) === state.value) &&
      `${o.id} ${o.merchantName} ${o.description}`
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
const page = ref(1),
  pages = computed(() => Math.max(1, Math.ceil(orders.value.length / 20)));
const orderRows = computed(() =>
  orders.value.slice((page.value - 1) * 20, page.value * 20),
);
watch([query, state], () => (page.value = 1));
watch(pages, (count) => (page.value = Math.min(page.value, count)));
const totals = computed(() =>
  (store.data.paymentOrders || [])
    .filter((o) =>
      ["paid", "partially_refunded", "refunded"].includes(o.status),
    )
    .reduce(
      (sum, o) => ({
        paid: sum.paid + o.amountCents,
        refunded: sum.refunded + o.refundedCents,
      }),
      { paid: 0, refunded: 0 },
    ),
);
function edit(m?: PaymentMerchant) {
  editing.value = m;
  merchantOpen.value = true;
}
function requestRefund(o: PaymentOrder) {
  refund.value = o;
  refundAmount.value = ((o.amountCents - o.refundedCents) / 100).toFixed(2);
  refundReason.value = "";
}
async function confirmRefund() {
  if (
    refund.value &&
    (await store.refundPayment(
      refund.value.id,
      refundAmount.value,
      refundReason.value,
    ))
  ) {
    refund.value = undefined;
    store.notify("模拟退款已保存，未发生真实资金退回");
  }
}
function source(o: PaymentOrder) {
  const f = store.data.forms.find((f) => f.id === o.formId);
  if (f) router.push(`/apps/${f.appId}/forms/${f.id}/data`);
}
</script>
<template>
  <AdminLayout active="payments"
    ><div class="payment-admin">
      <header class="payment-admin-heading">
        <div>
          <span class="eyebrow">业务服务</span>
          <h1>支付管理</h1>
          <p>管理商户、查看每笔订单的支付与退款记录。</p>
        </div>
        <span class="mode-tag">本地模拟</span>
      </header>
      <p class="payment-notice">
        所有商户和订单仅保存在本地工作空间，不涉及真实收款或退款。
      </p>
      <div class="payment-totals">
        <article>
          <small>模拟支付总额</small><strong>{{ money(totals.paid) }}</strong>
        </article>
        <article>
          <small>模拟退款总额</small
          ><strong>{{ money(totals.refunded) }}</strong>
        </article>
        <article>
          <small>本地订单</small
          ><strong
            >{{ store.data.paymentOrders?.length || 0 }}
            <small>笔</small></strong
          >
        </article>
      </div>
      <div class="payment-admin-tools">
        <div class="payment-tabs" role="tablist" aria-label="支付管理内容">
          <button
            role="tab"
            :aria-selected="tab === 'orders'"
            @click="
              tab = 'orders';
              query = '';
            "
          >
            订单记录</button
          ><button
            role="tab"
            :aria-selected="tab === 'merchants'"
            @click="
              tab = 'merchants';
              query = '';
            "
          >
            演示商户
          </button>
        </div>
        <input
          v-model="query"
          :placeholder="
            tab === 'orders' ? '搜索订单号、说明或商户' : '搜索商户'
          "
          aria-label="搜索支付管理"
        /><select v-if="tab === 'orders'" v-model="state" aria-label="订单状态">
          <option value="all">全部状态</option>
          <option v-for="(label, key) in paymentStates" :key="key" :value="key">
            {{ label }}
          </option></select
        ><button v-else class="button primary" @click="edit()">
          添加演示商户
        </button>
      </div>
      <div v-if="tab === 'orders'" class="payment-table-scroll">
        <table class="forms-table">
          <thead>
            <tr>
              <th>订单 / 说明</th>
              <th>商户</th>
              <th>金额 / 已退</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orderRows" :key="o.id">
              <td>
                <strong>{{ o.description }}</strong
                ><small class="payment-order-id">{{ o.id }}</small>
              </td>
              <td>{{ o.merchantName }}</td>
              <td>
                {{ money(o.amountCents)
                }}<small class="payment-order-id"
                  >已退 {{ money(o.refundedCents) }}</small
                >
              </td>
              <td>
                <span class="payment-status" :data-state="stateOf(o)">{{
                  paymentStates[stateOf(o)]
                }}</span>
              </td>
              <td>{{ new Date(o.createdAt).toLocaleString("zh-CN") }}</td>
              <td>
                <div class="payment-row-actions">
                  <button class="text-button" @click="orderId = o.id">
                    查看订单</button
                  ><button class="text-button" @click="source(o)">
                    来源表单</button
                  ><button
                    v-if="['paid', 'partially_refunded'].includes(o.status)"
                    class="text-button"
                    @click="requestRefund(o)"
                  >
                    模拟退款
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!orders.length" class="payment-empty">
          {{
            query || state !== "all"
              ? "没有符合条件的订单。"
              : "尚无订单。为表单配置在线支付并发布后，即可体验。"
          }}
        </p>
      </div>
      <div v-if="tab === 'orders'" class="member-pagination">
        <span>共 {{ orders.length }} 笔 · 每页 20 笔</span
        ><button class="button" :disabled="page === 1" @click="page--">
          上一页</button
        ><span>{{ page }} / {{ pages }}</span
        ><button class="button" :disabled="page === pages" @click="page++">
          下一页
        </button>
      </div>
      <div v-else class="payment-merchant-list">
        <article v-for="m in merchants" :key="m.id" class="payment-summary">
          <div>
            <h3>{{ m.name }}</h3>
            <p>
              {{ methodNames(m) }} ·
              {{ m.enabled ? "已启用" : "已停用" }}
            </p>
            <small>{{ m.note || "本地演示商户" }}</small>
          </div>
          <button class="button" @click="edit(m)">编辑商户</button>
        </article>
        <p v-if="!merchants.length" class="payment-empty">
          {{
            query
              ? "没有匹配的商户。"
              : "先添加演示商户，再到表单扩展功能配置支付。"
          }}
        </p>
      </div>
      <MerchantEditor
        :open="merchantOpen"
        :merchant="editing"
        @close="merchantOpen = false"
      />
      <PaymentCheckout
        v-if="orderId"
        :order-id="orderId"
        @close="orderId = ''"
        @reopen="orderId = $event"
      />
      <BaseDialog :open="!!refund" title="模拟退款" @close="refund = undefined"
        ><template v-if="refund"
          ><p class="payment-notice">本操作仅模拟退款，不会向付款人转账。</p>
          <p>
            {{ refund.description }} · 可退余额
            {{ money(refund.amountCents - refund.refundedCents) }}
          </p>
          <label class="config-label"
            >退款金额（元）<input
              v-model="refundAmount"
              inputmode="decimal" /></label
          ><label class="config-label"
            >退款原因<textarea
              v-model="refundReason"
              rows="3"
            /></label></template
        ><template #footer
          ><button class="button" @click="refund = undefined">取消</button
          ><button class="button primary" @click="confirmRefund">
            确认模拟退款
          </button></template
        ></BaseDialog
      >
    </div></AdminLayout
  >
</template>
