import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { modelFormSchema } from '@platform/contracts';
import { harness, field, schema } from './helpers';
const h=harness();
const { RecordOriginService } = require('../src/record-origins') as typeof import('../src/record-origins');
const { MigrationIdentityService } = require('../src/migration-identities') as typeof import('../src/migration-identities');
const { OrganizationService } = require('../src/organization') as typeof import('../src/organization');
let actor:any,editor:string,service:InstanceType<typeof RecordOriginService>;
const at='2024-03-02T10:11:12+08:00';
async function fixture(status='approved',deleted=false,invalidHistory=false) {
  const namespace=randomUUID(),identitySource={namespace,applicationId:'legacy',applicationName:'原业务',fingerprint:'c'.repeat(64),identities:[{kind:'member',sourceId:'old-owner',name:'原经办人',found:true,active:false},{kind:'department',sourceId:'old-dept',name:'原业务部',found:true,active:false}],counts:{forms:1,versions:1,records:1,rows:status==='draft'?0:1,issues:0}};
  let batch=await h.request('/migration-batches','POST',{requestId:randomUUID(),source:identitySource},'admin',201);
  batch=await h.request(`/migration-batches/${batch.id}`,'PUT',{requestId:randomUUID(),expectedRevision:batch.revision,sourceFingerprint:identitySource.fingerprint,choices:batch.choices.map((c:any)=>({...c,mode:'historical'}))});
  const review=await h.request(`/migration-batches/${batch.id}/review`,'POST',{expectedRevision:batch.revision,sourceFingerprint:identitySource.fingerprint},'admin',201);
  batch=await h.request(`/migration-batches/${batch.id}/confirm-identities`,'POST',{requestId:randomUUID(),expectedRevision:batch.revision,sourceFingerprint:identitySource.fingerprint,token:review.token},'admin',201);
  const definition=schema(field('note','text',{required:true}),field('lines','subform',{children:[field('item','text',{required:true})]}));
  const version={version:1,title:'原办理表',schema:definition,publishedAt:at,workflow:{enabled:false,nodes:[]},extensions:{}};
  const entry={id:'entry',formId:'form',definitionVersion:1,createdBy:'old-owner',createdDepartmentIds:['old-dept'],createdAt:at,status,...(deleted?{deletedAt:at}:{}),history:invalidHistory?[{label:'不会出现在错误中的业务内容',action:{bad:true},time:at}]:[{label:'提交',action:'原始申请',time:at},{label:'复核',action:'原系统处理记录',time:at}],values:status==='draft'?{}:{note:'保留旧值',lines:[{_rowId:'original-row',item:'原明细'}]}};
  const source={format:1,namespace,applicationId:'legacy',fingerprint:identitySource.fingerprint,application:{id:'legacy',name:'原业务'},forms:[{id:'form',appId:'legacy',title:'原办理表',schema:definition,workflow:version.workflow,extensions:{},versions:[version],published:version}],entries:[entry],access:{},recordViews:{},roles:[],orders:[],runs:[]};
  const plan=await h.request(`/migration-batches/${batch.id}/resources`,'POST',{requestId:randomUUID(),expectedBatchRevision:batch.revision,expectedResourceRevision:0,source},'admin',201);
  const snapshot=(await h.db.query('SELECT * FROM migration_resource_snapshots WHERE id=$1',[plan.id])).rows[0],form=snapshot.projection.forms[0],model=form.versions[0].model;
  // Surrounding application/model are controlled fixtures. The application-wide import is not exposed yet.
  await h.db.query('INSERT INTO applications(id,workspace_id,title) VALUES($1,$2,$3)',[plan.targetApplicationId,actor.workspaceId,'迁移组件验收']);
  await h.db.query('INSERT INTO definitions(id,workspace_id,title,draft,model_draft,application_id,latest_version) VALUES($1,$2,$3,$4,$5,$6,1)',[form.definitionId,actor.workspaceId,'原办理表',modelFormSchema(model),model,plan.targetApplicationId]);
  await h.db.query('INSERT INTO definition_versions(definition_id,version,title,schema) VALUES($1,1,$2,$3)',[form.definitionId,'原办理表',modelFormSchema(model)]);
  return {batch,plan,snapshot,entry,definitionId:form.definitionId,recordId:plan.records[0].targetId};
}
const importRecord=(f:any,who=actor)=>h.db.transaction(tx=>service.importIn(tx,who,f.plan.id,'entry'));
before(async()=>{await h.start();const users=await h.request('/users');actor={...users.find((u:any)=>u.username==='admin'),workspaceId:'local'};editor=users.find((u:any)=>u.username==='editor').id;service=new RecordOriginService(h.db,new MigrationIdentityService(h.db,new OrganizationService(h.db)));});
after(()=>h.close());

