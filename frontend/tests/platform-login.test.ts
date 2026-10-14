// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import PlatformLogin from "../src/features/session/PlatformLogin.vue";
const { login, replace } = vi.hoisted(() => ({ login: vi.fn(), replace: vi.fn() }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace }),
}));
vi.mock("../src/stores/platformSession", () => ({
  usePlatformSession: () => ({ login }),
}));
let app: ReturnType<typeof createApp> | undefined;
async function settle() {
  for (let i = 0; i < 10; i++) await nextTick();
}
async function mount() {
  app = createApp({ render: () => h(PlatformLogin) });
  app.mount("#mount");
  await settle();
  const set = (selector: string, value: string) => {
    const el = document.querySelector<HTMLInputElement>(selector)!;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set('[autocomplete="username"]', " editor ");
  set('[type="password"]', "test-only-password");
  await settle();
}
async function submit() {
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
beforeEach(() => {
  login.mockReset();
  replace.mockReset();
  document.body.innerHTML = '<div id="mount"></div>';
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
it("login navigates only after authentication and disables repeat submission while pending", async () => {
  let done!: () => void;
  login.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  await mount();
  await submit();
  await submit();
  expect(login).toHaveBeenCalledTimes(1);
  expect(login).toHaveBeenCalledWith("editor", "test-only-password");
  expect(replace).not.toHaveBeenCalled();
  expect(document.querySelector("button")!.disabled).toBe(true);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "正在登录",
  );
  done();
  await settle();
  expect(replace).toHaveBeenCalledExactlyOnceWith("/");
  expect(
    document.querySelector<HTMLInputElement>('[type="password"]')!.value,
  ).toBe("");
});
it("authentication failure retains inputs for retry and does not navigate or report success", async () => {
  login
    .mockRejectedValueOnce(new Error("账号或密码不正确"))
    .mockResolvedValueOnce(undefined);
  await mount();
  await submit();
  expect(replace).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "账号或密码不正确",
  );
  expect(
    document.querySelector<HTMLInputElement>('[type="password"]')!.value,
  ).toBe("test-only-password");
  expect(document.querySelector("button")!.disabled).toBe(false);
  await submit();
  expect(replace).toHaveBeenCalledExactlyOnceWith("/");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
