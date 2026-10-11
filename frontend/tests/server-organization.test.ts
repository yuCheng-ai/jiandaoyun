// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import PermissionDialog from '../src/features/collaboration/PermissionDialog.vue';
import { platformApi, PlatformError } from '../src/repositories/platformApi';
vi.mock('vue-router', async original => ({ ...await original<typeof import('vue-router')>(), onBeforeRouteLeave: vi.fn() }));
vi.mock('../src/repositories/platformApi', async original => ({ ...await original<typeof import('../src/repositories/platformApi')>(), platformApi: vi.fn() }));
vi.mock('../src/components/BaseDialog.vue', () => ({ default: defineComponent({ setup(_, { slots }) { return () => h('section', [slots.default?.(), slots.footer?.()]); } }) }));
const directory = { revision: 3, users: [{ id: 'member', name: '办理人', username: 'editor', role: 'member', active: true }], spec: { departments: [{ id: 'a', name: '业务部', parentId: null, archived: false }, { id: 'b', name: '复核部', parentId: null, archived: false }], roleGroups: [{ id: 'g', name: '岗位' }], roles: [{ id: 'r', name: '复核人', groupId: 'g', description: '', memberIds: [], departmentIds: ['a'], includeChildren: true, archived: false }], assignments: [{ userId: 'member', departmentIds: ['a'], primaryDepartmentId: 'a' }] } };
let app: ReturnType<typeof createApp> | undefined;
const clone = () => structuredClone(directory);
async function settle() { for (let i = 0; i < 15; i++) await nextTick(); }
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!;
async function click(text: string) { button(text).click(); await settle(); }
async function input(selector: string, value: string) { const element = document.querySelector<HTMLInputElement>(selector)!; element.value = value; element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await settle(); }
beforeEach(() => { vi.mocked(platformApi).mockReset(); document.body.innerHTML = '<div id="mount"></div>'; });
afterEach(() => { app?.unmount(); document.body.innerHTML = ''; });

it('saves an explicit creation-department basis and explains that missing snapshots do not grant access',async()=>{
  vi.mocked(platformApi).mockImplementation(async(path,method)=>method==='PUT'?{}:path==='/organization'?clone():[]);
  const definition:any={id:'object',schema:{fields:[{id:'name',label:'名称',children:[]}]}};
  app=createApp({render:()=>h(PermissionDialog,{definition,users:directory.users as any,grants:[]})});app.mount('#mount');await settle();
  const scope=[...document.querySelectorAll('select')].find(el=>[...el.options].some(option=>option.value==='self'))!;scope.value='department';scope.dispatchEvent(new Event('change',{bubbles:true}));await settle();
  const basis=[...document.querySelectorAll('select')].find(el=>[...el.options].some(option=>option.value==='record-created'))!;expect(basis.value).toBe('creator-current');basis.value='record-created';basis.dispatchEvent(new Event('change',{bubbles:true}));await settle();
  expect(document.body.textContent).toContain('未留存创建部门的旧记录不会据此授权');await click('保存当前授权');
  expect(vi.mocked(platformApi).mock.calls.find(call=>call[1]==='PUT')?.[2]).toMatchObject({scope:'department',departmentBasis:'record-created'});
});

it('role grants send the role identity and revision, and safely recover a stale policy', async () => {
  const policy = { read: true, create: false, edit: false, scope: 'all', fields: { name: 'read' } };
  let writes = 0;
  vi.mocked(platformApi).mockImplementation(async (path, method) => {
    if (method === 'PUT') { writes++; throw new PlatformError('授权已修改', 409); }
    if (path === '/organization') return clone();
    if (path.endsWith('/subject-grants')) return [{ subject: { kind: 'role', id: 'r' }, policy: structuredClone(policy), revision: 7 }];
    return [];
  });
  const definition: any = { id: 'object', schema: { fields: [{ id: 'name', label: '名称', children: [] }] } };
  app = createApp({ render: () => h(PermissionDialog, { definition, users: directory.users as any, grants: [] }) }); app.mount('#mount'); await settle();
  const kind = document.querySelector<HTMLSelectElement>('.permission-subjects select')!; kind.value = 'role'; kind.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  expect(document.body.textContent).toContain('当前适用：办理人'); await input('[aria-label="名称权限"]', 'edit');
  expect(kind.disabled).toBe(true); await click('保存当前授权');
  const request = vi.mocked(platformApi).mock.calls.find(call => call[1] === 'PUT')!;
  expect(request[0]).toBe('/definitions/object/subject-grants'); expect(request[2]).toMatchObject({ subject: { kind: 'role', id: 'r' }, expectedRevision: 7, fields: { name: 'edit' } });
  expect((request[2] as any).userId).toBeUndefined(); expect(writes).toBe(1);
  await click('重新读取授权'); expect((document.querySelector('[aria-label="名称权限"]') as HTMLSelectElement).value).toBe('edit');
  await click('放弃修改并读取'); expect((document.querySelector('[aria-label="名称权限"]') as HTMLSelectElement).value).toBe('read');
  expect(kind.disabled).toBe(false);
});
