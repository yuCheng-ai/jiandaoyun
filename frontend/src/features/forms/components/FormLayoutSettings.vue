<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  defaultMobileLayout,
  formTitleLayout,
  type FormSchema,
} from "@platform/contracts";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import FormFields from "./FormFields.vue";
import { useRuntimeData } from "../../../composables/useRuntimeData";
import {
  runtimeDefaults,
  resolveRuntimeValues,
} from "../../../domain/relations";
const props = defineProps<{ schema: FormSchema }>();
const open = ref(false);
const device = ref<"desktop" | "mobile">("desktop");
const titleLayout = computed(() =>
  formTitleLayout(props.schema.settings, device.value === "mobile"),
);
const data = useRuntimeData();
const values = computed(() =>
  resolveRuntimeValues(
    props.schema,
    runtimeDefaults(props.schema.fields, data.value),
    data.value,
  ),
);
function set(
  key: "labelPosition" | "labelWidth" | "labelAlignment" | "descriptionMode",
  value: unknown,
) {
  if (device.value === "mobile")
    props.schema.settings.mobileLayout = {
      ...defaultMobileLayout(),
      ...props.schema.settings.mobileLayout,
      [key]: value,
    };
  else (props.schema.settings as any)[key] = value;
}
function width(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (!input.value || !Number.isFinite(value)) {
    input.value = String(titleLayout.value.labelWidth);
    return;
  }
  set("labelWidth", Math.max(50, Math.min(500, Math.round(value))));
}
watch(open, (value) => {
  if (value) device.value = "desktop";
});
</script>
<template>
  <div class="form-group">
    <label for="form-layout">表单布局</label>
    <div class="setting-with-action">
      <div class="select-wrap">
        <select id="form-layout" v-model.number="schema.settings.layout">
          <option :value="1">单列</option>
          <option :value="2">双列</option>
          <option :value="3">三列</option>
          <option :value="4">四列</option></select
        ><AppIcon name="down" />
      </div>
      <button
        type="button"
        class="button icon-button"
        aria-label="表单布局设置"
        @click="open = true"
      >
        <AppIcon name="settings" />
      </button>
    </div>
  </div>
  <BaseDialog
    :open="open"
    title="表单布局"
    width="100vw"
    class-name="form-layout-dialog"
    @close="open = false"
  >
    <div class="form-layout-preview" :class="{ mobile: device === 'mobile' }">
      <div
        class="form-layout-preview-sheet"
        :class="{ mobile: device === 'mobile' }"
      >
        <div class="form-runtime">
          <div class="runtime-content">
            <FormFields
              :schema="schema"
              :fields="schema.fields"
              :values="values"
              :device="device"
              disabled
            />
          </div>
          <footer class="runtime-footer">
            <div>
              <button
                v-if="schema.settings.allowSubmit !== false"
                type="button"
                class="button primary"
                disabled
              >
                {{ schema.settings.submitLabel || "提交" }}</button
              ><button
                v-if="schema.settings.allowDraft"
                type="button"
                class="button"
                disabled
              >
                {{ schema.settings.draftLabel || "保存草稿" }}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </div>
    <aside class="form-layout-inspector">
      <div class="form-layout-device-tabs" role="tablist" aria-label="布局设备">
        <button
          v-for="item in [
            { id: 'desktop', label: '电脑端' },
            { id: 'mobile', label: '移动端' },
          ]"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="device === item.id"
          :class="{ active: device === item.id }"
          @click="device = item.id as typeof device"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="form-layout-options">
        <section>
          <h3>字段标题位置</h3>
          <div
            class="form-layout-position"
            role="group"
            aria-label="字段标题位置"
          >
            <button
              v-for="item in [
                { id: 'top', label: '上下' },
                { id: 'left', label: '左右' },
              ]"
              :key="item.id"
              type="button"
              :class="{
                active: titleLayout.labelPosition === item.id,
                horizontal: item.id === 'left',
              }"
              :aria-pressed="titleLayout.labelPosition === item.id"
              @click="set('labelPosition', item.id)"
            >
              <span>{{ item.label }}</span
              ><AppIcon
                v-if="titleLayout.labelPosition === item.id"
                name="check"
                :size="15"
              />
            </button>
          </div>
        </section>
        <template v-if="titleLayout.labelPosition === 'left'">
          <section>
            <h3>字段标题样式</h3>
            <div class="form-layout-row">
              <label for="layout-label-width">宽度</label
              ><input
                id="layout-label-width"
                type="number"
                min="50"
                max="500"
                :value="titleLayout.labelWidth"
                aria-label="字段标题宽度"
                @change="width"
              /><span>{{ device === "mobile" ? "pt" : "px" }}</span>
            </div>
            <div class="form-layout-row">
              <span>对齐方式</span>
              <div
                class="form-layout-segmented"
                role="group"
                aria-label="标题对齐方式"
              >
                <button
                  v-for="item in ['left', 'right'] as const"
                  :key="item"
                  type="button"
                  :aria-label="item === 'left' ? '标题居左' : '标题居右'"
                  :aria-pressed="titleLayout.labelAlignment === item"
                  :class="{ active: titleLayout.labelAlignment === item }"
                  @click="set('labelAlignment', item)"
                >
                  <AppIcon
                    name="paragraph"
                    :class="{ 'layout-align-right': item === 'right' }"
                  />
                </button>
              </div>
            </div>
          </section>
          <section>
            <h3>字段描述信息样式</h3>
            <div :key="device" class="form-layout-radio">
              <label
                v-for="item in [
                  { id: 'show', label: '显示' },
                  { id: 'popover', label: '隐藏' },
                ]"
                :key="item.id"
                ><input
                  type="radio"
                  :name="`description-${device}`"
                  :checked="titleLayout.descriptionMode === item.id"
                  @change="set('descriptionMode', item.id)"
                />{{ item.label }}</label
              >
            </div>
          </section>
        </template>
        <section v-if="device === 'desktop'">
          <h3>
            输入框宽度 <AppIcon name="help" :size="13" class="muted-icon" />
          </h3>
          <div
            class="form-layout-segmented"
            role="group"
            aria-label="输入框宽度"
          >
            <button
              v-for="item in [
                { id: 'standard', label: '标准' },
                { id: 'auto', label: '自动' },
              ]"
              :key="item.id"
              type="button"
              :aria-pressed="
                (schema.settings.inputWidth || 'standard') === item.id
              "
              :class="{
                active: (schema.settings.inputWidth || 'standard') === item.id,
              }"
              @click="
                schema.settings.inputWidth = item.id as 'standard' | 'auto'
              "
            >
              {{ item.label }}
            </button>
          </div>
        </section>
      </div>
    </aside>
  </BaseDialog>
