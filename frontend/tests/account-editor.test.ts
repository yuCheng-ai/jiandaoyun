// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import AccountEditorDialog from "../src/features/organization/AccountEditorDialog.vue";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
import type { AccountUser } from "@platform/contracts";
vi.mock("vue-router", async (original) => ({
  ...(await original<typeof import("vue-router")>()),
  onBeforeRouteLeave: vi.fn(),
}));
vi.mock("../src/repositories/platformApi", async (original) => ({
  ...(await original<typeof import("../src/repositories/platformApi")>()),
  platformApi: vi.fn(),
}));
const existing: AccountUser = {
  id: "account",
  name: "测试成员",
  username: "qa-member",
  role: "member",
  active: true,
  revision: 3,
};
const saved = vi.fn(),
  close = vi.fn();
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 12; i++) await nextTick();
};
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  )!;
const input = (name: string) =>
  [...document.querySelectorAll("label")]
    .find((item) => item.textContent?.trim() === name)!
    .querySelector("input")!;
async function fill(name: string, value: string) {
  const el = input(name);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
async function submit() {
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
async function mount(account?: AccountUser) {
  app = createApp({
    render: () =>
      h(AccountEditorDialog, { account, onSaved: saved, onClose: close }),
  });
  app.mount("#app");
  await settle();
}
beforeEach(() => {
  vi.mocked(platformApi).mockReset();
  saved.mockReset();
  close.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

it("conflict recovery requires explicit discard, updates the expected revision and keeps inputs on a failed read", async () => {
  vi.mocked(platformApi).mockRejectedValueOnce(
    new PlatformError("账号已被修改", 409),
  );
  await mount(existing);
  await fill("姓名", "未保存姓名");
  await submit();
  button("重新读取账号").click();
  await settle();
  button("继续编辑").click();
  await settle();
  expect(input("姓名").value).toBe("未保存姓名");
  expect(platformApi).toHaveBeenCalledTimes(1);
  vi.mocked(platformApi).mockRejectedValueOnce(new Error("读取失败"));
  button("重新读取账号").click();
  await settle();
  button("放弃修改并读取").click();
  await settle();
  expect(input("姓名").value).toBe("未保存姓名");
  vi.mocked(platformApi).mockResolvedValueOnce({
    users: [{ ...existing, name: "最新姓名", revision: 4 }],
  });
  button("放弃修改并读取").click();
  await settle();
  expect(input("姓名").value).toBe("最新姓名");
  vi.mocked(platformApi).mockResolvedValueOnce({
    ...existing,
    name: "本次姓名",
    revision: 5,
  });
  await fill("姓名", "本次姓名");
  await submit();
  expect(vi.mocked(platformApi).mock.lastCall?.[2]).toMatchObject({
    expectedRevision: 4,
    name: "本次姓名",
  });
});

it("creates an account only after matching passwords; a pending request cannot double-submit and retry keeps its identity", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(platformApi).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await mount();
  await fill("姓名", "新成员");
  await fill("账号", "new-member");
  await fill("初始密码", "Synthetic-password-1!");
  await fill("确认密码", "different-password");
  await submit();
  expect(platformApi).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("两次输入的密码不一致");
  await fill("确认密码", "Synthetic-password-1!");
  await submit();
  await submit();
  expect(platformApi).toHaveBeenCalledTimes(1);
  expect(saved).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "正在保存",
  );
  reject(new Error("连接失败"));
  await settle();
  expect(input("初始密码").value).toBe("Synthetic-password-1!");
  vi.mocked(platformApi).mockResolvedValueOnce({
    ...existing,
    username: "new-member",
    revision: 1,
  });
  await submit();
  expect(vi.mocked(platformApi).mock.calls[1]).toEqual(
    vi.mocked(platformApi).mock.calls[0],
  );
  expect(saved).toHaveBeenCalledOnce();
  expect(input("初始密码").value).toBe("");
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it("name/status updates keep stable account identity and do not send hidden password inputs", async () => {
  vi.mocked(platformApi).mockResolvedValue({
    ...existing,
    active: false,
    revision: 4,
  });
  await mount(existing);
  expect(input("账号").readOnly).toBe(true);
  input("重置密码").click();
  await settle();
  await fill("新密码", "Discarded-password-2!");
  input("重置密码").click();
  input("允许登录").click();
  await settle();
  expect(document.body.textContent).toContain("保留原记录、部门和角色");
  await submit();
  expect(vi.mocked(platformApi).mock.calls[0]).toEqual([
    "/organization/accounts/account",
    "PUT",
    {
      name: existing.name,
      active: false,
      expectedRevision: 3,
      requestId: expect.any(String),
    },
  ]);
});

it("conflicts retain password and name only in memory, changed requests get a new identity, and cancellation requires an explicit discard", async () => {
  vi.mocked(platformApi).mockRejectedValue(new Error("账号已被修改"));
  await mount(existing);
  input("重置密码").click();
  await settle();
  await fill("新密码", "Synthetic-password-3!");
  await fill("确认密码", "Synthetic-password-3!");
  await submit();
  await fill("姓名", "修改后姓名");
  await submit();
  const calls = vi.mocked(platformApi).mock.calls;
  expect((calls[0]![2] as any).requestId).not.toBe(
    (calls[1]![2] as any).requestId,
  );
  expect(input("新密码").value).toBe("Synthetic-password-3!");
  button("取消").click();
  await settle();
  expect(close).not.toHaveBeenCalled();
  button("继续编辑").click();
  await settle();
  expect(input("姓名").value).toBe("修改后姓名");
  button("取消").click();
  await settle();
  button("放弃修改").click();
  await settle();
  expect(close).toHaveBeenCalledOnce();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
