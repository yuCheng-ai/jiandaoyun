import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { RoleApplication } from "@platform/contracts";
import { platformApi } from "../repositories/platformApi";
import { usePlatformSession } from "../stores/platformSession";

/** Existing role controls share one catalog, including preserved source identifiers. */
export function useRoleApplications() {
  const session = usePlatformSession();
  let generation = 0;
  const saved = ref<RoleApplication[]>([]),
    loading = ref(false),
    error = ref("");
  const applications = computed(() => saved.value);
  const find = (id: string) =>
    applications.value.find((app) => app.id === id || app.sourceId === id);
  const forms = (id: string) => {
    const app = find(id);
    return (
      app?.forms.map((form) => ({
        ...form,
        id: app.sourceId === id ? form.sourceId || form.id : form.id,
      })) || []
    );
  };
  async function load() {
    if (loading.value || session.user?.role !== "admin") return;
    const requested = generation;
    loading.value = true;
    error.value = "";
    try {
      const result = await platformApi<RoleApplication[]>(
        "/organization/role-applications",
      );
      if (requested === generation) saved.value = result;
    } catch (cause) {
      if (requested === generation) error.value = (cause as Error).message;
    } finally {
      if (requested === generation) loading.value = false;
    }
  }
  watch(
    () => (session.user ? `${session.user.id}:${session.user.role}` : ""),
    () => {
      generation++;
      saved.value = [];
      loading.value = false;
      error.value = "";
      void load();
    },
    { flush: "sync" },
  );
  onMounted(load);
  onBeforeUnmount(() => {
    generation++;
  });
  return { applications, find, forms, loading, error, load };
}
