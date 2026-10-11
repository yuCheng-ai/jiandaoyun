<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useDialogLayer } from "../../composables/useDialogLayer";
import AppIcon from "../../components/AppIcon.vue";
const props = withDefaults(
  defineProps<{
    app?: { name: string; color?: string; icon?: string };
    forms: { id: string; title: string; folder?: string; kind?: string }[];
    selectedId?: string;
    folders?: string[];
    canCreate?: boolean;
  }>(),
  { folders: () => [] },
);
const emit = defineEmits<{ select: [id: string]; create: [] }>();
const router = useRouter();
const query = ref(""),
  navigationOpen = ref(false);
const selected = computed(() =>
  props.forms.find((form) => form.id === props.selectedId),
);
const expanded = ref(new Set<string>());
watch(
  () => selected.value?.folder,
  (folder) => {
    if (folder) expanded.value.add(folder);
  },
  { immediate: true },
);
const matching = computed(() =>
  props.forms.filter((form) =>
    form.title
      .toLocaleLowerCase()
      .includes(query.value.trim().toLocaleLowerCase()),
  ),
);
const folders = computed(() => [
  ...new Set([
    ...props.folders,
    ...props.forms
      .map((form) => form.folder)
      .filter((folder): folder is string => !!folder),
  ]),
]);
const ungrouped = computed(() => matching.value.filter((form) => !form.folder));
function toggleFolder(folder: string) {
  if (expanded.value.has(folder)) expanded.value.delete(folder);
  else expanded.value.add(folder);
}
function openForm(id: string) {
  navigationOpen.value = false;
  if (id !== props.selectedId) emit("select", id);
}
function expandFolder(folder: string) {
  expanded.value.add(folder);
}
defineExpose({ expandFolder });
const sidebar = ref<HTMLElement>(),
  mobileTrigger = ref<HTMLElement>();
