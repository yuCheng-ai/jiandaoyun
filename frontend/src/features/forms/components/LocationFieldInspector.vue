<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import {
  dateScopeFields,
  emptyLocationSettings,
  locationText,
  type FormField,
  type LocationSettings,
  type LocationValue,
} from "@platform/contracts";
import { uid } from "../../../domain/form";
import { scopeFields } from "../../../domain/relations";
import AppIcon from "../../../components/AppIcon.vue";
const LocationPickerDialog = defineAsyncComponent(
  () => import("./LocationPickerDialog.vue"),
);
const props = defineProps<{
  field: FormField;
  fields: FormField[];
  section: "settings" | "range" | "default";
}>();
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const settings = computed(
  () => props.field.location || emptyLocationSettings(),
);
const fields = computed(() => [
  ...new Map(
    [
      ...scopeFields(props.fields),
      ...dateScopeFields(props.fields, props.field.id),
    ]
      .filter(
        (field) => field.type === "location" && field.id !== props.field.id,
      )
      .map((field) => [field.id, field]),
  ).values(),
]);
const open = ref(false),
  editing = ref("");
const initial = computed(
  () =>
    settings.value.centers.find((center) => center.id === editing.value)
      ?.position,
);
const checked = (event: Event) => (event.target as HTMLInputElement).checked;
function update(patch: Partial<LocationSettings>) {
  emit("update", { location: { ...settings.value, ...patch } });
}
function center(id = "") {
  editing.value = id;
  open.value = true;
}
function select(position: LocationValue) {
  if (editing.value)
    update({
      centers: settings.value.centers.map((item) =>
        item.id === editing.value ? { ...item, position } : item,
      ),
    });
  else
    update({
      centers: [
        ...settings.value.centers,
        { id: uid("center"), position, radius: 500 },
      ],
    });
  open.value = false;
}
function radius(id: string, event: Event) {
  update({
    centers: settings.value.centers.map((item) =>
      item.id === id
        ? { ...item, radius: Number((event.target as HTMLInputElement).value) }
        : item,
    ),
  });
}
</script>
<template>
  <label v-if="section === 'default'" class="checkbox-line"
    ><input
      type="checkbox"
      :checked="settings.autoLocate"
      @change="update({ autoLocate: checked($event) })"
    />自动获取位置</label
  >
  <div v-else-if="section === 'settings'" class="form-group location-inspector">
    <label>定位设置</label>
    <label class="checkbox-line"
      ><input
        type="checkbox"
        :checked="settings.mobileOnly"
        @change="update({ mobileOnly: checked($event) })"
      />只支持移动端定位</label
    >
    <label class="checkbox-line"
      ><input
        type="checkbox"
        :checked="settings.showCoordinates"
        @change="update({ showCoordinates: checked($event) })"
      />定位结果显示经纬度坐标</label
    >
    <label class="checkbox-line"
      ><input
        type="checkbox"
        :checked="settings.adjustEnabled"
        @change="update({ adjustEnabled: checked($event) })"
      />允许微调</label
    >
    <label class="location-radius"
      ><input
        type="number"
        aria-label="微调范围"
        min="1"
        step="1"
        :disabled="!settings.adjustEnabled"
        :value="settings.adjustRadius"
        @input="
          update({
            adjustRadius: Number(($event.target as HTMLInputElement).value),
          })
        "
      /><span>米内</span></label
    >
  </div>
  <div v-else class="location-inspector location-range">
    <label class="checkbox-line"
      ><input
        type="checkbox"
        :checked="settings.rangeEnabled"
        @change="update({ rangeEnabled: checked($event) })"
      />限制定位范围</label
    >
    <template v-if="settings.rangeEnabled">
      <select
        aria-label="定位范围方式"
        :value="settings.rangeMode"
        @change="
          update({
            rangeMode: ($event.target as HTMLSelectElement).value as
              'fixed' | 'field',
          })
        "
      >
        <option value="fixed">通过固定地点限制</option>
        <option value="field">通过其他定位字段限制</option>
      </select>
      <template v-if="settings.rangeMode === 'fixed'">
        <div
          v-for="item in settings.centers"
          :key="item.id"
          class="location-center"
        >
          <div class="location-center-actions">
            <button type="button" class="link-button" @click="center(item.id)">
              {{ locationText(item.position) }}</button
            ><button
              type="button"
              class="icon-button"
              :aria-label="`删除定位中心 ${locationText(item.position)}`"
              @click="
                update({
                  centers: settings.centers.filter(
                    (center) => center.id !== item.id,
                  ),
                })
              "
            >
              <AppIcon name="trash" />
            </button>
          </div>
          <label class="location-radius"
            ><input
              type="number"
              :aria-label="`${locationText(item.position)}允许范围`"
              min="1"
              step="1"
              :value="item.radius"
              @input="radius(item.id, $event)"
            /><span>米内</span></label
          >
        </div>
        <button
          type="button"
          class="link-button add-location-center"
          @click="center()"
        >
          <AppIcon name="add" />新增定位中心
        </button>
      </template>
      <template v-else>
        <select
          aria-label="定位中心字段"
          :value="settings.centerFieldId"
          @change="
            update({
              centerFieldId: ($event.target as HTMLSelectElement).value,
            })
          "
        >
          <option value="">请选择定位字段</option>
          <option
            v-if="
              settings.centerFieldId &&
              !fields.some((field) => field.id === settings.centerFieldId)
            "
            :value="settings.centerFieldId"
          >
            原定位字段已不可用
          </option>
          <option v-for="field in fields" :key="field.id" :value="field.id">
            {{ field.label }}
          </option>
        </select>
        <label class="location-radius"
          ><input
            type="number"
            aria-label="定位允许范围"
            min="1"
            step="1"
            :value="settings.rangeRadius"
            @input="
              update({
                rangeRadius: Number(($event.target as HTMLInputElement).value),
              })
            "
          /><span>米内</span></label
        >
      </template>
    </template>
  </div>
  <LocationPickerDialog
    v-if="open"
    :open="open"
    :value="initial"
    @close="open = false"
    @select="select"
  />
</template>
<style scoped>
.location-inspector .checkbox-line {
  margin-top: 8px;
}
.location-radius {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.location-radius input {
  width: 100px;
  min-width: 0;
}
.location-radius span {
  font-size: 12px;
  color: #7b899d;
  white-space: nowrap;
}
.location-range select {
  margin-top: 8px;
}
.location-center {
  border-bottom: 1px solid #e9edf2;
  padding: 8px 0;
}
.location-center-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.location-center-actions .link-button {
  flex: 1;
  min-width: 0;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.add-location-center {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
}
</style>