test('record import preserves original status, timestamps, departments, ordered history and stable values without replaying actions',async()=>{
  const f=await fixture(),id=await importRecord(f);assert.equal(await importRecord(f),id);
  const detail=await h.request(`/records/${id}`),origin=await h.request(`/records/${id}/origin`);
  assert.equal(detail.canReadOrigin,true);assert.equal(detail.record.state,'active');assert.equal(detail.creator.name,'原经办人');assert.equal(detail.record.createdAt,new Date(at).toISOString());
  assert.deepEqual(detail.record.createdDepartmentIds,[f.batch.choices.find((c:any)=>c.kind==='department').targetId]);assert.equal(origin.status,'approved');assert.equal(origin.createdAt,at);assert.equal(origin.updatedAt,undefined);assert.deepEqual(origin.history,f.entry.history);assert.equal(origin.sourceDepartments[0].name,'原业务部');
  await h.request(`/records/${id}`,'PATCH',{requestId:randomUUID(),changes:[{fieldId:'note',value:'当前补充',expectedRevision:1}]});
  assert.deepEqual(await h.request(`/records/${id}/origin`),origin);assert.equal(await importRecord(f),id);assert.equal((await h.request(`/records/${id}`)).record.values.note,'当前补充');
  const events=(await h.db.query('SELECT * FROM record_events WHERE record_id=$1 ORDER BY revision',[id])).rows;assert.equal(events.length,2);assert.equal(events[0].changes.action,'import');assert.equal(events[0].actor_id,actor.id);assert.equal((await h.db.query('SELECT count(*) FROM processes')).rows[0].count,'0');
  await assert.rejects(h.db.query("UPDATE record_origins SET metadata='{}' WHERE record_id=$1",[id]),/immutable/i);
  await assert.rejects(h.db.query('DELETE FROM record_origins WHERE record_id=$1',[id]),/immutable/i);
  await h.restart();assert.deepEqual(await h.request(`/records/${id}/origin`),origin);
});

test('draft and deleted source states remain separate, and missing values or timestamps are not filled from current defaults',async()=>{
  const draft=await fixture('draft'),deleted=await fixture('rejected',true);await importRecord(draft);await importRecord(deleted);
  const d=await h.request(`/records/${draft.recordId}`);assert.equal(d.record.state,'draft');assert.deepEqual((await h.db.query('SELECT values FROM records WHERE id=$1',[draft.recordId])).rows[0].values,{});
  assert.deepEqual(await h.request(`/definitions/${draft.definitionId}/records`),[]);assert.equal((await h.request(`/definitions/${draft.definitionId}/records?state=draft`)).length,1);
  await h.request(`/records/${deleted.recordId}`,'GET',undefined,'admin',404);assert.deepEqual(await h.request(`/definitions/${deleted.definitionId}/records`),[]);
  const original=await h.request(`/records/${deleted.recordId}/origin`);assert.equal(original.status,'rejected');assert.equal(original.deletedAt,at);
});