function resizeNavigation() {
  if (window.innerWidth > 760) navigationOpen.value = false;
}
window.addEventListener("resize", resizeNavigation);
onBeforeUnmount(() => window.removeEventListener("resize", resizeNavigation));
const { zIndex } = useDialogLayer(
  computed(() => (navigationOpen.value ? sidebar.value : undefined)),
  () => {
    navigationOpen.value = false;
  },
  undefined,
  { anchor: () => mobileTrigger.value },
);
</script>
<template>
  <div class="application-home" :class="{ 'navigation-open': navigationOpen }">
    <Teleport to="body" :disabled="!navigationOpen">
      <aside
        ref="sidebar"
        class="application-home-sidebar"
        :class="{ 'mobile-navigation': navigationOpen }"
        :style="navigationOpen ? { zIndex } : undefined"
        :role="navigationOpen ? 'dialog' : undefined"
        :aria-modal="navigationOpen || undefined"
        aria-label="应用导航"
      >
        <header>
          <button
            class="icon-button"
            aria-label="返回工作台"
            @click="router.push('/')"
          >
            <AppIcon name="back" :size="22" />
          </button>
          <span class="small-app-tile" :style="{ background: app?.color }"
            ><AppIcon :name="app?.icon || 'layers'"
          /></span>
          <strong>{{ app?.name || "应用" }}</strong>
          <button
            class="icon-button mobile-close-navigation"
            aria-label="收起表单导航"
            @click="navigationOpen = false"
          >
            <AppIcon name="close" />
          </button>
        </header>
        <div class="application-home-search">
          <label
            ><AppIcon name="search" :size="15" /><input
              v-model="query"
              aria-label="搜索应用表单"
              placeholder="输入名称来搜索"
          /></label>
          <button
            v-if="canCreate"
            class="icon-button"
            aria-label="新建表单"
            @click="emit('create')"
          >
            <AppIcon name="add" :size="21" />
          </button>
        </div>
        <nav class="application-form-navigation" aria-label="表单">
          <template v-for="folder in folders" :key="folder">
            <template
              v-if="
                !query.trim() || matching.some((form) => form.folder === folder)
              "
            >
              <button
                class="application-folder"
                :aria-expanded="expanded.has(folder) || !!query.trim()"
                @click="toggleFolder(folder)"
              >
                <AppIcon name="folder" class="folder-icon" /><span>{{
                  folder
                }}</span>
              </button>
              <div
                v-if="expanded.has(folder) || query.trim()"
                class="application-folder-forms"
              >
                <button
                  v-for="form in matching.filter(
                    (form) => form.folder === folder,
                  )"
                  :key="form.id"
                  :class="{ active: selected?.id === form.id }"
                  :aria-current="selected?.id === form.id ? 'page' : undefined"
                  :title="form.title"
                  @click="openForm(form.id)"
                >
                  <AppIcon
                    :name="form.kind === 'workflow' ? 'condition' : 'document'"
                    :class="
                      form.kind === 'workflow' ? 'orange-icon' : 'blue-icon'
                    "
                  /><span>{{ form.title }}</span>
                </button>
                <p
                  v-if="!matching.some((form) => form.folder === folder)"
                  class="application-nav-empty"
                >
                  暂无表单
                </p>
              </div>
            </template>
          </template>
          <button
            v-for="form in ungrouped"
            :key="form.id"
            :class="{ active: selected?.id === form.id }"
            :aria-current="selected?.id === form.id ? 'page' : undefined"
            :title="form.title"
            @click="openForm(form.id)"
          >
            <AppIcon
              :name="form.kind === 'workflow' ? 'condition' : 'document'"
              :class="form.kind === 'workflow' ? 'orange-icon' : 'blue-icon'"
            /><span>{{ form.title }}</span>
          </button>
          <p
            v-if="query.trim() && !matching.length"
            class="application-nav-empty"
          >
            没有找到表单
          </p>
        </nav>
        <footer v-if="$slots.navigationFooter">
          <slot name="navigationFooter" />
        </footer>
      </aside>
      <button
        v-if="navigationOpen"
        class="application-navigation-shade"
        :style="{ zIndex: zIndex - 1 }"
        aria-label="收起表单导航"
        @click="navigationOpen = false"
      />
    </Teleport>
    <main class="application-home-main">
      <header class="application-form-toolbar">
        <button
          ref="mobileTrigger"
          class="icon-button mobile-open-navigation"
          aria-label="展开表单导航"
          :aria-expanded="navigationOpen"
          @click="navigationOpen = !navigationOpen"
        >
          <AppIcon name="menu" :size="20" />
        </button>
        <h1 :title="selected?.title">
          {{ selected?.title || app?.name || "应用" }}
        </h1>
        <div v-if="$slots.actions" class="application-form-actions">
          <slot name="actions" />
        </div>
        <div class="application-form-utilities"><slot name="utilities" /></div>
      </header>
      <slot />
    </main>
    <slot name="dialogs" />
  </div>
