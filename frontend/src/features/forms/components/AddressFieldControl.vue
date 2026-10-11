<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  addressParts,
  addressText,
  addressType,
  isAddressValue,
  type AddressValue,
  type FormField,
} from "@platform/contracts";
import {
  addressRegions,
  addressRegion,
  addressSelection,
  type AddressRegion,
} from "../../../domain/address";
import { useDialogLayer } from "../../../composables/useDialogLayer";
import AppIcon from "../../../components/AppIcon.vue";

const props = defineProps<{
  field: FormField;
  modelValue?: unknown;
  label: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: AddressValue] }>();
const trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>(),
  search = ref<HTMLInputElement>();
const open = ref(false),
  query = ref(""),
  position = ref({ left: "0px", top: "0px" });
const value = computed(() =>
  isAddressValue(props.modelValue) ? props.modelValue : {},
);
const keys = computed(() =>
  addressParts(props.field).filter((key) => key !== "detail"),
);
const province = computed(() =>
  addressRegion(addressRegions, value.value.province),
);
const cities = computed(() => province.value?.children || []);
const city = computed(() => addressRegion(cities.value, value.value.city));
const districts = computed(() => city.value?.children || []);
const columns = computed(() => [
  addressRegions,
  ...(keys.value.length > 1 && province.value ? [cities.value] : []),
  ...(keys.value.length > 2 && city.value ? [districts.value] : []),
]);
const regionText = computed(() => addressText(value.value, "/", keys.value));
const placeholder = computed(
  () => ["省", "省-市", "省-市-区"][keys.value.length - 1],
);
const paths = computed(() => {
  function visit(items: AddressRegion[], parents: string[] = []): string[][] {
    return items.flatMap((item) =>
      parents.length + 1 >= keys.value.length
        ? [[...parents, item.name]]
        : visit(item.children || [], [...parents, item.name]),
    );
  }
  return visit(addressRegions);
});
const matches = computed(() => {
  const words = query.value.trim().split(/[\s/]+/);
  return paths.value
    .filter((path) => words.every((word) => path.join("").includes(word)))
    .slice(0, 50);
});
const { zIndex } = useDialogLayer(
  panel,
  () => {
    open.value = false;
  },
  () => {},
  {
    modal: false,
    anchor: () => trigger.value,
    initialFocus: () => search.value,
  },
);
function locate() {
  const rect = trigger.value!.getBoundingClientRect();
  const width = Math.min(
    window.innerWidth - 16,
    query.value ? 420 : columns.value.length * 160,
  );
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, rect.bottom + 294 <= window.innerHeight ? rect.bottom + 4 : rect.top - 286)}px`,
  };
}
async function show() {
  if (props.disabled) return;
  if (open.value) {
    open.value = false;
    return;
  }
  query.value = "";
  locate();
  open.value = true;
  await nextTick();
  panel.value
    ?.querySelector('[aria-selected="true"]')
    ?.scrollIntoView({ block: "nearest" });
}
async function choose(index: number, item: AddressRegion) {
  if (props.disabled) return;
  emit(
    "update:modelValue",
    addressSelection(props.field, value.value, keys.value[index]!, item.name),
  );
  if (index === keys.value.length - 1) open.value = false;
  else {
    await nextTick();
    locate();
    panel.value
      ?.querySelector<HTMLElement>(`[data-level="${index + 1}"] button`)
      ?.focus();
  }
}
function choosePath(path: string[]) {
  if (props.disabled) return;
  emit("update:modelValue", {
    ...value.value,
    ...Object.fromEntries(keys.value.map((key, i) => [key, path[i] || ""])),
  });
  open.value = false;
}
function detail(event: Event) {
  if (!props.disabled)
    emit("update:modelValue", {
      ...value.value,
      detail: (event.target as HTMLTextAreaElement).value,
    });
}
function leave(event: Event) {
  if (
    open.value &&
    !(event.target instanceof Node && panel.value?.contains(event.target))
  )
    open.value = false;
}
watch(query, () => {
  if (open.value) locate();
});
watch(
  [() => props.field.id, () => props.field.format, () => props.disabled],
  () => {
    open.value = false;
  },
);
watch(open, (active) => {
  if (active) {
    window.addEventListener("resize", leave);
    window.addEventListener("scroll", leave, true);
  } else {
    window.removeEventListener("resize", leave);
    window.removeEventListener("scroll", leave, true);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", leave);
  window.removeEventListener("scroll", leave, true);
});
</script>
<template>
  <div class="address-control">
    <button
      ref="trigger"
      type="button"
      class="address-trigger"
      :class="{ empty: !regionText }"
      :aria-label="`选择${label}`"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :disabled="disabled"
      @click="show"
    >
      <span>{{ regionText || placeholder }}</span
      ><AppIcon name="down" :size="16" />
    </button>
    <textarea
      v-if="addressType(field) === 'detail'"
      :value="value.detail || ''"
      class="address-detail"
      :placeholder="field.placeholder || '请填写详细地址'"
      rows="3"
      :disabled="disabled"
      :aria-label="`${label} 详细地址`"
      @input="detail"
    />
  </div>
  <Teleport to="body">
    <section
      v-if="open"
      ref="panel"
      role="dialog"
      :aria-label="`${label}地址选择`"
      tabindex="-1"
      class="address-panel"
      :style="{ ...position, zIndex }"
    >
      <div class="address-search">
        <AppIcon name="search" :size="16" /><input
          ref="search"
          v-model="query"
          :aria-label="`搜索${label}`"
          placeholder="搜索"
        />
      </div>
      <div v-if="query.trim()" class="address-search-results">
        <button
          v-for="path in matches"
          :key="path.join('/')"
          type="button"
          @click="choosePath(path)"
        >
          {{ path.join("/") }}
        </button>
        <p v-if="!matches.length">未找到匹配地址</p>
      </div>
      <div v-else class="address-columns">
        <div
          v-for="(items, index) in columns"
          :key="keys[index]"
          role="listbox"
          :aria-label="`${label} ${{ province: '省', city: '市', district: '区' }[keys[index]!]}`"
          :data-level="index"
        >
          <button
            v-for="item in items"
            :key="item.name"
            type="button"
            role="option"
            :aria-selected="addressRegion(items, value[keys[index]!]) === item"
            @click="choose(index, item)"
          >
            <span>{{ item.name }}</span
            ><AppIcon v-if="index < keys.length - 1" name="right" :size="14" />
          </button>
        </div>
      </div>
    </section>
  </Teleport>
</template>
