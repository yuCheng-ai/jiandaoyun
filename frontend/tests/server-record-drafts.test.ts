// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createField, emptySchema } from "../src/domain/form";
import RecordEditor from "../src/features/collaboration/RecordEditor.vue";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../src/repositories/platformApi", async original => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
vi.mock("../src/features/data/RecordRelations.vue", () => ({ default: { render: () => h('div', '业务关联入口') } }));
vi.mock("../src/components/BaseDialog.vue", () => ({ default: defineComponent({ props: ['open'], setup(props, { slots }) { return () => props.open ? h('section', [slots.default?.(), slots.footer?.()]) : null; } }) }));
const published: any = { page: { id: 'page', title: '业务页面', version: 2 }, definition: { id: 'object', title: '业务', version: 1, schema: { ...emptySchema(), fields: [createField('text', { id: 'title', label: '业务名称', required: true })] } }, access: { userId: 'me', read: true, create: true, edit: false, scope: 'self', fields: { title: 'edit' } } };
const draft = () => ({ ...published, access: { ...published.access, edit: true }, record: { id: 'record', createdBy: 'me', state: 'draft', definitionVersion: 1, revision: 4, values: { title: '' }, cellRevisions: { title: 2 } } });
let app: ReturnType<typeof createApp> | undefined;
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }
async function mount(detail?: any, saved = vi.fn()) { document.body.innerHTML = '<div id="app"></div>'; app = createApp({ render: () => h(RecordEditor, { published, detail, onSaved: saved }) }); app.mount('#app'); await settle(); return saved; }
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!;
async function fill(text: string) { const input = document.querySelector<HTMLInputElement>('[aria-label="业务名称"]')!; input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); await settle(); }
afterEach(() => { app?.unmount(); vi.resetAllMocks(); });

it("new records can save incomplete drafts explicitly without calling the submission endpoint", async () => {
  vi.mocked(platformApi).mockResolvedValue(draft()); const saved = await mount();
  button('保存草稿').click(); await settle();
  const call = vi.mocked(platformApi).mock.calls[0]!;
  expect(call[0]).toBe('/pages/page/records'); expect(call[1]).toBe('POST');
  expect(call[2]).toMatchObject({ state: 'draft', version: 1, pageVersion: 2, values: { title: '' } });
  expect(saved).toHaveBeenCalled();
});

it("unchanged saved drafts still submit, and failed retries preserve the revision and request identity", async () => {
  vi.mocked(platformApi).mockRejectedValueOnce(new Error('业务名称需要填写')).mockResolvedValueOnce({ ...draft(), record: { ...draft().record, state: 'active' } });
  const saved = await mount(draft());
  expect(document.body.textContent).not.toContain('业务关联入口');
  button('提交记录').click(); await settle(); expect(document.body.textContent).toContain('业务名称需要填写'); expect(saved).not.toHaveBeenCalled();
  const first = vi.mocked(platformApi).mock.calls[0]!; expect(first[0]).toBe('/pages/page/records/record/submit'); expect(first[1]).toBe('POST');
  expect(first[2]).toMatchObject({ expectedRevision: 4, changes: [], rows: [], pageVersion: 2 });
  button('提交记录').click(); await settle(); expect(vi.mocked(platformApi).mock.calls[1]![2]).toEqual(first[2]); expect(saved).toHaveBeenCalled();
});

it("draft edits and submission travel together and controls visibly disable during the pending write", async () => {
  let resolve!: (result: unknown) => void;
  vi.mocked(platformApi).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await mount(draft()); await fill('完整业务'); button('提交记录').click(); await settle();
  expect(button('提交记录').disabled).toBe(true); expect(button('保存草稿').disabled).toBe(true);
  expect(vi.mocked(platformApi).mock.calls[0]![2]).toMatchObject({ expectedRevision: 4, changes: [{ fieldId: 'title', expectedRevision: 2, value: '完整业务' }] });
  resolve({ ...draft(), record: { ...draft().record, state: 'active' } }); await settle();
});