</template>
<style>
.application-home {
  height: 100dvh;
  display: flex;
  gap: 8px;
  padding: 0 8px 8px 0;
  background: #f2f3f8;
  overflow: hidden;
}
.application-home-sidebar {
  flex: 0 0 272px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.application-home-sidebar > header {
  height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}
.application-home-sidebar > header strong {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.application-home-sidebar .small-app-tile {
  flex-shrink: 0;
}
.application-home-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 16px 14px 22px;
  min-height: 52px;
}
.application-home-search label {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
  gap: 5px;
}
.application-home-search input:not([type]) {
  border: none;
  padding: 0;
  min-height: 28px;
  background: transparent;
  font-size: 13px;
  box-shadow: none;
}
.application-form-navigation {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 12px 12px;
}
.application-form-navigation button {
  width: 100%;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  text-align: left;
  border-radius: 5px;
  font-size: 14px;
}
.application-form-navigation button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.application-form-navigation button:hover {
  background: #e9ebf2;
}
.application-form-navigation button.active {
  background: #e3e4eb;
  font-weight: 600;
}
.application-folder-forms > button {
  padding-left: 26px;
}
.application-nav-empty {
  color: #939ca9;
  padding: 10px 24px;
  font-size: 12px;
}
.application-home-sidebar > footer {
  display: flex;
  flex-shrink: 0;
  margin: 0 12px;
  border-top: 1px solid #e3e6ed;
}
.application-home-sidebar > footer button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 48px;
  padding: 0 8px;
  text-align: left;
}
.application-trash-list {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
}
.application-trash-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #eef0f3;
}
.application-trash-list li > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.application-trash-list li > button {
  flex-shrink: 0;
}
.application-home-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin-top: 6px;
  background: white;
  border: 1px solid #e5e8ef;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.application-form-toolbar {
  height: 52px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 24px 0 12px;
  border-bottom: 1px solid #e2e6ee;
  background: #f8f8fc;
}
.application-form-toolbar h1 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  max-width: 38%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.application-form-actions {
  display: flex;
  align-items: center;
  gap: 22px;
  border-left: 1px solid #d9dfe9;
  padding-left: 16px;
  flex-shrink: 0;
}
.application-form-actions > button {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  font-size: 14px;
  height: 32px;
}
.application-form-utilities {
  display: flex;
  align-items: center;
  gap: 22px;
  margin-left: auto;
}
.application-home .application-fill-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.application-home
  .application-fill-scroll
  > .external-form:not(.themed)
  > .fill-page-sheet {
  max-width: none;
  min-height: 100%;
  box-shadow: none;
  display: flex;
  flex-direction: column;
}
.application-home .application-fill-scroll .fill-page-sheet > .form-runtime {
  flex: 1;
}
.application-home .application-fill-scroll .fill-page-sheet .runtime-content {
  padding: 24px 24px 35px;
}
.application-home .application-fill-scroll .fill-page-sheet .runtime-label {
  font-size: 14px;
  font-weight: 600;
  line-height: 18px;
  margin-bottom: 5px;
}
.application-home
  .application-fill-scroll
  .fill-page-sheet
  .runtime-field-content
  > textarea {
  max-width: min(100%, calc(var(--input-width, 354px) * 2 + 24px));
  min-height: 142px;
}
.application-home .application-fill-scroll .fill-page-sheet .runtime-footer {
  padding: 9px 24px;
}
.mobile-open-navigation,
.mobile-close-navigation,
.application-navigation-shade {
  display: none;
}
@media (max-width: 760px) {
  .application-home {
    padding: 0;
    gap: 0;
  }
  .application-home-sidebar {
    display: none;
  }
  .application-home-main {
    margin: 0;
    border: 0;
    border-radius: 0;
  }
  .application-form-toolbar {
    padding: 0 12px;
    gap: 8px;
  }
  .application-form-toolbar h1 {
    flex: 1;
    max-width: none;
    min-width: 40px;
  }
  .application-form-actions {
    gap: 12px;
    padding-left: 10px;
  }
  .application-form-actions > button {
    font-size: 13px;
  }
  .application-form-actions > button:not(.icon-button) .app-icon {
    display: none;
  }
  .application-form-utilities {
    gap: 0;
    margin-left: 3px;
  }
  .application-form-utilities > .icon-button {
    display: none;
  }
  .mobile-open-navigation,
  .mobile-close-navigation {
    display: inline-flex;
    flex-shrink: 0;
  }
  .mobile-close-navigation {
    margin-left: auto;
  }
  .application-home-sidebar.mobile-navigation {
    display: flex;
    position: fixed;
    inset: 0 auto 0 0;
    width: min(300px, calc(100% - 44px));
    background: #f2f3f8;
    z-index: 31;
  }
  .application-navigation-shade {
    display: block;
    position: fixed;
    inset: 0;
    background: #20293855;
    z-index: 30;
  }
  .application-home .application-fill-scroll .fill-page-sheet .runtime-content {
    padding: 20px 16px;
  }
  .application-home .application-fill-scroll .fill-page-sheet .runtime-footer {
    padding: 10px 16px;
  }
}
</style>
