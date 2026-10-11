import {
  computed,
  inject,
  onBeforeUnmount,
  provide,
  reactive,
  watch,
  type InjectionKey,
  type Ref,
} from "vue";
const key: InjectionKey<(id: symbol, pending: boolean) => void> =
  Symbol("file-uploads");
/** Each runtime owns its pending files; uploads do not block unrelated forms. */
export function provideFileUploads() {
  const active = reactive(new Set<symbol>());
  provide(key, (id, pending) => {
    if (pending) active.add(id);
    else active.delete(id);
  });
  return computed(() => active.size > 0);
}
export function useFileUploads(pending: Ref<boolean>) {
  const update = inject(key, undefined),
    id = Symbol();
  watch(pending, (value) => update?.(id, value), { flush: "sync" });
  onBeforeUnmount(() => update?.(id, false));
}
