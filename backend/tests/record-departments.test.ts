import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, field, schema } from './helpers';
const h = harness(), a = randomUUID(), child = randomUUID(), b = randomUUID();
let admin: string, editor: string, reviewer: string, base: any;
const fields = { name: 'edit', secret: 'edit' };
async function org(spec: any) { const current = await h.request('/organization'); return h.request('/organization', 'PUT', { expectedRevision: current.revision, spec }); }
const grant = (id: string, userId: string, extra = {}) => h.request(`/definitions/${id}/grants`, 'PUT', { userId, read: true, create: true, edit: true, scope: 'all', fields, ...extra });
async function setup() { const def = await h.definition('创建部门验收', schema(field('name'),field('secret'))); await grant(def.id,editor); return def; }
before(async () => { await h.start(); const users = await h.request('/users'); [admin,editor,reviewer] = ['admin','editor','reviewer'].map(name=>users.find((u:any)=>u.username===name).id); base={ departments:[{id:a,name:'原业务部',parentId:null,archived:false},{id:child,name:'下级组',parentId:a,archived:false},{id:b,name:'新业务部',parentId:null,archived:false}],roleGroups:[],roles:[],assignments:[{userId:admin,departmentIds:[b],primaryDepartmentId:b},{userId:editor,departmentIds:[a],primaryDepartmentId:a},{userId:reviewer,departmentIds:[a],primaryDepartmentId:a}] }; });
beforeEach(()=>org(structuredClone(base))); after(()=>h.close());

test('creation department snapshots survive transfer, edits and draft submission; client values cannot override them',async()=>{
  const def=await setup(), draft=await h.request(`/definitions/${def.id}/records`,'POST',{requestId:randomUUID(),version:1,state:'draft',createdDepartmentIds:[b],values:{name:'原部门草稿'}},'editor',201);
  assert.deepEqual(draft.record.createdDepartmentIds,[a]);
  const moved=structuredClone(base); moved.assignments[1].departmentIds=[b];moved.assignments[1].primaryDepartmentId=b;await org(moved);
  const result=await h.request(`/records/${draft.record.id}/submit`,'POST',{requestId:randomUUID(),expectedRevision:1,createdDepartmentIds:[b]},'editor',201);
  assert.deepEqual(result.record.createdDepartmentIds,[a]);
  const created=await h.record(def.id,{name:'新部门记录'},'editor');assert.deepEqual(created.record.createdDepartmentIds,[b]);
  await h.restart();assert.deepEqual((await h.request(`/records/${draft.record.id}`)).record.createdDepartmentIds,[a]);
});

test('record-created scope matches exact stored departments while the existing creator-current scope keeps its behavior',async()=>{
  const def=await setup(), old=await h.record(def.id,{name:'调动前'},'editor');
  const moved=structuredClone(base);moved.assignments[1].departmentIds=[b];moved.assignments[1].primaryDepartmentId=b;await org(moved);
  const fresh=await h.record(def.id,{name:'调动后'},'editor');
  await grant(def.id,reviewer,{scope:'department',departmentBasis:'record-created'});
  assert.deepEqual((await h.request(`/definitions/${def.id}/records`,'GET',undefined,'reviewer')).map((r:any)=>r.id),[old.record.id]);
  assert.equal((await h.request(`/records/${old.record.id}`,'GET',undefined,'reviewer')).access.edit,true);
  await h.request(`/records/${fresh.record.id}`,'GET',undefined,'reviewer',403);
  await grant(def.id,reviewer,{scope:'department',departmentBasis:'creator-current'});
  assert.deepEqual(await h.request(`/definitions/${def.id}/records`,'GET',undefined,'reviewer'),[]);
  await h.request(`/records/${old.record.id}`,'GET',undefined,'reviewer',403);
});

test('missing snapshots and child departments do not acquire inferred access; mixed grants clamp writable fields per record',async()=>{
  const def=await setup(), old=await h.record(def.id,{name:'未知原部门'},'editor');
  await h.db.query('UPDATE records SET created_department_ids=NULL WHERE id=$1',[old.record.id]);
  const inChild=structuredClone(base);inChild.assignments[1].departmentIds=[child];inChild.assignments[1].primaryDepartmentId=child;await org(inChild);
  const childRecord=await h.record(def.id,{name:'子部门'},'editor');
  await grant(def.id,reviewer,{scope:'department',departmentBasis:'record-created'});
  assert.deepEqual(await h.request(`/definitions/${def.id}/records`,'GET',undefined,'reviewer'),[]);
  await h.request(`/records/${old.record.id}`,'GET',undefined,'reviewer',403);await h.request(`/records/${childRecord.record.id}`,'GET',undefined,'reviewer',403);
  await h.request(`/definitions/${def.id}/subject-grants`,'PUT',{subject:{kind:'department',id:a},expectedRevision:0,read:true,create:false,edit:false,scope:'all',fields:{name:'read',secret:'hidden'}});
  const result=await h.request(`/records/${old.record.id}`,'GET',undefined,'reviewer');assert.equal(result.access.edit,false);assert.equal(result.access.fields.name,'read');assert.equal(result.record.values.secret,undefined);
});

test('relationship candidate queries apply creation-department scope before pagination and direct linking rechecks it',async()=>{
  const source=await setup(),target=await setup(),record=await h.record(source.id,{name:'来源'}),old=await h.record(target.id,{name:'原部门候选'},'editor'),other=await h.record(target.id,{name:'其他部门候选'});
  const moved=structuredClone(base);moved.assignments[1].departmentIds=[b];moved.assignments[1].primaryDepartmentId=b;await org(moved);
  const relation=await h.relation({title:'部门关联',sourceDefinitionId:source.id,targetDefinitionId:target.id,cardinality:'many',inverseCardinality:'many',labelFieldId:'name',columns:['name'],filters:[],mappings:[],valueMode:'live'});
  await grant(source.id,reviewer,{relations:{[relation.id]:'edit'}});await grant(target.id,reviewer,{scope:'department',departmentBasis:'record-created'});
  const candidates=await h.request(`/records/${record.record.id}/relations/${relation.id}/candidates`,'GET',undefined,'reviewer');assert.deepEqual(candidates.items.map((r:any)=>r.recordId),[old.record.id]);
  await h.request(`/records/${record.record.id}/relations/${relation.id}/links`,'POST',{requestId:randomUUID(),targetRecordId:other.record.id,expectedCells:record.record.cellRevisions},'reviewer',403);
  await h.request(`/definitions/${source.id}/grants`,'PUT',{userId:reviewer,read:true,create:false,edit:false,scope:'department',fields,departmentBasis:'guessed'},'admin',400);
});
