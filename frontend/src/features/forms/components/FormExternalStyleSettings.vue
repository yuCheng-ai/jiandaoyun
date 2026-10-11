<script setup lang="ts">
import { computed, ref } from "vue";
import type { FormSchema } from "@platform/contracts";
import { externalThemes } from "../../../domain/externalThemes";
import { customStyleFromTheme } from "../../../domain/externalStyle";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import FormRuntime from "./FormRuntime.vue";
import ExternalFormFrame from "./ExternalFormFrame.vue";
import OptionColorPicker from "../../../components/OptionColorPicker.vue";
import ExternalStyleImageControl from "./ExternalStyleImageControl.vue";
const props = defineProps<{
  schema: FormSchema;
  title: string;
  formId: string;
}>();
const open = ref(false);
const device = ref<"desktop" | "mobile">("desktop");
const tab = ref<"theme" | "custom">("theme");
const custom = computed(() => props.schema.settings.externalStyle?.custom);
const surfaces = [
  { key: "background", label: "页面背景" },
  { key: "header", label: "表头" },
] as const;
const fontSizes = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 36, 40];
function show() {
  device.value = "desktop";
  tab.value = custom.value ? "custom" : "theme";
  open.value = true;
}
function customize() {
  const style = props.schema.settings.externalStyle || { theme: 0 };
  if (!style.custom)
    props.schema.settings.externalStyle = {
      theme: style.theme,
      custom: customStyleFromTheme(style.theme),
    };
  tab.value = "custom";
}
</script>
<template>
  <div class="form-group">
    <label>表单外链样式</label>
    <button
      type="button"
      class="button full-width"
      aria-label="表单外链样式设置"
      @click="show"
    >
      设置
    </button>
  </div>
  <BaseDialog
    :open="open"
    title="表单外链样式"
    width="100vw"
    class-name="external-style-dialog"
    @close="open = false"
  >
    <template #header>
      <div class="segmented device-tabs" role="group" aria-label="外链预览设备">
        <button
          type="button"
          aria-label="电脑外链预览"
          :class="{ active: device === 'desktop' }"
          :aria-pressed="device === 'desktop'"
          @click="device = 'desktop'"
        >
          <AppIcon name="desktop" :size="20" />
        </button>
        <button
          type="button"
          aria-label="手机外链预览"
          :class="{ active: device === 'mobile' }"
          :aria-pressed="device === 'mobile'"
          @click="device = 'mobile'"
        >
          <AppIcon name="phone" :size="20" />
        </button>
      </div>
    </template>
    <div
      class="external-style-preview"
      :class="{ mobile: device === 'mobile' }"
    >
      <ExternalFormFrame
        :appearance="schema.settings.externalStyle || { theme: 0 }"
        :title="title"
        :device="device"
      >
        <FormRuntime
          :schema="schema"
          :form-id="formId"
          :device="device"
          preview
        />
      </ExternalFormFrame>
    </div>
    <aside
      class="external-style-inspector"
      :class="{ 'is-custom': tab === 'custom' }"
    >
      <div class="external-style-tabs" role="tablist" aria-label="外链样式">
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'theme'"
          @click="tab = 'theme'"
        >
          主题样式
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'custom'"
          @click="customize"
        >
          自定义样式
        </button>
      </div>
      <div
        v-if="tab === 'theme'"
        class="external-style-themes"
        role="group"
        aria-label="外链主题"
      >
        <button
          v-for="(theme, index) in externalThemes"
          :key="index"
          type="button"
          :aria-label="index === 0 ? '默认主题' : `主题${index}`"
          :aria-pressed="
            !custom && (schema.settings.externalStyle?.theme || 0) === index
          "
          :class="{
            selected:
              !custom && (schema.settings.externalStyle?.theme || 0) === index,
          }"
          @click="schema.settings.externalStyle = { theme: index }"
        >
          <img :src="theme.thumbnail" alt="" />
        </button>
      </div>
      <div v-else-if="custom" class="external-style-custom">
        <section v-for="surface in surfaces" :key="surface.key">
          <h3>{{ surface.key === "header" ? "表头样式" : surface.label }}</h3>
          <div
            class="external-style-radios"
            role="group"
            :aria-label="`${surface.label}类型`"
          >
            <label v-for="type in ['color', 'image'] as const" :key="type"
              ><input
                v-model="custom[surface.key].type"
                type="radio"
                :name="`external-${surface.key}`"
                :value="type"
                :aria-label="`${surface.label}${type === 'color' ? '颜色' : '图片'}`"
              />{{ type === "color" ? "颜色" : "图片" }}</label
            >
          </div>
          <OptionColorPicker
            v-if="custom[surface.key].type === 'color'"
            :color="custom[surface.key].color"
            :label="surface.label"
            swatch="bar"
            @change="custom[surface.key].color = $event"
          />
          <ExternalStyleImageControl
            v-else
            :value="custom[surface.key].image"
            :surface="surface.key"
            :label="surface.label"
            @change="custom[surface.key].image = $event"
          />
        </section>
        <section>
          <h3>标题样式</h3>
          <div class="external-style-title-row">
            <span>展示方式</span>
            <div class="external-style-radios">
              <label
                ><input
                  v-model="custom.title.visible"
                  type="radio"
                  name="external-title-visible"
                  :value="true"
                  aria-label="显示标题"
                />显示</label
              ><label
                ><input
                  v-model="custom.title.visible"
                  type="radio"
                  name="external-title-visible"
                  :value="false"
                  aria-label="隐藏标题"
                />隐藏</label
              >
            </div>
          </div>
          <div class="external-style-title-row">
            <span>对齐方式</span>
            <div
              class="external-style-align"
              role="group"
              aria-label="标题对齐"
            >
              <button
                v-for="align in ['left', 'center', 'right'] as const"
                :key="align"
                type="button"
                :aria-label="
                  align === 'left'
                    ? '标题左对齐'
                    : align === 'center'
                      ? '标题居中'
                      : '标题右对齐'
                "
                :aria-pressed="custom.title.align === align"
                @click="custom.title.align = align"
              >
                {{ align === "left" ? "左" : align === "center" ? "中" : "右" }}
              </button>
            </div>
          </div>
          <div class="external-style-title-row">
            <span>样式</span>
            <div class="external-style-font">
              <select v-model="custom.title.size" aria-label="标题字号">
                <option v-for="size in fontSizes" :key="size" :value="size">
                  {{ size }}
                </option>
                <option
                  v-if="!fontSizes.includes(custom.title.size)"
                  :value="custom.title.size"
                >
                  {{ custom.title.size }}
                </option>
              </select>
              <button
                type="button"
                aria-label="标题加粗"
                :aria-pressed="custom.title.bold"
                @click="custom.title.bold = !custom.title.bold"
              >
                <b>B</b>
              </button>
              <button
                type="button"
                aria-label="标题斜体"
                :aria-pressed="custom.title.italic"
                @click="custom.title.italic = !custom.title.italic"
              >
                <i>I</i>
              </button>
              <button
                type="button"
                aria-label="标题下划线"
                :aria-pressed="custom.title.underline"
                @click="custom.title.underline = !custom.title.underline"
              >
                <u>U</u>
              </button>
              <OptionColorPicker
                :color="custom.title.color"
                label="标题"
                swatch="text"
                @change="custom.title.color = $event"
              />
            </div>
          </div>
        </section>
        <section>
          <h3>提交按钮</h3>
          <OptionColorPicker
            :color="custom.buttonColor"
            label="提交按钮"
            swatch="bar"
            @change="custom.buttonColor = $event"
          />
        </section>
      </div>
    </aside>
  </BaseDialog>
