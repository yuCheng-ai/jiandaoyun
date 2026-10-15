// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { separateFormSchema } from "@platform/contracts";
import { createField, emptySchema, type FormField } from "../src/domain/form";
import { pageUpdate } from "../src/domain/pageDesigner";
import ServerFieldControl from "../src/features/collaboration/ServerFieldControl.vue";
import RecordEditor from "../src/features/collaboration/RecordEditor.vue";
import FieldValueRules from "../src/features/data/FieldValueRules.vue";
import { platformApi } from "../src/repositories/platformApi";
vi.mock("vue-router", () => ({
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../src/repositories/platformApi", async original => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
vi.mock("../src/features/data/RecordRelations.vue", () => ({ default: { render: () => null } }));
vi.mock("../src/components/BaseDialog.vue", () => ({ default: defineComponent({ props: ['open'], setup(props, { slots }) { return () => props.open ? h('section', [slots.default?.(), slots.footer?.()]) : null; } }) }));
const options = [{ id: "ok", label: "合格" }, { id: "review", label: "待复核" }];
let app: ReturnType<typeof createApp> | undefined;
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }
async function mount(component: Parameters<typeof createApp>[0]) { document.body.innerHTML = '<div id="app"></div>'; app = createApp(component); app.mount('#app'); await settle(); }
const control = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`)!;
async function fill(label: string, value: string) { const input = control<HTMLInputElement>(label); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); await settle(); }
afterEach(() => { app?.unmount(); vi.clearAllMocks(); });

it("choice inputs display labels and emit option identities, including arrays and readonly controls", async () => {
  const field = createField('checkbox', { id: 'flags', options }); const value = ref<unknown>(['ok']);
  await mount({ render: () => h(ServerFieldControl, { field, modelValue: value.value, inputId: 'flags', label: '复核项目', 'onUpdate:modelValue': next => value.value = next }) });
  expect(document.body.textContent).toContain('待复核');
  (document.querySelector('input[value="review"]') as HTMLInputElement).click(); await settle();
  expect(value.value).toEqual(['ok', 'review']);
  (document.querySelector('input[value="ok"]') as HTMLInputElement).click(); await settle(); expect(value.value).toEqual(['review']);
  app!.unmount(); app = undefined;
  value.value = 'ok';
  await mount({ render: () => h(ServerFieldControl, { field: { ...field, type: 'radio' }, modelValue: value.value, inputId: 'clearable', label: '可清空结果', 'onUpdate:modelValue': next => value.value = next }) });
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === '清空选择')!.click(); await settle(); expect(value.value).toBe('');
  app!.unmount(); app = undefined;
  const changed = vi.fn(); await mount({ render: () => h(ServerFieldControl, { field: { ...field, type: 'radio' }, modelValue: 'ok', inputId: 'readonly', label: '只读结果', disabled: true, 'onUpdate:modelValue': changed }) });
  (document.querySelector('input[value="review"]') as HTMLInputElement).click(); expect(changed).not.toHaveBeenCalled();
});

it("date and contact controls use their declared formats without converting the entered time", async () => {
  const value = ref<unknown>('2026-10-09T08:30'); const field = createField('datetime', { format: 'datetime-local' });
  await mount({ render: () => h(ServerFieldControl, { field, modelValue: value.value, inputId: 'time', label: '办理时间', 'onUpdate:modelValue': next => value.value = next }) });
  expect(control<HTMLInputElement>('办理时间').type).toBe('datetime-local');
  await fill('办理时间', '2028-02-29T10:15'); expect(value.value).toBe('2028-02-29T10:15');
});

it("multiselect retains its expandable selector and readable selected labels", async () => {
  const field = createField('multiselect', { options }); const value = ref<unknown>(['ok']);
  await mount({ render: () => h(ServerFieldControl, { field, modelValue: value.value, inputId: 'multi', label: '核对项', 'onUpdate:modelValue': next => value.value = next }) });
  expect(document.querySelector('summary')?.textContent).toContain('合格');
  document.querySelector('summary')!.click(); await settle();
  expect(document.querySelector('details')!.open).toBe(true);
  control<HTMLInputElement>('核对项 待复核').click(); await settle(); expect(value.value).toEqual(['ok','review']); expect(document.querySelector('summary')?.textContent).toContain('合格、待复核');
});

it("shared option editing preserves identities when renaming and clears only the removed default", async () => {
  const original = createField('multiselect', { label: '验收', options, defaultValue: ['ok', 'review'] });
  const field = ref(structuredClone(original));
  await mount({ render: () => h(FieldValueRules, { field: field.value, onUpdate: patch => Object.assign(field.value, patch) }) });
  await fill('验收选项 1', '验收通过');
  expect(field.value.options[0]).toEqual({ id: 'ok', label: '验收通过' }); expect(field.value.defaultValue).toEqual(['ok', 'review']); expect(original.options[0]!.label).toBe('合格');
  control<HTMLButtonElement>('验收移除选项 2').click(); await settle(); expect(field.value.defaultValue).toEqual(['ok']);
});

it("page additions carry date and option rules while page-required does not become permanently required", () => {
  const base = emptySchema(); const split = separateFormSchema(base);
  const data = { object: { id: 'object', title: '数据', revision: 1, latestVersion: 0, model: split.model }, model: split.model, draft: { id: 'page', title: '页面', revision: 1, latestVersion: 0, definitionId: 'object', definitionVersion: 0, schema: split.page, additions: [], baseDefinitionRevision: null } };
  const schema = { ...base, fields: [createField('datetime', { id: 'day', format: 'datetime-local' }), createField('subform', { id: 'lines', children: [createField('checkbox', { id: 'flags', options, required: true, defaultValue: ['ok'] })] })] };
  const update = pageUpdate(data, { title: '页面', schema });
  expect(update.additions[0]!.field.settings.format).toBe('datetime-local');
  const child = update.additions[1]!.field.children[0]!; expect(child.id).toBe('flags'); expect(child.required).toBe(false); expect(child.settings.options).toEqual(options); expect(child.settings.defaultValue).toEqual(['ok']);
  expect(update.schema.controls[1]!.children[0]!.properties.required).toBe(true);
});

it("record submission retains arrays in main and row fields, and a failed request can retry with the same identity", async () => {
  const schema = { ...emptySchema(), fields: [createField('datetime', { id: 'day', label: '日期' }), createField('select', { id: 'status', label: '结果', options }), createField('multiselect', { id: 'flags', label: '项目', options, defaultValue: ['ok'] }), createField('subform', { id: 'lines', label: '明细', children: [createField('checkbox', { id: 'rowFlags', label: '明细项目', options, defaultValue: ['review'] })] })] };
  const published = { definition: { id: 'data', version: 1, title: '记录', schema, createdAt: '' }, access: { userId: 'admin', read: true, create: true, edit: true, scope: 'all' as const, fields: Object.fromEntries(['day','status','flags','lines','rowFlags'].map(id=>[id, 'edit' as const])) } };
  vi.mocked(platformApi).mockRejectedValueOnce(new Error('保存失败，请重试')).mockResolvedValueOnce({ record: { id: 'saved' } });
  const saved = vi.fn(); await mount({ render: () => h(RecordEditor, { published, onSaved: saved }) });
  await fill('日期','2026-10-09');
  control<HTMLElement>('结果').click(); await settle();
  Array.from(document.querySelectorAll<HTMLElement>('[role=option]')).find(item => item.textContent?.trim() === '待复核')!.click(); await settle();
  const button = (text: string) => [...document.querySelectorAll('button')].find(item=>item.textContent?.trim()===text)!;
  button('添加明细').click(); await settle();
  button('提交记录').click(); await settle(); expect(document.body.textContent).toContain('保存失败，请重试'); expect(saved).not.toHaveBeenCalled();
  const first = vi.mocked(platformApi).mock.calls[0]![2] as any;
  expect(first.values).toEqual({ day: '2026-10-09', status: 'review', flags: ['ok'], lines: [{ rowFlags: ['review'] }] });
  button('提交记录').click(); await settle(); expect(vi.mocked(platformApi).mock.calls[1]![2]).toEqual(first); expect(saved).toHaveBeenCalledOnce();
});
