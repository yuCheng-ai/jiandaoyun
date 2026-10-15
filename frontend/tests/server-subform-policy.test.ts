// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import RecordEditor from '../src/features/collaboration/RecordEditor.vue';
import { createField, emptySchema } from '../src/domain/form';
import { platformApi } from '../src/repositories/platformApi';
vi.mock('vue-router', () => ({
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../src/repositories/platformApi', async original => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
vi.mock('../src/features/data/RecordRelations.vue', () => ({ default: { template: '<div />' } }));
let app: ReturnType<typeof createApp> | undefined;
const detail = () => ({
  definition: { id: 'object', title: '明细填写', version: 1, schema: { ...emptySchema(), fields: [createField('subform', { id: 'lines', label: '明细', children: [createField('text', { id: 'item', label: '项目' })] })] } },
  page: { id: 'page', version: 1 },
  access: { read: true, edit: true, create: true, fields: { lines: 'edit', item: 'edit' } },
  rowActions: { lines: { add: false, insert: true, editExisting: false, remove: false } },
  record: { id: 'record', revision: 1, values: { lines: [{ _rowId: 'row-a', item: '已有明细' }] }, cellRevisions: { 'lines/row-a/item': 1 }, rowRevisions: { lines: 1 } }
}) as any;
const settle = async () => { for (let i = 0; i < 20; i++) await nextTick(); };
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === name)!;
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; vi.mocked(platformApi).mockReset().mockRejectedValue(new Error('保存失败，保留填写')); });
afterEach(() => { app?.unmount(); document.body.innerHTML = ''; sessionStorage.clear(); localStorage.clear(); });
async function mount(data = detail(), existing = true) { app = createApp({ render: () => h(RecordEditor, { published: data, ...(existing ? { detail: data } : {}) }) }); app.mount('#app'); await settle(); }
it('existing rows are readonly while inserted rows remain editable and removable before saving', async () => {
  await mount();
  expect(document.querySelector<HTMLInputElement>('#value-lines-row-a-item')!.disabled).toBe(true);
  expect(button('添加明细')).toBeUndefined();
  expect(document.querySelector('[aria-label="删除明细第 1 行"]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[aria-label="在明细第 1 行前插入"]')!.click(); await settle();
  const input = [...document.querySelectorAll<HTMLInputElement>('input')].find(el => !el.disabled)!;
  input.value = '新明细'; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  button('保存修改').click(); await settle();
  const first: any = vi.mocked(platformApi).mock.calls.at(-1)![2];
  expect(first.rows).toEqual([{ action: 'insert', subformId: 'lines', beforeRowId: 'row-a', expectedRevision: 1, values: { item: '新明细' } }]);
  expect(first.changes).toEqual([]);
  expect(document.body.textContent).toContain('保存失败，保留填写'); expect(input.value).toBe('新明细');
  button('保存修改').click(); await settle();
  expect(vi.mocked(platformApi).mock.calls.at(-1)![2]).toEqual(first);
  document.querySelector<HTMLButtonElement>('[aria-label="删除明细第 1 行"]')!.click(); await settle();
  expect(document.querySelector<HTMLInputElement>('#value-lines-row-a-item')!.disabled).toBe(true);
  expect(document.querySelector('[aria-label="删除明细第 1 行"]')).toBeNull();
});
it('row-bound tasks expose no structural actions and creation respects the configured policy', async () => {
  const task = detail(); task.task = { rowId: 'row-a', taskId: 'task', processId: 'process', title: '办理', writable: true }; task.rowActions.lines = { add: false, insert: false, editExisting: true, remove: false };
  await mount(task); expect(document.querySelector<HTMLInputElement>('#value-lines-row-a-item')!.disabled).toBe(false);
  expect(button('添加明细')).toBeUndefined(); expect(button('插入')).toBeUndefined(); expect(button('删除')).toBeUndefined();
  app!.unmount(); document.body.innerHTML = '<div id="app"></div>';
  const fresh = detail(); fresh.rowActions.lines = { add: false, insert: false, editExisting: false, remove: false }; fresh.definition.schema.fields[0].subformPermissions = { add: false, insert: false, editExisting: false, deleteExisting: false };
  await mount(fresh, false);
  expect(button('添加明细')).toBeUndefined(); expect(button('在末尾插入')).toBeUndefined();
});
