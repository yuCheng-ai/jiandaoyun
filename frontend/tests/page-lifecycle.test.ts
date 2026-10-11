// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import PageLifecycleDialog from "../src/features/data/PageLifecycleDialog.vue";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
vi.mock("../src/repositories/platformApi", async original => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
vi.mock("../src/components/BaseDialog.vue", () => ({ default: defineComponent({ props: ["open", "title"], setup(props, { slots }) { return () => props.open ? h("section", { "aria-label": props.title }, [slots.default?.(), slots.footer?.()]) : null; } }) }));
let app: ReturnType<typeof createApp> | undefined, impact: any;
const saved = vi.fn(), close = vi.fn();
const button = (text: string) => [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === text)!;
async function settle() { for (let i = 0; i < 15; i++) await nextTick(); }
async function click(text: string) { button(text).click(); await settle(); }
async function mount(action: 'archive' | 'restore' = 'archive') { impact.action = action; app = createApp({ render: () => h(PageLifecycleDialog, { page: { id: 'page', title: '业务处理页', revision: 2, latestVersion: 1, definitionId: 'object', definitionVersion: 1 }, action, onSaved: saved, onClose: close }) }); app.mount('#mount'); await settle(); }
beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>'; saved.mockReset(); close.mockReset();
  impact = { token: 'reviewed', pageId: 'page', title: '业务处理页', revision: 3, action: 'archive', archivedAt: null, publishedVersion: 1, pendingFieldCount: 2, references: [{ id: 'template', title: '办理流程', state: 'published', version: 1, tasks: [{ title: '办理', pageVersion: 1 }] }], tasks: [{ version: 1, active: 2, completed: 1 }], warnings: [] };
  vi.mocked(platformApi).mockReset().mockImplementation(async path => {
    if (path.endsWith('/draft')) return { revision: 3 };
    if (path.endsWith('/lifecycle-preview')) return structuredClone(impact);
    if (path.endsWith('/archive')) return { id: 'page', archivedAt: '2026-10-09T00:00:00Z' };
    if (path.endsWith('/restore')) return { id: 'page', archivedAt: null };
    throw new Error(path);
  });
});
afterEach(() => { app?.unmount(); document.body.innerHTML = ''; });
it('archive reviews current page revision, dependencies and retained tasks before explicit confirmation', async () => {
  await mount(); expect(document.body.textContent).toContain('2 个未完成任务'); expect(document.body.textContent).toContain('办理流程');
  expect(vi.mocked(platformApi).mock.calls).toEqual([['/pages/page/draft'], ['/pages/page/lifecycle-preview', 'POST', { action: 'archive', expectedRevision: 3 }]]);
  await click('取消'); expect(close).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled();
  await click('确认归档页面'); expect(vi.mocked(platformApi).mock.calls.at(-1)).toEqual(['/pages/page/archive', 'POST', { expectedRevision: 3, impactToken: 'reviewed' }]); expect(saved).toHaveBeenCalledOnce();
});
it('stale lifecycle review disables confirmation and requires a new preview, without reporting success', async () => {
  await mount(); vi.mocked(platformApi).mockRejectedValueOnce(new PlatformError('使用情况已变化', 409));
  await click('确认归档页面'); expect(button('确认归档页面').disabled).toBe(true); expect(saved).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('使用情况已变化');
  impact.token = 'fresh'; await click('重新检查'); await click('确认归档页面'); expect(vi.mocked(platformApi).mock.calls.at(-1)?.[2]).toEqual({ expectedRevision: 3, impactToken: 'fresh' });
});
it('restore surfaces model changes and preserves the original page version instead of publishing', async () => {
  impact.warnings = ['数据字段已调整，恢复后仍使用 V1']; await mount('restore');
  expect(document.body.textContent).toContain('数据字段已调整'); expect(document.body.textContent).toContain('原页面入口重新可用');
  await click('确认恢复页面'); expect(vi.mocked(platformApi).mock.calls.at(-1)?.[0]).toBe('/pages/page/restore');
  expect(vi.mocked(platformApi).mock.calls.some(call => call[0].endsWith('/publish'))).toBe(false); expect(saved.mock.calls[0]?.[0].archivedAt).toBeNull();
});
