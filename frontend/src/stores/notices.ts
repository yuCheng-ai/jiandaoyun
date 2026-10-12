import { defineStore } from "pinia";
import { ref } from "vue";

/** Transient UI feedback is independent of business-data persistence. */
export const useNotices = defineStore("notices", () => {
  const notices = ref<{ id: string; message: string; type: string }[]>([]);
  function notify(message: string, type = "success") {
    const id = crypto.randomUUID();
    notices.value.push({ id, message, type });
    setTimeout(() => {
      notices.value = notices.value.filter((notice) => notice.id !== id);
    }, 4000);
  }
  return { notices, notify };
});
