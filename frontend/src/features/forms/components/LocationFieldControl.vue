<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import {
  emptyLocationSettings,
  isLocationValue,
  locationText,
  locationValueIssue,
  type FormField,
  type FormValues,
  type LocationValue,
} from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
import {
  deviceLocation,
  locationMobileDevice,
  loadLocationMap,
  addressLocation,
} from "../../../services/locationMap";
const LocationPickerDialog = defineAsyncComponent(
  () => import("./LocationPickerDialog.vue"),
);
const props = withDefaults(
  defineProps<{
    field: FormField;
    modelValue?: unknown;
    values?: FormValues;
    label?: string;
    disabled?: boolean;
    readonly?: boolean;
    design?: boolean;
  }>(),
  { values: () => ({}), disabled: false, readonly: false, design: false },
);
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();
const settings = computed(
  () =>
    props.field.location || { ...emptyLocationSettings(), mobileOnly: false },
);
const locked = computed(
  () =>
    props.disabled ||
    props.readonly ||
    props.design ||
    !props.field.editable ||
    !props.field.visible ||
    props.field.defaultLink?.enabled,
);
const mobileUnavailable = computed(
  () => settings.value.mobileOnly && !locationMobileDevice(),
);
const display = computed(() =>
  locationText(props.modelValue, settings.value.showCoordinates),
);
const pending = ref(false),
  error = ref(""),
  open = ref(false);
const candidate = ref<LocationValue>();
let generation = 0;
let automaticAttempted = false;
function invalidate() {
  generation++;
  pending.value = false;
  open.value = false;
}
function clear() {
  if (locked.value) return;
  invalidate();
  error.value = "";
  emit("update:modelValue", "");
}
async function locate(adjust: boolean) {
  if (locked.value || pending.value) return;
  if (settings.value.mobileOnly && !locationMobileDevice()) {
    error.value = "此字段仅支持移动端定位，请在手机上填写";
    return;
  }
  const current = ++generation;
  pending.value = true;
  error.value = "";
  try {
    let value = await deviceLocation();
    if (current !== generation || locked.value) return;
    // A coordinate-only fix remains useful without a map operator. No fake address.
    if (
      import.meta.env.VITE_AMAP_JS_KEY &&
      import.meta.env.VITE_AMAP_SERVICE_HOST
    )
      value = await addressLocation(await loadLocationMap(), value);
    if (current !== generation || locked.value) return;
    const issue = locationValueIssue(props.field, value, props.values);
    if (issue && !adjust) {
      error.value = issue;
      return;
    }
    if (adjust) {
      candidate.value = value;
      open.value = true;
    } else emit("update:modelValue", value);
  } catch (failure) {
    if (current === generation && !locked.value)
      error.value = (failure as Error).message;
  } finally {
    if (current === generation) pending.value = false;
  }
}
function select(value: LocationValue) {
  if (locked.value || !isLocationValue(value)) return;
  const issue = locationValueIssue(props.field, value, props.values);
  if (issue) {
    error.value = issue;
    return;
  }
  emit("update:modelValue", value);
  open.value = false;
}
watch(
  () => props.field.id,
  () => {
    automaticAttempted = false;
  },
);
watch(
  () =>
    [
      props.field.id,
      locked.value,
      JSON.stringify(props.field.location),
      props.modelValue,
    ] as const,
  () => {
    invalidate();
    if (
      !automaticAttempted &&
      !locked.value &&
      !mobileUnavailable.value &&
      settings.value.autoLocate &&
      !props.modelValue
    ) {
      automaticAttempted = true;
      void locate(false);
    }
  },
  { immediate: true },
);
onBeforeUnmount(invalidate);
</script>
<template>
  <div class="location-field-control">
    <div v-if="display" class="location-value">
      <AppIcon name="location" /><span>{{ display }}</span
      ><button
        v-if="!locked"
        type="button"
        aria-label="清除定位"
        @click="clear"
      >
        <AppIcon name="close" />
      </button>
    </div>
    <button
      v-if="!readonly"
      class="button location-action"
      type="button"
      :aria-label="label || field.label"
      :disabled="!!locked || pending || mobileUnavailable"
      @click="locate(settings.adjustEnabled)"
    >
      <AppIcon name="locate" />{{
        pending
          ? "正在定位…"
          : mobileUnavailable
            ? "请在移动端打开表单进行定位"
            : settings.adjustEnabled
              ? "选择定位"
              : "获取定位"
      }}
    </button>
    <button
      v-else-if="isLocationValue(modelValue)"
      class="button location-action"
      type="button"
      @click="
        candidate = modelValue;
        open = true;
      "
    >
      <AppIcon name="location" />查看定位
    </button>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <LocationPickerDialog
      v-if="open"
      :open="open"
      :value="candidate"
      :origin="readonly ? undefined : candidate?.origin"
      :radius="readonly ? undefined : settings.adjustRadius"
      :field="readonly ? undefined : field"
      :values="values"
      :readonly="readonly || !!locked"
      @close="open = false"
      @select="select"
    />
  </div>
</template>
<style scoped>
.location-field-control {
  min-width: 0;
}
.location-value {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #f5f7fa;
  border: 1px solid #dce3eb;
  border-radius: 3px;
  margin-bottom: 8px;
  min-height: 36px;
  font-size: 13px;
  color: #34435a;
}
.location-value span {
  flex: 1;
  overflow-wrap: anywhere;
}
.location-value button {
  display: flex;
  background: none;
  border: 0;
  padding: 2px;
  color: #7b899d;
  cursor: pointer;
}
.location-action {
  width: 100%;
  justify-content: center;
  min-height: 34px;
}
.field-error {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
</style>