it("saving an edited draft uses PATCH and keeps business relation controls out of unsubmitted data", async () => {
  vi.mocked(platformApi).mockResolvedValue(draft()); await mount(draft()); await fill('未填完的草稿');
  button('保存草稿').click(); await settle();
  expect(vi.mocked(platformApi).mock.calls[0]![0]).toBe('/pages/page/records/record');
  expect(vi.mocked(platformApi).mock.calls[0]![1]).toBe('PATCH');
  expect(vi.mocked(platformApi).mock.calls[0]![2]).not.toHaveProperty('expectedRevision');
  expect(document.body.textContent).not.toContain('业务关联入口');
});

it('a create-only editor can save and submit despite having no submitted-record read permission', async () => {
  const source = { ...published, access: { ...published.access, read: false } }, saved = vi.fn();
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({ render: () => h(RecordEditor, { published: source, onSaved: saved }) }); app.mount('#app'); await settle();
  await fill('新登记');
  const ack = { accessLost: true, record: { id: 'created', state: 'active', values: {} }, access: { read: false }, definition: { schema: { fields: [] } } };
  vi.mocked(platformApi).mockResolvedValue(ack);
  expect(document.querySelector<HTMLInputElement>('[aria-label="业务名称"]')!.disabled).toBe(false);
  expect(document.body.textContent).toContain('提交后由有查看权限的成员处理');
  button('提交记录').click(); await settle();
  expect(saved).toHaveBeenCalledWith(ack);
});

it('changing the selected group after a failed request gives the same input a fresh retry identity', async () => {
  const { chooseAccessGroup } = await import('../src/repositories/accessGroupState');
  chooseAccessGroup('object', 'registration-a');
  vi.mocked(platformApi).mockRejectedValue(new Error('暂时失败')); await mount(); await fill('保留输入');
  button('提交记录').click(); await settle();
  const first = vi.mocked(platformApi).mock.calls.at(-1)![2] as any;
  chooseAccessGroup('object', 'registration-b');
  button('提交记录').click(); await settle();
  const next = vi.mocked(platformApi).mock.calls.at(-1)![2] as any;
  expect(next.values).toEqual(first.values); expect(next.requestId).not.toBe(first.requestId);
  chooseAccessGroup('object', '');
});

it('collection rejection preserves the draft and retry identity without offering an unrelated record reload', async () => {
  const denied = { accepting: false, code: 'full' as const, reason: '已达到收集数量上限', checkedAt: new Date().toISOString() };
  vi.mocked(platformApi).mockRejectedValueOnce(new PlatformError('已达到收集数量上限，可保存草稿', 409, denied));
  const saved = await mount(draft()); await fill('保留这次填写');
  button('提交记录').click(); await settle();
  const first = vi.mocked(platformApi).mock.calls[0]![2];
  expect(document.querySelector<HTMLInputElement>('[aria-label="业务名称"]')!.value).toBe('保留这次填写');
  expect([...document.querySelectorAll('button')].some(item => item.textContent?.trim() === '重新读取')).toBe(false);
  expect(button('保存草稿').disabled).toBe(false);
  vi.mocked(platformApi).mockResolvedValueOnce({ accepting: true, code: 'open', checkedAt: new Date().toISOString() });
  button('重新检查收集状态').click(); await settle();
  expect(document.body.textContent).not.toContain('已达到收集数量上限');
  expect(document.querySelector<HTMLInputElement>('[aria-label="业务名称"]')!.value).toBe('保留这次填写'); expect(saved).not.toHaveBeenCalled();
  vi.mocked(platformApi).mockResolvedValueOnce({ ...draft(), record: { ...draft().record, state: 'active' } });
  button('提交记录').click(); await settle();
  expect(vi.mocked(platformApi).mock.calls.at(-1)![2]).toEqual(first); expect(saved).toHaveBeenCalledTimes(1);
});

it('collection closure is visible for a draft, while existing record processing retains the normal save action', async () => {
  const collection = { accepting: false, code: 'paused', reason: '当前已暂停收集', checkedAt: new Date().toISOString() };
  await mount({ ...draft(), collection });
  expect(document.body.textContent).toContain('当前已暂停收集'); expect(button('保存草稿').disabled).toBe(false);
  app?.unmount();
  await mount({ ...draft(), collection, record: { ...draft().record, state: 'active' } });
  expect(document.body.textContent).not.toContain('当前已暂停收集'); expect(button('保存修改')).toBeTruthy();
});
