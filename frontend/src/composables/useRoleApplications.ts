import { computed, onMounted, ref } from "vue";
import type { RoleApplication } from "@platform/contracts";
import { platformApi } from "../repositories/platformApi";
import { useWorkspaceStore } from "../stores/workspace";

/** Existing role controls share one catalog, including preserved source identifiers. */
export function useRoleApplications() {
  const store = useWorkspaceStore(),
    saved = ref<RoleApplication[]>([]),
    loading = ref(false),
    error = ref("");
  const applications = computed(() => [
    ...saved.value.map((app) => ({ ...app, connected: true })),
    ...store.data.apps
      .filter(
        (app) =>
          !saved.value.some(
            (server) => server.id === app.id || server.sourceId === app.id,
          ),
      )
      .map((app) => ({
        id: app.id,
        name: app.name,
        connected: false,
        sourceId: undefined,
        forms: store.activeForms
          .filter((form) => form.appId === app.id)
          .map((form) => ({
            id: form.id,
            title: form.title,
            grouped: false,
            sourceId: undefined,
          })),
      })),
  ]);
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
    if (loading.value) return;
    loading.value = true;
    error.value = "";
    try {
      saved.value = await platformApi<RoleApplication[]>(
        "/organization/role-applications",
      );
    } catch (cause) {
      error.value = (cause as Error).message;
    } finally {
      loading.value = false;
    }
  }
  onMounted(load);
  return { applications, find, forms, loading, error, load };
}
