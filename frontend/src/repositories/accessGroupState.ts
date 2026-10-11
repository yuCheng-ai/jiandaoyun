import { ref } from "vue";

// A selection is a per-tab preference, never a source of authorization.
export const accessGroupSelections = ref<Record<string, string>>({});
let actorId: string | null = null;
export function accessGroupActor(id: string | null) {
  if (id !== actorId) {
    actorId = id;
    accessGroupSelections.value = {};
  }
}
export function chooseAccessGroup(id: string, selection: string) {
  const next = { ...accessGroupSelections.value };
  if (selection) next[id] = selection;
  else delete next[id];
  accessGroupSelections.value = next;
}
