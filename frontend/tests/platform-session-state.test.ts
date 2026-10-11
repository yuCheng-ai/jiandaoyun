import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { usePlatformSession } from "../src/stores/platformSession";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
import {
  accessGroupSelections,
  chooseAccessGroup,
} from "../src/repositories/accessGroupState";
vi.mock("../src/repositories/platformApi", async (original) => ({
  ...(await original<typeof import("../src/repositories/platformApi")>()),
  platformApi: vi.fn(),
}));
const user = (id: string) => ({
  id,
  username: id,
  name: id,
  role: "member" as const,
});
beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(platformApi).mockReset();
});
it("deduplicates concurrent session checks and does not restore an old account after logout", async () => {
  let done!: (value: unknown) => void;
  vi.mocked(platformApi).mockImplementation((path) =>
    path === "/auth/me"
      ? new Promise((resolve) => (done = resolve))
      : Promise.resolve({ ok: true }),
  );
  const session = usePlatformSession();
  const first = session.restore(),
    second = session.restore();
  expect(vi.mocked(platformApi)).toHaveBeenCalledOnce();
  await session.logout();
  done(user("old"));
  await Promise.all([first, second]);
  expect(session.user).toBeNull();
});
it("late 401 cannot erase a newer login or its group choice", async () => {
  let fail!: (error: unknown) => void;
  vi.mocked(platformApi).mockImplementation((path) =>
    path === "/auth/me"
      ? new Promise((_resolve, reject) => (fail = reject))
      : Promise.resolve(user("new")),
  );
  const session = usePlatformSession();
  const checking = session.restore();
  await session.login("new", "Synthetic-password!");
  chooseAccessGroup("form", "selected");
  fail(new PlatformError("expired", 401));
  await checking;
  expect(session.user?.id).toBe("new");
  expect(accessGroupSelections.value).toEqual({ form: "selected" });
});
it("a real session identity change clears the previous account group selections", async () => {
  vi.mocked(platformApi).mockResolvedValue(user("first"));
  const session = usePlatformSession();
  await session.restore();
  chooseAccessGroup("form", "selected");
  vi.mocked(platformApi).mockResolvedValue(user("second"));
  await session.restore();
  expect(session.user?.id).toBe("second");
  expect(accessGroupSelections.value).toEqual({});
});
