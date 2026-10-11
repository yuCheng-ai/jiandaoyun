// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import RecordOriginDialog from '../src/features/collaboration/RecordOriginDialog.vue';
import { platformApi } from '../src/repositories/platformApi';
vi.mock('../src/repositories/platformApi',()=>({platformApi:vi.fn()}));
vi.mock('../src/components/BaseDialog.vue',()=>({default:defineComponent({setup(_, {slots}){return()=>h('section',[slots.default?.(),slots.footer?.()]);}})}));
let app:ReturnType<typeof createApp>;
const origin={status:'rejected',sourceApplicationName:'原应用',sourceFormName:'原表单',sourceVersion:2,sourceCreatorName:'原经办人',sourceDepartments:null,createdAt:'2024-03-02T10:11:12+08:00',deletedAt:'2024-03-04T10:11:12+08:00',history:[{label:'审核',action:'<img src=x onerror=alert(1)>',time:'2024-03-03T10:11:12+08:00'},{label:'申请',action:'保留源顺序',time:'2024-03-02T10:11:12+08:00'}]};
async function settle(){for(let i=0;i<12;i++)await nextTick();}
async function mount(){document.body.innerHTML='<div id="mount"></div>';const close=vi.fn();app=createApp({render:()=>h(RecordOriginDialog,{recordId:'old-record',onClose:close})});app.mount('#mount');await settle();return close;}
const button=(label:string)=>[...document.querySelectorAll('button')].find(el=>el.textContent?.trim()===label)!;
afterEach(()=>{app?.unmount();vi.resetAllMocks();});
it('keeps source state, deletion and history ordering visible while escaping free text',async()=>{
  vi.mocked(platformApi).mockResolvedValue(origin);const close=await mount();expect(vi.mocked(platformApi).mock.calls[0]?.[0]).toBe('/records/old-record/origin');
  expect(document.body.textContent).toContain('已退回（原记录已删除）');expect(document.body.textContent).toContain('原记录未留存');expect(document.querySelector('img')).toBeNull();
  expect([...document.querySelectorAll('li strong')].map(el=>el.textContent)).toEqual(['审核','申请']);expect(document.body.textContent).toContain(origin.createdAt);button('关闭').click();expect(close).toHaveBeenCalled();
});
it('reports a failed read and retries without turning unknown departments into an empty assignment',async()=>{
  vi.mocked(platformApi).mockRejectedValueOnce(new Error('无权读取')).mockResolvedValueOnce({...origin,sourceDepartments:[]});await mount();expect(document.body.textContent).toContain('无权读取');button('重新读取').click();await settle();expect(document.body.textContent).toContain('创建时无所属部门');expect(document.body.textContent).not.toContain('无权读取');
});