</template>
<style>
.external-style-dialog {
  position: fixed;
  inset: 45px 0 0;
  margin: 0;
  height: calc(100dvh - 45px);
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  display: flex;
  flex-direction: column;
}
.external-style-dialog .dialog-header {
  min-height: 65px;
  height: 65px;
  justify-content: center;
  padding: 12px 20px;
}
.external-style-dialog .dialog-header > .icon-button {
  position: absolute;
  right: 20px;
  top: 20px;
  width: 24px;
  height: 24px;
}
.external-style-dialog .dialog-body {
  flex: 1;
  min-height: 0;
  max-height: none;
  padding: 0;
  overflow: hidden;
  display: flex;
}
.external-style-preview {
  min-width: 0;
  flex: 1;
  overflow: auto;
  background: #f7f8fa;
}
.external-style-preview.mobile {
  padding: 40px 20px;
}
.external-style-preview.mobile > .external-form {
  width: 390px;
  max-width: 100%;
  margin: auto;
  min-height: 100%;
  border-radius: 20px;
  border: 8px solid white;
  box-shadow: 0 12px 24px #16253912;
  overflow: clip;
}
.external-style-inspector {
  width: 270px;
  flex: 0 0 270px;
  min-height: 0;
  background: white;
  border-left: 1px solid #e9edf2;
  display: flex;
  flex-direction: column;
}
.external-style-tabs {
  display: flex;
  height: 46px;
  min-height: 46px;
  border-bottom: 1px solid #edf0f4;
}
.external-style-tabs button {
  flex: 1;
  font-size: 14px;
  font-weight: 400;
  color: #7d8797;
  padding: 0;
  border: 0;
  border-bottom: 2px solid transparent;
  background: white;
  cursor: pointer;
}
.external-style-tabs button[aria-selected="true"] {
  color: #03aba0;
  border-bottom-color: #03aba0;
}
.external-style-custom {
  overflow: auto;
  min-height: 0;
  padding: 20px 12px;
  font-size: 13px;
}
.external-style-custom section + section {
  margin-top: 24px;
}
.external-style-custom h3 {
  font-size: 14px;
  line-height: 20px;
  margin: 0 0 14px;
  color: #182638;
}
.external-style-radios {
  display: flex;
  gap: 24px;
  margin-bottom: 12px;
}
.external-style-radios label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #5b687a;
  cursor: pointer;
}
.external-style-radios input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: #03aba0;
}
.external-style-title-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.external-style-title-row > span {
  flex: 0 0 54px;
  color: #7d8797;
}
.external-style-title-row .external-style-radios {
  margin: 0;
  gap: 24px;
}
.external-style-align,
.external-style-font {
  display: flex;
  flex: 1;
  min-width: 0;
}
.external-style-align button {
  flex: 1;
  height: 26px;
  padding: 0;
  border: 1px solid #dce1e7;
  background: white;
  color: #7d8797;
  font-size: 12px;
  cursor: pointer;
}
.external-style-align button + button {
  border-left: 0;
}
.external-style-align button[aria-pressed="true"] {
  color: #03aba0;
  border-color: #03aba0;
}
.external-style-font {
  gap: 2px;
}
.external-style-font select {
  width: 48px;
  min-width: 0;
  height: 26px;
  min-height: 26px;
  padding: 0 2px;
  font-size: 13px;
  color: #7d8797;
  border: 1px solid #dce1e7;
  border-radius: 2px;
}
.external-style-font > button {
  width: 24px;
  height: 26px;
  padding: 0;
  border: 1px solid #dce1e7;
  border-radius: 2px;
  background: white;
  color: #7d8797;
  font-size: 14px;
  cursor: pointer;
}
.external-style-font > button[aria-pressed="true"] {
  color: white;
  background: #03aba0;
  border-color: #03aba0;
}
.external-style-font > .option-color-text {
  width: 40px;
}
.external-style-custom button:focus-visible,
.external-style-tabs button:focus-visible {
  outline: 2px solid #03aba0;
  outline-offset: 2px;
}
.external-style-themes {
  overflow: auto;
  overflow-x: hidden;
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.external-style-themes button {
  width: 250px;
  padding: 2px;
  border: 2px solid white;
  border-radius: 4px;
  background: white;
  box-shadow: 0 1px 5px #293b4d26;
  cursor: pointer;
}
.external-style-themes button.selected {
  border-color: #03aba0;
}
.external-style-themes button:focus-visible {
  outline: 2px solid #03aba0;
  outline-offset: 2px;
}
.external-style-themes img {
  display: block;
  width: 100%;
  height: auto;
}
@media (max-width: 650px) {
  .external-style-dialog .dialog-body {
    flex-direction: column-reverse;
  }
  .external-style-inspector {
    width: 100%;
    flex: 0 0 155px;
    border-left: 0;
  }
  .external-style-tabs {
    height: 34px;
    min-height: 34px;
  }
  .external-style-inspector.is-custom {
    flex-basis: 290px;
    max-height: 45vh;
  }
  .external-style-themes {
    flex-direction: row;
    padding: 8px;
    gap: 8px;
    overflow-x: auto;
  }
  .external-style-themes button {
    flex: 0 0 160px;
  }
  .external-style-preview.mobile {
    padding: 12px;
  }
}
</style>
