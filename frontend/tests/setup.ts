import { beforeEach, vi } from "vitest";

/** Models the asynchronous grant and exclusive lifetime; browser QA also uses native Web Locks. */
export class TestLocks {
  private held = new Set<string>();
  private waiting = new Map<string, Set<() => void>>();
  request = vi.fn(
    async <T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => T,
    ) => {
      await Promise.resolve();
      while (this.held.has(name)) {
        if (options.ifAvailable) return callback(null);
        await new Promise<void>((resolve, reject) => {
          const resume = () => {
            options.signal?.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            this.waiting.get(name)?.delete(resume);
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (options.signal?.aborted) return abort();
          options.signal?.addEventListener("abort", abort, { once: true });
          const queue = this.waiting.get(name) || new Set();
          queue.add(resume);
          this.waiting.set(name, queue);
        });
      }
      this.held.add(name);
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        this.held.delete(name);
        const queue = this.waiting.get(name);
        this.waiting.delete(name);
        queue?.forEach((resume) => resume());
      }
    },
  );
}

beforeEach(() => {
  vi.stubGlobal("navigator", { locks: new TestLocks() });
});
