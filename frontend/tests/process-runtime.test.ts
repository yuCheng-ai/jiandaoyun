// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import type { RecordDetail } from "@platform/contracts";
import RecordEditor from "../src/features/collaboration/RecordEditor.vue";
import ProcessStartDialog from "../src/features/processes/ProcessStartDialog.vue";
import { createField, emptySchema } from "../src/domain/form";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
vi.mock("vue-router", async original => ({ ...await original<typeof import('vue-router')>(), onBeforeRouteLeave: vi.fn() }));
vi.mock("../src/repositories/platformApi", async original => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
vi.mock("../src/components/BaseDialog.vue", () => ({ default: defineComponent({ props: ['open', 'title'], setup(props, { slots }) { return () => props.open ? h('section', { 'aria-label': props.title }, [slots.default?.(), slots.footer?.()]) : null; } }) }));
const schema = emptySchema(); const name = createField('text'); name.id = 'name'; name.label = '名称'; schema.fields.push(name);
const detail = { task: { processId: 'process', taskId: 'task', title: '办理任务', writable: true }, page: { id: 'page', version: 2, title: '填写页' }, definition: { id: 'object', title: '对象', version: 2, schema }, access: { read: true, create: false, edit: true, fields: { name: 'edit' } }, record: { id: 'record', revision: 1, values: { name: '原值' }, cellRevisions: { name: 1 } } } as unknown as RecordDetail;
let app: ReturnType<typeof createApp> | undefined;
beforeEach(() => { vi.mocked(platformApi).mockReset(); document.body.innerHTML = '<div id="mount"></div>'; });
afterEach(() => { app?.unmount(); document.body.innerHTML = ''; });
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }
const button = (name: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!;
async function click(name: string) { button(name).click(); await settle(); }
it('task editor saves and reloads through task scope and retains retry identity', async () => {
  vi.mocked(platformApi).mockImplementation(async (path, method) => { if (method === 'PATCH') throw new PlatformError('字段冲突', 409); return detail; });
  app = createApp({ render: () => h(RecordEditor, { published: detail, detail }) }); app.mount('#mount'); await settle();
  const input = document.querySelector<HTMLInputElement>('#value-name')!; input.value = '新值'; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  await click('保存修改'); await click('保存修改');
  const writes = vi.mocked(platformApi).mock.calls.filter(call => call[1] === 'PATCH');
  expect(writes).toHaveLength(2); expect(writes[0]![0]).toBe('/processes/process/tasks/task/record'); expect(writes[0]![2]).toEqual(writes[1]![2]);
  expect(document.body.textContent).not.toContain('选择关联记录');
  await click('重新读取');
  const confirm = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('放弃修改并读取最新记录'))!; expect(confirm).toBeTruthy(); confirm.click(); await settle();
  expect(vi.mocked(platformApi).mock.calls.at(-1)![0]).toBe('/processes/process/tasks/task/record');
  expect(document.querySelector<HTMLInputElement>('#value-name')!.value).toBe('原值');
});
const template = { id: 'template', version: 1, spec: { title: '通用流程', bindings: [{ id: 'business', title: '业务数据' }] } };
const preview = { template, bindings: { business: 'record' }, recordRevisions: { business: 4 }, participantsToken: 'members-v1', tasks: [{ key: 'a', title: '办理任务', assigneeName: '成员', pageTitle: '处理页', dependsOn: [] }] };
async function mountStart() { app = createApp({ render: () => h(ProcessStartDialog, { templateId: 'template', version: 1 }) }); app.mount('#mount'); await settle(); const select = document.querySelector('select')!; select.value = 'record'; select.dispatchEvent(new Event('change', { bubbles: true })); await settle(); await click('预览任务'); }
it('start preview pins record revisions and safely retries uncertain submissions', async () => {
  vi.mocked(platformApi).mockImplementation(async path => {
    if (path.endsWith('/start')) throw new PlatformError('连接中断', 0);
    if (path.endsWith('/preview')) return preview;
    if (path.includes('/records?')) return [{ id: 'record', label: '业务 A', createdAt: '2026-10-08' }]; return template;
  });
  await mountStart(); expect(button('确认发起').disabled).toBe(false);
  await click('确认发起'); await click('确认发起');
  const writes = vi.mocked(platformApi).mock.calls.filter(call => call[0].endsWith('/start'));
  expect(writes[0]![2]).toEqual(writes[1]![2]); expect(writes[0]![2]).toMatchObject({ bindings: { business: 'record' }, recordRevisions: { business: 4 }, participantsToken: 'members-v1' });
});
it('a stale start preview requires a fresh preview before resubmitting', async () => {
  vi.mocked(platformApi).mockImplementation(async path => {
    if (path.endsWith('/start')) throw new PlatformError('记录已变化', 409);
    if (path.endsWith('/preview')) return preview;
    if (path.includes('/records?')) return [{ id: 'record', label: '业务 A', createdAt: '2026-10-08' }]; return template;
  });
  await mountStart(); await click('确认发起'); expect(button('确认发起').disabled).toBe(true); expect(document.body.textContent).toContain('记录已变化');
});
