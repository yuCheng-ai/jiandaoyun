<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from "vue";
import {
  isLocationValue,
  locationText,
  locationAdjustmentIssue,
  locationValueIssue,
  type LocationValue,
  type LocationPoint,
  type FormField,
  type FormValues,
} from "@platform/contracts";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import {
  loadLocationMap,
  mapCoordinates,
  addressLocation,
  searchLocations,
  type LocationMap,
  type LocationMapSdk,
} from "../../../services/locationMap";
const props = withDefaults(
  defineProps<{
    open: boolean;
    value?: LocationValue;
    origin?: LocationPoint;
    radius?: number;
    field?: FormField;
    values?: FormValues;
    readonly?: boolean;
  }>(),
  { values: () => ({}), readonly: false },
);
const emit = defineEmits<{ close: []; select: [value: LocationValue] }>();
const container = ref<HTMLElement>();
const selected = ref<LocationValue>();
const adjustOrigin = ref<LocationPoint>();
const query = ref("");
const results = ref<LocationValue[]>([]);
const error = ref("");
const busy = ref(false);
const sdk = shallowRef<LocationMapSdk>();
let map: LocationMap | undefined;
let marker: { setPosition(point: number[]): void } | undefined;
let generation = 0;
let operation = 0;
const issue = computed(() => {
  if (!selected.value) return "";
  if (adjustOrigin.value && props.radius) {
    const message = locationAdjustmentIssue(
      selected.value,
      adjustOrigin.value,
      props.radius,
    );
    if (message) return message;
  }
  return props.field
    ? locationValueIssue(props.field, selected.value, props.values) || ""
    : "";
});
function destroy() {
  generation++;
  operation++;
  map?.destroy();
  map = undefined;
  marker = undefined;
  sdk.value = undefined;
  busy.value = false;
}
async function initialize() {
  destroy();
  const current = generation;
  error.value = "";
  busy.value = true;
  results.value = [];
  query.value = "";
  selected.value = undefined;
  try {
    const api = await loadLocationMap();
    const initial = props.value
      ? await mapCoordinates(api, props.value)
      : undefined;
    const origin = props.origin
      ? await mapCoordinates(api, props.origin)
      : undefined;
    await nextTick();
    if (current !== generation || !props.open || !container.value) return;
    sdk.value = api;
    selected.value = initial;
    adjustOrigin.value = origin;
    const center = initial
      ? [initial.lng, initial.lat]
      : [116.397428, 39.90923];
    map = new api.Map(container.value, {
      center,
      zoom: initial ? 16 : 11,
      resizeEnable: true,
    });
    marker = new api.Marker({ position: center, map });
    if (adjustOrigin.value && props.radius)
      new api.Circle({
        center: [adjustOrigin.value.lng, adjustOrigin.value.lat],
        radius: props.radius,
        map,
        strokeColor: "#2481ec",
        fillColor: "#2481ec",
        fillOpacity: 0.1,
      });
    map.on("click", (event) => {
      if (props.readonly) return;
      void choose(
        {
          lng: event.lnglat.getLng(),
          lat: event.lnglat.getLat(),
          coordinateSystem: "GCJ02",
        },
        true,
      );
    });
  } catch (failure) {
    if (current === generation && props.open) {
      map?.destroy();
      map = undefined;
      sdk.value = undefined;
      error.value = (failure as Error).message;
    }
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function choose(value: LocationValue, geocode = false) {
  if (!sdk.value || props.readonly) return;
  const current = generation,
    request = ++operation;
  busy.value = true;
  error.value = "";
  try {
    const next = geocode ? await addressLocation(sdk.value, value) : value;
    if (
      current !== generation ||
      request !== operation ||
      !props.open ||
      props.readonly
    )
      return;
    selected.value = {
      ...next,
      ...(adjustOrigin.value ? { origin: { ...adjustOrigin.value } } : {}),
    };
    marker?.setPosition([next.lng, next.lat]);
    map?.setCenter([next.lng, next.lat]);
  } catch (failure) {
    if (current === generation && request === operation)
      error.value = (failure as Error).message;
  } finally {
    if (current === generation && request === operation) busy.value = false;
  }
}
async function search() {
  if (!query.value.trim() || !sdk.value || props.readonly || busy.value) return;
  const current = generation,
    request = ++operation;
  error.value = "";
  busy.value = true;
  results.value = [];
  try {
    const found = await searchLocations(sdk.value, query.value.trim());
    if (
      current !== generation ||
      request !== operation ||
      !props.open ||
      props.readonly
    )
      return;
    results.value = found;
    if (!found.length) error.value = "没有找到匹配地点，请换个名称搜索";
  } catch (failure) {
    if (current === generation && request === operation)
      error.value = (failure as Error).message;
  } finally {
    if (current === generation && request === operation) busy.value = false;
  }
}
function confirm() {
  if (
    props.readonly ||
    busy.value ||
    issue.value ||
    !isLocationValue(selected.value)
  )
    return;
  emit("select", JSON.parse(JSON.stringify(selected.value)));
}
watch(
  () => props.open,
  (open) => {
    if (open) void initialize();
    else destroy();
  },
  { immediate: true },
);
watch(
  () => props.readonly,
  () => {
    operation++;
    busy.value = false;
  },
);
onBeforeUnmount(destroy);
</script>
<template>
  <BaseDialog
    :open="open"
    :title="readonly ? '查看定位' : '选择定位'"
    width="920"
    class-name="location-picker-dialog"
    @close="emit('close')"
  >
    <div class="selected-location">
      <AppIcon name="location" /><span>{{
        selected ? locationText(selected) : "请选择地点"
      }}</span>
    </div>
    <div class="location-picker-layout">
      <div v-if="!readonly" class="location-search-panel">
        <form class="location-search" @submit.prevent="search">
          <input
            v-model="query"
            aria-label="搜索地点"
            placeholder="搜索或直接在地图上点选"
            :disabled="!sdk || busy"
          />
          <button
            class="button"
            type="submit"
            :disabled="!sdk || busy || !query.trim()"
            aria-label="搜索"
          >
            <AppIcon name="search" />
          </button>
        </form>
        <p v-if="busy" class="location-status" role="status">正在加载…</p>
        <button
          v-for="(result, index) in results"
          :key="index"
          type="button"
          class="location-search-result"
          :disabled="busy"
          @click="choose(result)"
        >
          <strong>{{ result.detail || locationText(result) }}</strong
          ><span>{{ locationText(result) }}</span>
        </button>
        <p v-if="origin && radius" class="location-status">
          可在当前位置 {{ radius }} 米内微调
        </p>
      </div>
      <div class="location-map-area">
        <div ref="container" class="location-map" aria-label="定位地图" />
        <div v-if="!sdk && error" class="location-map-error">
          <p role="alert">{{ error }}</p>
          <button type="button" class="button" @click="initialize">重试</button>
        </div>
      </div>
    </div>
    <p v-if="sdk && error" class="field-error" role="alert">{{ error }}</p>
    <p v-if="issue" class="field-error" role="alert">{{ issue }}</p>
    <template #footer
      ><button class="button" type="button" @click="emit('close')">
        {{ readonly ? "关闭" : "取消" }}</button
      ><button
        v-if="!readonly"
        class="button primary"
        type="button"
        :disabled="busy || !selected || !!issue"
        @click="confirm"
      >
        确定
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.selected-location {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 14px;
  min-height: 32px;
  font-size: 13px;
  color: #34435a;
}
.selected-location span {
  overflow-wrap: anywhere;
}
.location-picker-layout {
  display: grid;
  grid-template-columns: 38% 1fr;
  gap: 16px;
}
.location-search-panel {
  height: 340px;
  overflow: auto;
}
.location-search {
  display: flex;
  gap: 6px;
  position: sticky;
  top: 0;
  background: white;
  padding-bottom: 10px;
}
.location-search input {
  min-width: 0;
  flex: 1;
}
.location-search-result {
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
  background: white;
  border: 0;
  border-bottom: 1px solid #e6eaf0;
  padding: 12px 4px;
  width: 100%;
  cursor: pointer;
  color: #34435a;
}
.location-search-result strong {
  font-size: 13px;
  font-weight: 500;
}
.location-search-result span,
.location-status {
  font-size: 12px;
  color: #7a899d;
  line-height: 1.6;
}
.location-map-area {
  position: relative;
  min-width: 0;
  min-height: 340px;
}
.location-map {
  width: 100%;
  height: 340px;
}
.location-map-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: #69788e;
  background: #f6f8fb;
  font-size: 13px;
}
.location-picker-layout:has(> .location-map-area:only-child) {
  grid-template-columns: 1fr;
}
@media (max-width: 600px) {
  .location-picker-layout {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .location-search-panel {
    height: auto;
    max-height: 160px;
  }
  .location-map-area {
    min-height: 230px;
  }
  .location-map {
    height: 230px;
  }
}
</style>