test('free-text legacy history is admin-only and absent from masked member and row-task responses',async()=>{
  const f=await fixture();await importRecord(f);await h.request(`/definitions/${f.definitionId}/grants`,'PUT',{userId:editor,read:true,create:false,edit:false,scope:'all',fields:{note:'read',lines:'hidden',item:'hidden'}});
  const detail=await h.request(`/records/${f.recordId}`,'GET',undefined,'editor');assert.equal(detail.canReadOrigin,undefined);assert.equal(JSON.stringify(detail).includes('原系统处理记录'),false);
  await h.request(`/records/${f.recordId}/origin`,'GET',undefined,'editor',403);
  await assert.rejects(importRecord(f,{...actor,role:'member'}),/权限|管理员/);
  const task=await h.request('/processes','POST',{requestId:randomUUID(),bindings:{main:f.recordId},spec:{title:'当前流程',tasks:[{id:'check',title:'核对',assigneeId:actor.id,recordBinding:'main',dependsOn:[]}]}},'admin',201);
  const scoped=await h.request(`/processes/${task.id}/tasks/${task.tasks[0].id}/record`);assert.equal(scoped.canReadOrigin,undefined);assert.equal(JSON.stringify(scoped).includes('原系统处理记录'),false);
});

test('malformed history stays in the raw archive but blocks conversion without exposing its content',async()=>{
  const f=await fixture('approved',false,true);assert.equal(f.plan.records[0].checked,false);assert.equal(JSON.stringify(f.plan).includes('不会出现在错误中的业务内容'),false);assert.deepEqual(f.snapshot.payload.entries[0].history,f.entry.history);
  await assert.rejects(importRecord(f),/唯一且通过检查/);assert.equal((await h.db.query('SELECT 1 FROM records WHERE id=$1',[f.recordId])).rowCount,0);
});

test('audit failure rolls back imported values and origin; stale identity review cannot import',async()=>{
  const f=await fixture();await h.db.query("CREATE FUNCTION reject_import_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.changes->>'action'='import' THEN RAISE EXCEPTION 'import fault'; END IF; RETURN NEW; END $$");await h.db.query('CREATE TRIGGER reject_import_event BEFORE INSERT ON record_events FOR EACH ROW EXECUTE FUNCTION reject_import_event()');
  try{await assert.rejects(importRecord(f),/import fault/);}finally{await h.db.query('DROP TRIGGER reject_import_event ON record_events');}
  assert.equal((await h.db.query('SELECT 1 FROM record_origins WHERE record_id=$1',[f.recordId])).rowCount,0);assert.equal((await h.db.query('SELECT 1 FROM records WHERE id=$1',[f.recordId])).rowCount,0);
  await importRecord(f);
  const stale=await fixture();const org=await h.request('/organization');await h.request('/organization','PUT',{expectedRevision:org.revision,spec:org.spec});await assert.rejects(importRecord(stale),/依据已变化/);
});

test('foreign snapshots, reserved identity mismatches and duplicate concurrent imports cannot replace a record',async()=>{
  const f=await fixture();
  await assert.rejects(importRecord(f,{...actor,workspaceId:'another-workspace'}),/快照不存在/);
  const ids=await Promise.all([importRecord(f),importRecord(f)]);assert.deepEqual(ids,[f.recordId,f.recordId]);
  assert.equal((await h.db.query('SELECT 1 FROM record_events WHERE record_id=$1',[f.recordId])).rowCount,1);
  const other=await fixture();await importRecord(other);
  await assert.rejects(h.db.query('INSERT INTO record_origins(record_id,workspace_id,snapshot_id,source_form_id,source_record_id,metadata,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[f.recordId,actor.workspaceId,other.plan.id,'form','entry',{},actor.id]),/reserved source identity/);
  const original=await h.request(`/records/${f.recordId}/origin`);assert.equal(original.sourceCreatorName,'原经办人');
});
