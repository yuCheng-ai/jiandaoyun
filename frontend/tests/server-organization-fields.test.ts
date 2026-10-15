// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { fieldValueLabel } from "@platform/contracts";
import ServerIdentitySelect from "../src/components/organization/ServerIdentitySelect.vue";
import { createField, emptySchema } from "../src/domain/form";
import ServerFieldControl from "../src/features/collaboration/ServerFieldControl.vue";
import FieldValueRules from "../src/features/data/FieldValueRules.vue";
import RecordEditor from "../src/features/collaboration/RecordEditor.vue";
import { platformApi } from "../src/repositories/platformApi";
vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../src/repositories/platformApi", async original => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
vi.mock("../src/features/data/RecordRelations.vue", () => ({ default: { render: () => null } }));
vi.mock("../src/components/BaseDialog.vue", () => ({ default: defineComponent({ props: ['open'], setup(props, { slots }) { return () => props.open ? h('section', [slots.default?.(), slots.footer?.()]) : null; } }) }));
let app: ReturnType<typeof createApp> | undefined;
async function settle() { for (let i = 0; i < 15; i++) await nextTick(); }
async function mount(component: Parameters<typeof createApp>[0]) { document.body.innerHTML = '<div id="app"></div>'; app = createApp(component); app.mount('#app'); await settle(); }
// 字段容器也带无障碍名称；交互需定位内部控件，不能点击或修改外层分组。
const control = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]:not(.server-field-control)`)!;
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!;
const identity = (id: string, name: string, active = true) => ({ id, name, active, kind: 'member' as const });
const options = { options: [identity('server-a', '业务员甲'), identity('server-b', '业务员乙')], defaultValue: 'server-a', organizationRevision: 3 };
afterEach(() => { app?.unmount(); vi.resetAllMocks(); });

it("member picker emits identities, preserves cancel, and allows searching without loading a local directory", async () => {
  vi.mocked(platformApi).mockResolvedValue(options);
  const field = createField('members'), value = ref<unknown>(['server-a']);
  await mount({ render: () => h(ServerFieldControl, { field, modelValue: value.value, inputId: 'members', label: '办理成员', organizationRequest: { path: '/pages/page/organization-options', body: { fieldId: field.id } }, 'onUpdate:modelValue': next => value.value = next }) });
  control<HTMLButtonElement>('办理成员').click(); await settle();
  const query = control<HTMLInputElement>('办理成员搜索'); query.value = '乙'; query.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  expect(document.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
  (document.querySelector('input[type=checkbox]') as HTMLInputElement).click(); button('取消').click(); await settle(); expect(value.value).toEqual(['server-a']);
  control<HTMLButtonElement>('办理成员').click(); await settle();
  (document.querySelectorAll('input[type=checkbox]')[1] as HTMLInputElement).click(); button('确定').click(); await settle(); expect(value.value).toEqual(['server-a', 'server-b']);
  expect(vi.mocked(platformApi).mock.calls.every(call => call[0] === '/pages/page/organization-options')).toBe(true);
});

it("readonly historical identities display their names without querying the organization", async () => {
  await mount({ render: () => h(ServerFieldControl, { field: createField('member'), modelValue: 'past', inputId: 'past', label: '历史经办人', disabled: true, identities: [identity('past', '原经办人', false)] }) });
  expect(document.body.textContent).toContain('原经办人（已停用）'); expect(control<HTMLButtonElement>('历史经办人').disabled).toBe(true); expect(platformApi).not.toHaveBeenCalled();
});

it("late candidate responses cannot replace a changed department scope, and failed retries preserve the selection", async () => {
  let resolveFirst!: (value: unknown) => void;
  vi.mocked(platformApi).mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
  vi.mocked(platformApi).mockResolvedValueOnce({ ...options, options: [identity('server-b', '乙部门人员')] });
  const department = ref('A'), selected = ref<unknown>('server-a');
  await mount({ render: () => h(ServerFieldControl, { field: createField('member'), modelValue: selected.value, label: '负责人', inputId: 'owner', identities: [identity('server-a', '已选甲')], organizationRequest: { path: '/options', body: { context: { department: department.value } } }, 'onUpdate:modelValue': next => selected.value = next }) });
  department.value = 'B'; await settle(); resolveFirst(options); await settle();
  expect(selected.value).toBe('server-a');
  vi.mocked(platformApi).mockRejectedValueOnce(new Error('范围已更新，请重试'));
  control<HTMLButtonElement>('负责人').click(); await settle(); expect(document.body.textContent).toContain('范围已更新，请重试'); expect(button('确定').disabled).toBe(true); expect(selected.value).toBe('server-a');
  vi.mocked(platformApi).mockResolvedValueOnce({ ...options, options: [identity('server-b', '乙部门人员')] });
  button('重试').click(); await settle(); expect(document.body.textContent).toContain('乙部门人员'); expect(document.body.textContent).not.toContain('业务员乙');
});

it("organization default is applied only to an uninitialized value and never reappears after clearing", async () => {
  vi.mocked(platformApi).mockResolvedValue(options); const value = ref<unknown>();
  await mount({ render: () => h(ServerFieldControl, { field: createField('member'), modelValue: value.value, label: '默认成员', inputId: 'default', organizationRequest: { path: '/options', body: {} }, 'onUpdate:modelValue': next => value.value = next }) });
  expect(value.value).toBe('server-a'); const calls = vi.mocked(platformApi).mock.calls.length;
  value.value = ''; await settle(); expect(vi.mocked(platformApi).mock.calls.length).toBe(calls);
  control<HTMLButtonElement>('默认成员').click(); await settle(); button('确定').click(); await settle(); expect(value.value).toBe('');
});

it("field rules use the server directory and restrict department dependencies to the main record or the same row", async () => {
  vi.mocked(platformApi).mockResolvedValue({ revision: 1, users: options.options, spec: { departments: [], roles: [], roleGroups: [], assignments: [] } });
  const main = createField('department', { id: 'main', label: '主表部门' }), rowDepartment = createField('department', { id: 'rowDepartment', label: '本行部门' }), foreign = createField('department', { id: 'foreign', label: '其他明细部门' });
  const chosen = ref(createField('member', { id: 'chosen', label: '经办人' })); chosen.value.organization.scope.mode = 'fieldDepartment';
  await mount({ render: () => h(FieldValueRules, { field: chosen.value, fields: [main, createField('subform', { id: 'rows', children: [rowDepartment, chosen.value] }), createField('subform', { id: 'others', children: [foreign] })], parentId: 'rows', onUpdate: patch => Object.assign(chosen.value, patch) }) });
  const select = control<HTMLSelectElement>('经办人依赖部门字段'); expect([...select.options].map(item => item.textContent)).toEqual(['选择部门字段', '主表部门', '本行部门']);
  select.value = 'rowDepartment'; select.dispatchEvent(new Event('change', { bubbles: true })); await settle(); expect(chosen.value.organization.scope.fieldId).toBe('rowDepartment');
  expect(vi.mocked(platformApi).mock.calls[0]![0]).toBe('/organization');
});

it("record forms request row-scoped candidates and keep actor defaults out of read-only writes", async () => {
  vi.mocked(platformApi).mockImplementation(async (path, method, body: any) => path.endsWith('/organization-options') ? { ...options, defaultValue: body.fieldId === 'handler' ? 'server-b' : 'server-a' } : { record: { id: 'saved' } });
  const main = createField('member', { id: 'owner', label: '负责人' }), department = createField('department', { id: 'department', label: '部门' }), handler = createField('member', { id: 'handler', label: '明细经办人' });
  const published = { page: { id: 'page', version: 2, title: '页面' }, definition: { id: 'object', version: 3, title: '数据', createdAt: '', schema: { ...emptySchema(), fields: [main, department, createField('subform', { id: 'rows', label: '明细', children: [handler] })] } }, defaultValues: { owner: 'server-a', department: 'dep' }, identities: options.options, access: { userId: 'me', read: true, create: true, edit: true, scope: 'all' as const, fields: { owner: 'edit' as const, department: 'read' as const, rows: 'edit' as const, handler: 'edit' as const } } };
  await mount({ render: () => h(RecordEditor, { published }) }); button('添加明细').click(); await settle();
  expect(vi.mocked(platformApi).mock.calls.some(call => (call[2] as any)?.subformId === 'rows')).toBe(true);
  expect(vi.mocked(platformApi).mock.calls.filter(call => call[0].endsWith('/organization-options')).every(call => !Object.hasOwn((call[2] as any).context, 'department'))).toBe(true);
  button('提交记录').click(); await settle();
  expect((vi.mocked(platformApi).mock.calls.find(call => call[0] === '/pages/page/records')![2] as any).values).toEqual({ owner: 'server-a', rows: [{ handler: 'server-b' }] });
});


it("archived identities display distinctly and stay out of selectable options even when inactive members are allowed", async () => {
  const archived = { ...identity('archive', '原经办人', false), historical: true }, stopped = identity('stopped', '停用账号', false);
  const value = ref<unknown>('archive');
  await mount({ render: () => h(ServerIdentitySelect, { modelValue: value.value, label: '身份选择', options: [archived, stopped], known: [archived], includeInactive: true, 'onUpdate:modelValue': next => value.value = next }) });
  expect(control<HTMLButtonElement>('身份选择').textContent).toContain('原经办人（历史身份）');
  expect(fieldValueLabel(createField('member'), 'archive', [archived])).toBe('原经办人（历史身份）');
  control<HTMLButtonElement>('身份选择').click(); await settle();
  expect(document.querySelectorAll('input[type=radio]')).toHaveLength(1);
  expect(control<HTMLElement>('身份选择候选项').textContent).toContain('停用账号（已停用）');
  expect(control<HTMLElement>('身份选择候选项').textContent).not.toContain('原经办人');
  button('取消').click(); await settle(); expect(value.value).toBe('archive');
});

it("record details show the original historical creator separately from field values", async () => {
  const current: any = { creator: { ...identity('archive', '原创建人', false), historical: true }, definition: { id: 'object', version: 1, title: '历史数据', schema: { ...emptySchema(), fields: [createField('text', { id: 'note', label: '说明' })] } }, record: { id: 'record', definitionVersion: 1, revision: 1, values: { note: '原值' }, cellRevisions: { note: 1 }, createdBy: 'archive' }, access: { userId: 'operator', read: true, edit: false, create: false, scope: 'all', fields: { note: 'read' } } };
  await mount({ render: () => h(RecordEditor, { published: current, detail: current }) });
  expect(document.body.textContent).toContain('创建人：原创建人（历史身份）');
  expect(document.body.textContent).not.toContain('operator');
});