</template>
<style>
.form-layout-dialog {
  position: fixed;
  inset: 45px 0 0;
  margin: 0;
  height: calc(100dvh - 45px);
  width: 100vw;
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  font-family:
    -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans",
    sans-serif;
}
.form-layout-dialog .dialog-header {
  min-height: 59px;
  height: 59px;
  justify-content: center;
  padding: 12px 20px;
}
.form-layout-dialog .dialog-header h2 {
  font-size: 18px;
  line-height: 26px;
  font-weight: 700;
}
.form-layout-dialog .dialog-header > .icon-button {
  position: absolute;
  right: 20px;
  top: 16px;
  width: 24px;
  height: 24px;
}
.form-layout-dialog .dialog-body {
  flex: 1;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  display: flex;
  max-height: none;
}
.form-layout-preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  background: #f7f8fa;
}
.form-layout-preview-sheet {
  background: white;
  min-height: 100%;
  max-width: 780px;
  margin: 0 auto;
  box-shadow: 0 0 8px #131d2e1a;
}
.form-layout-preview-sheet .form-runtime {
  min-height: calc(100dvh - 104px);
  display: flex;
  flex-direction: column;
}
.form-layout-preview-sheet .runtime-content {
  flex: 1;
}
.form-layout-preview-sheet .runtime-footer {
  padding: 8px 24px;
  border-top: 1px dashed #dadee5;
}
.form-layout-preview-sheet .runtime-footer > div > button {
  height: 32px;
  min-width: 120px;
}
.form-layout-preview-sheet .runtime-footer > div > button:disabled {
  opacity: 1;
}
.form-layout-preview.mobile {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 16px;
}
.form-layout-preview-sheet.mobile {
  flex-shrink: 0;
  width: 286px;
  height: 600px;
  max-width: 100%;
  min-height: 0;
  margin: 0;
  padding: 8px;
  border: 0;
  border-radius: 22px;
  box-shadow: 0 6px 24px #1b283b0d;
  overflow: hidden;
}
.form-layout-preview-sheet.mobile .form-runtime {
  width: 375px;
  height: 812px;
  min-height: 812px;
  transform: scale(0.72);
  transform-origin: top left;
  border: 1px solid #dadee5;
  border-radius: 18px;
  overflow: hidden;
}
.form-layout-preview-sheet.mobile .runtime-footer {
  padding: 8px 16px;
}
.form-layout-preview-sheet.mobile .runtime-footer > div {
  display: flex;
  flex-direction: row-reverse;
}
.form-layout-preview-sheet.mobile .runtime-footer .primary {
  flex: 1;
  border-radius: 20px;
  background: #2876e4;
  border-color: #2876e4;
}
.form-layout-preview-sheet.mobile .runtime-footer > div > button:not(.primary) {
  border: 0;
  background: white;
  min-width: 100px;
}
.form-layout-inspector {
  width: 300px;
  flex-shrink: 0;
  overflow: auto;
  background: white;
}
.form-layout-device-tabs {
  display: flex;
  height: 46px;
  margin-bottom: 11px;
}
.form-layout-device-tabs > button {
  flex: 1;
  border: 0;
  border-bottom: 2px solid transparent;
  background: white;
  color: inherit;
  font-size: 14px;
}
.form-layout-device-tabs > button.active {
  border-bottom-color: var(--teal);
  color: var(--teal);
  font-weight: 700;
}
.form-layout-options {
  padding: 0 12px 20px;
}
.form-layout-options section + section {
  margin-top: 15px;
}
.form-layout-options h3 {
  font-size: 14px;
  line-height: 21px;
  font-weight: 700;
  margin: 0 0 10px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.form-layout-position {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  max-width: 276px;
  gap: 12px;
}
.form-layout-position > button {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100px;
  border: 1px solid #dadee5;
  border-radius: 6px;
  padding: 0;
  background: white url("../../../assets/form-layout-position.png") 0 center /
    cover no-repeat;
  overflow: hidden;
  color: inherit;
  font-size: 14px;
}
.form-layout-position > button.horizontal {
  background-position: 100% center;
}
.form-layout-position > button > span {
  display: block;
  margin-top: 50px;
}
.form-layout-position > button.active {
  border: 2px solid var(--teal);
}
.form-layout-position > button > .app-icon {
  position: absolute;
  right: 0;
  bottom: 0;
  color: white;
  background: var(--teal);
  padding: 2px;
  box-sizing: content-box;
}
.form-layout-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  margin: 8px 0 4px;
  font-size: 14px;
}
.form-layout-row > label,
.form-layout-row > span:first-child {
  width: 88px;
  flex-shrink: 0;
}
.form-layout-row input[type="number"] {
  width: 90px;
  flex-shrink: 0;
  height: 32px;
}
.form-layout-segmented {
  display: flex;
  height: 32px;
}
.form-layout-segmented > button {
  flex: 1;
  min-width: 0;
  border: 1px solid #dadee5;
  background: white;
  color: inherit;
  font-size: 14px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.form-layout-segmented > button + button {
  margin-left: -1px;
}
.form-layout-segmented > button:first-child {
  border-radius: 5px 0 0 5px;
}
.form-layout-segmented > button:last-child {
  border-radius: 0 5px 5px 0;
}
.form-layout-segmented > button.active {
  position: relative;
  border-color: var(--teal);
  color: var(--teal);
}
.form-layout-row .form-layout-segmented {
  width: 120px;
}
.layout-align-right {
  transform: scaleX(-1);
}
.form-layout-radio {
  display: flex;
  gap: 24px;
  align-items: center;
  min-height: 30px;
}
.form-layout-radio > label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 400;
}
.form-layout-radio input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--teal);
}
@media (max-width: 650px) {
  .form-layout-dialog {
    inset: 52px 0 0;
    height: calc(100dvh - 52px);
  }
  .form-layout-dialog .dialog-body {
    flex-direction: column;
    overflow: auto;
  }
  .form-layout-inspector {
    width: 100%;
    order: -1;
    flex-shrink: 0;
    overflow: visible;
  }
  .form-layout-preview {
    min-height: 340px;
    flex: none;
    overflow: auto;
  }
  .form-layout-preview:not(.mobile) .form-layout-preview-sheet {
    width: 780px;
  }
  .form-layout-preview.mobile {
    padding: 16px;
  }
  .form-layout-options {
    max-width: 440px;
    margin: auto;
  }
}
</style>
