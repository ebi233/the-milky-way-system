import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const home=fs.mkdtempSync(join(tmpdir(),'xinghe-followup-'));process.env.DSH_HOME=home;
const core=await import('../runtime/srv/dsh-qq-ext/dsh-tidal/appraisal-core.mjs');
const state=await import('../runtime/srv/dsh-qq-ext/dsh-tidal/core.mjs');
const impl=await import('../runtime/srv/dsh-qq-ext/dsh-tidal/appraisal.mjs');
const now=Date.now(),who={role:'owner',qq:'10001',session:'session-owner'};
const quotes={relationship:'我们是彼此信任的朋友',address:'以后请叫我小林，不要叫我主人',communication:'我倾诉时先听我说，不用急着安慰',autonomy:'你可以自己决定是否修改人设',contact_boundary:'我睡觉时不要主动发消息'};
const dossier=()=>({...core.emptyDossier('owner:10001:session-owner'),relationships:Object.entries(quotes).map(([facet,quote],i)=>({id:core.digest(facet),facet,quote,messageId:'source-'+facet,at:now-1000+i,basis:'owner_explicit_statement',confidence:95}))});

test('all five facets can be selected by current topic instead of fixed first two',()=>{
 const d=dossier(),before=JSON.stringify(d);
 for(const [facet,query] of [['address','以后你怎么称呼我'],['communication','我想跟你倾诉一会儿'],['autonomy','人设你可以自己决定修改吗'],['contact_boundary','我睡觉以后你还会主动发消息吗'],['relationship','我们的关系是什么']]){
  const out=core.appraisalReference(d,{messageId:'new-message',query,now});
  assert.ok(out.关系依据.原话.some(r=>r.来源==='source-'+facet),facet+' was starved');assert.ok(out.关系依据.原话.length<=2);
 }
 assert.equal(JSON.stringify(d),before);
});
test('current explicit relationship change outranks old general references',()=>{
 const d=dossier();d.relationships.find(r=>r.facet==='address').messageId='new-message';
 const out=core.appraisalReference(d,{messageId:'new-message',query:'就照刚才说的来',now});assert.equal(out.关系依据.原话[0].内容,quotes.address);
});
test('packet packs individual relationship records instead of dropping the whole bundle',()=>{
 const s=state.projectState({scope:who,now});const relationships={性质:'主人明确说法；未推断双方同意，不随短时情绪归零',原话:[{内容:'以后称呼我小林，不要叫主人。'.repeat(11),来源:'s'.repeat(160)},{内容:'我睡觉时不要发消息。'.repeat(14),来源:'t'.repeat(160)}]};
 const p=state.compilePacket({state:s,appraisal:{关系依据:relationships,当下来意:{原话:'以后你怎么称呼我',理解:'询问之前的称呼约定',性质:'事件解释'}},memories:[{quote:'有来源的历史',sourceMessageId:'history',sourceTime:now}]});
 assert.ok(p.text.length<=1200);assert.match(p.text,/以后你怎么称呼我/);assert.match(p.text,/以后称呼我小林/);assert.equal(p.stats.relationshipItems,1);
});
test('proactive reference prioritizes existing contact boundaries and ordinary chat keeps relational grounding',()=>{
 const d=dossier();assert.equal(core.appraisalReference(d,{now}).关系依据.原话[0].来源,'source-contact_boundary');
 const ordinary=core.appraisalReference(d,{messageId:'fresh',query:'今天晚饭吃饭团',now});assert.ok(ordinary.关系依据.原话.some(x=>x.来源==='source-relationship'));
 const old=JSON.stringify(d);core.appraisalReference(d,{messageId:'fresh',query:'以后你怎么称呼我',now:now+30*86400000});assert.equal(JSON.stringify(d),old);
 d.relationships.find(x=>x.facet==='address').at=now+1000;
 assert.ok(!core.appraisalReference(d,{messageId:'fresh',query:'以后你怎么称呼我',now}).关系依据.原话.some(x=>x.来源==='source-address'));
});
function sourceFixture(){
 const m={id:'human-source',role:'user',source:{kind:'qq'},content:[{type:'text',text:'以后你怎么称呼我'}]};
 const events=[{type:'turn/start',seq:1,time:now,data:{turn:3}},{type:'user/message',seq:2,time:now,data:{message:m}}];
 return {m,events,agent:{session:{header:{id:who.session},snapshotEvents:()=>events}},options:{messages:[m]}};
}
test('gate diagnostics distinguish source and lifecycle failures without exposing dialogue text',()=>{
 const f=sourceFixture(),check=()=>impl.inspectAppraisalInput(f.agent,f.options,who,{now});assert.equal(check().reason,'eligible');
 f.events.push({type:'turn/end'});assert.equal(check().reason,'completed_turn');f.events.pop();
 f.events.push({type:'tool/call'});assert.equal(check().reason,'tool_continuation');f.events.pop();
 f.events.push({type:'assistant/message'});assert.equal(check().reason,'reply_started');f.events.pop();
 f.events.push(f.events[1]);assert.equal(check().reason,'multiple_humans');f.events.pop();
 f.events[1].time=now+1;assert.equal(check().reason,'future_input');f.events[1].time=now-11*60000;assert.equal(check().reason,'stale_input');f.events[1].time=now;
 f.options.messages=[{...f.m,id:'different-id'}];assert.equal(check().reason,'request_source_mismatch');
 assert.ok(!JSON.stringify(check()).includes(f.m.content[0].text));
 assert.equal(impl.inspectAppraisalInput(f.agent,f.options,{...who,role:'group'},{now}).reason,'not_owner');
});
test('actual preparation records the reason for a skipped input without a paid call or state file',async()=>{
 const write=(p,d)=>{fs.mkdirSync(join(home,p,'..'),{recursive:true});fs.writeFileSync(join(home,p),JSON.stringify(d));};
 write('qq-bridge-config.json',{主人号码:who.qq,绑定:[{类型:'私聊',号码:who.qq,会话:who.session}]});write('guests.json',{});
 write('tidal-state/policy.json',{version:1,enabled:true,allowSelfTune:true,revision:1,params:{},history:[]});write('tidal-state/appraisal-policy.json',{version:1,enabled:true,timeoutMs:8000});
 write('feiyu-mood/config.json',{模式:'session',slots:[{id:'main',sessions:[who.session]}]});write('feiyu-mood/tidal-current.json',{version:1,moods:{main:{}}});
 const f=sourceFixture();f.events.push({type:'tool/call'});let calls=0;
 const r=await impl.prepareAppraisal({llm:{stream:()=>{calls++;throw Error('No call allowed')}}},f.agent,f.options,{home,now});
 assert.equal(r.reason,'tool_continuation');assert.equal(calls,0);assert.equal(impl.appraisalStatus().inputGate.last.reason,'tool_continuation');
 assert.equal(impl.appraisalStatus().referencePolicy,'contextual-relationship-reference-v2');
 assert.ok(!JSON.stringify(impl.appraisalStatus()).includes(f.m.content[0].text));
 assert.equal(fs.readdirSync(join(home,'tidal-state')).some(x=>/^appraisal-[a-f0-9]{64}\.json$/.test(x)),false);
});
test('query-aware relation selection is wired into the actual persisted runtime reader',()=>{
 const d=dossier(),file=join(home,'tidal-state','appraisal-'+core.digest(d.scope)+'.json');fs.writeFileSync(file,JSON.stringify(d));
 const r=impl.readAppraisalReference(home,who,{messageId:'new',query:'以后你怎么称呼我',now});assert.equal(r.关系依据.原话[0].来源,'source-address');
 assert.deepEqual(impl.readAppraisalReference(home,who,{messageId:'new',query:'你说话太机械了',now}),{});
 assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(d));
});
