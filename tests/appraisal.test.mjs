import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
const home=fs.mkdtempSync(join(tmpdir(),'xinghe-appraisal-'));process.env.DSH_HOME=home;
globalThis.fetch=()=>{throw Error('NO_NETWORK')};
const save=(p,x)=>{fs.mkdirSync(join(home,p,'..'),{recursive:true});fs.writeFileSync(join(home,p),JSON.stringify(x));};
save('qq-bridge-config.json',{主人号码:'10001',绑定:[{类型:'私聊',号码:'10001',会话:'session-owner'}]});save('guests.json',{});save('persona.md','FIXTURE');save('.web-token','fixture-token');
save('tidal-state/policy.json',{version:1,enabled:true,allowSelfTune:true,revision:1,params:{},history:[]});save('tidal-state/appraisal-policy.json',{version:1,enabled:true,timeoutMs:8000});
save('feiyu-mood/config.json',{模式:'session',slots:[{id:'main',sessions:['session-owner']}]});save('feiyu-mood/tidal-current.json',{version:1,moods:{main:{}}});
const core=await import('../runtime/srv/dsh-qq-ext/dsh-tidal/appraisal-core.mjs');
const impl=await import('../runtime/srv/dsh-qq-ext/dsh-tidal/appraisal.mjs');
const {projectTidal}=await import('../runtime/srv/dsh-qq-ext/dsh-tidal/runtime.mjs');
const {projectState,compilePacket}=await import('../runtime/srv/dsh-qq-ext/dsh-tidal/core.mjs');
const {apply}=await import('../runtime/srv/dsh-qq-ext/dsh-persona-integrity/reply-health.mjs');
const who={role:'owner',qq:'10001',session:'session-owner'},now=Date.now();
function fixture(text='我们以后说话直接一点就好',id='human-1'){
 const message={id,role:'user',source:{kind:'qq'},content:[{type:'text',text}]};
 const events=[{type:'turn/start',seq:1,time:now,data:{turn:2}},{type:'user/message',seq:2,time:now,data:{message}}];
 const agent={id:who.session,session:{id:who.session,header:{id:who.session},snapshotEvents:()=>events,deriveMessages:()=>[message]}};
 return {message,events,agent,options:{sessionId:who.session,purpose:'agent',provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'max',messages:[message]}};
}
const input=(text='我们以后说话直接一点就好')=>({scope:'owner:10001:session-owner',messageId:'source-1',text,at:now,relationships:[]});
function raw(text='我们以后说话直接一点就好'){return {event:{kind:'boundary',quote:text,meaning:'主人提出持续沟通偏好',confidence:90},reactions:[],relationship:{facet:'communication',quote:text,confidence:95,supersedes:null}};}
function mock(output){const calls=[];return {calls,llm:{async *stream(o){calls.push(o);assert.equal(o.reasoningEffort,'off');assert.equal(o.purpose,'xinghe-event-appraisal');assert.equal(o.sessionId,undefined);assert.deepEqual(o.tools,[]);yield {type:'text-delta',text:typeof output==='string'?output:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}};}}};}

test('appraisal requires current literal evidence and separates inference from observed feeling',()=>{
 const i=input(),r=raw();r.reactions=[{axis:'sad',value:20,confidence:85}];
 const v=core.validateAppraisal(r,i);assert.equal(v.reactions[0].basis,'event_inference_not_observed_feeling');
 assert.equal(core.validateAppraisal({...r,event:{...r.event,quote:'并不存在的原话'}},i),null);
 for(const x of [{axis:'jealous',value:30,confidence:90},{axis:'sad',value:80,confidence:90},{axis:'sad',value:20,confidence:40}])assert.deepEqual(core.validateAppraisal({...r,reactions:[x]},i).reactions,[]);
 assert.deepEqual(core.validateAppraisal({...r,event:{...r.event,kind:'ambiguous'}},i).reactions,[]);
 assert.deepEqual(core.validateAppraisal({...r,reactions:Array(3).fill(r.reactions[0])},i).reactions,[]);
});
test('shared interest and invitations cannot automatically become closeness',()=>{
 for(const kind of ['shared_interest','invitation','practical']){const r=raw();r.event.kind=kind;r.reactions=[{axis:'closeness',value:30,confidence:90}];assert.deepEqual(core.validateAppraisal(r,input()).reactions,[]);}
});
test('quoted hypothetical third-party and uncertain relationship declarations do not persist',()=>{
 for(const text of ['如果我们以后说话直接一点就好','她说我们以后说话直接一点就好','“我们以后说话直接一点就好”','我们以后说话直接一点就好？','开玩笑，我们以后说话直接一点就好'])assert.equal(core.validateAppraisal(raw(text),input(text)).relationship,null);
 const r=raw();r.relationship.confidence=89;assert.equal(core.validateAppraisal(r,input()).relationship,null);
});
test('relationship survives elapsed time, requires explicit replacement, retains old evidence',()=>{
 const i=input(),d=core.emptyDossier(i.scope),r=core.validateAppraisal(raw(),i).relationship;
 assert.equal(core.applyRelationship(d,i,r,now).changed,true);const old=d.relationships[0];
 assert.equal(old.mutualAgreementInferred,false);assert.equal(core.appraisalReference(d,{now:now+30*86400000}).关系依据.原话[0].内容,i.text);
 const text='以后我希望你说话慢一点',next={...input(text),messageId:'source-2',at:now+100};next.relationships=d.relationships;
 const update=raw(text);assert.equal(core.validateAppraisal(update,next).relationship,null);
 update.relationship.supersedes=old.id;const accepted=core.validateAppraisal(update,next).relationship;assert.ok(accepted);
 core.applyRelationship(d,next,accepted,now+100);assert.equal(d.relationships[0].quote,text);assert.equal(d.relationshipHistory[0].quote,i.text);
 const before=JSON.stringify(d);assert.equal(core.applyRelationship(d,next,accepted,now+200).changed,false);assert.equal(JSON.stringify(d),before);
});
test('full relationship history stops replacement without destroying source records',()=>{
 const i=input(),d=core.emptyDossier(i.scope),r=core.validateAppraisal(raw(),i).relationship;core.applyRelationship(d,i,r,now);
 d.relationshipHistory=Array.from({length:32},()=>({...d.relationships[0]}));const before=JSON.stringify(d);
 const outcome=core.applyRelationship(d,{...i,at:now+1},{...r,quote:'以后我希望你说话慢一点',supersedes:d.relationships[0].id},now+1);
 assert.equal(outcome.reason,'history_full');assert.equal(JSON.stringify(d),before);
});
test('source gate rejects tools, public sessions, ambiguous authors, forwarded and stale input',()=>{
 const f=fixture();assert.ok(impl.currentAppraisalInput(f.agent,f.options,who,{now}));
 for(const other of [{...who,role:'group'},{...who,inherited:true},{...who,conflict:true}])assert.equal(impl.currentAppraisalInput(f.agent,f.options,other,{now}),null);
 assert.equal(impl.currentAppraisalInput(f.agent,{...f.options,messages:[...f.options.messages,{role:'tool'}]},who,{now}),null);
 assert.equal(impl.currentAppraisalInput(f.agent,f.options,who,{now:now+11*60000}),null);
 f.events.push({type:'tool/call',seq:3,data:{}});assert.equal(impl.currentAppraisalInput(f.agent,f.options,who,{now}),null);
 const q=fixture('[引用了一条消息]我们以后说话直接一点就好');assert.equal(impl.currentAppraisalInput(q.agent,q.options,who,{now}),null);
 const a=fixture();a.events.push({...a.events[1],seq:3});assert.equal(impl.currentAppraisalInput(a.agent,a.options,who,{now}),null);
});
test('one actual pre-assessment persists evidence and suppresses post-assessment, including repeat requests',async()=>{
 const f=fixture(),ctx=mock(raw());
 await Promise.all([impl.prepareAppraisal(ctx,f.agent,f.options,{home,now}),impl.prepareAppraisal(ctx,f.agent,f.options,{home,now})]);
 assert.equal(ctx.calls.length,1);assert.equal(impl.readDossier(home,who).relationships.length,1);
 assert.equal(impl.replacesPostAssessment(home,who,{provenance:{messageId:f.message.id}}),true);
 const again=await impl.prepareAppraisal(ctx,f.agent,f.options,{home,now});assert.equal(again.status,'cached');assert.equal(ctx.calls.length,1);
 const rendered=projectTidal([f.message],f.agent,{now});const text=rendered.messages.map(m=>m.content?.[0]?.text||'').join('\n');
 assert.match(text,/当下来意/);assert.match(text,/关系依据/);assert.ok(rendered.receipt.tidal.characters<=1200);
});
test('invalid assessment degrades to ordinary chat and does not consume another assessment',async()=>{
 const f=fixture('我开完会了','invalid-source'),ctx=mock('invalid');const out=await impl.prepareAppraisal(ctx,f.agent,f.options,{home,now});
 assert.equal(out.status,'failed');assert.equal(ctx.calls.length,1);assert.equal(impl.replacesPostAssessment(home,who,{provenance:{messageId:f.message.id}}),true);
 assert.equal(impl.readAppraisalReference(home,who,{messageId:f.message.id,now}).当下来意,undefined);
 await impl.prepareAppraisal(ctx,f.agent,f.options,{home,now});assert.equal(ctx.calls.length,1);
});
test('provider failure and incomplete streams are retained as failed, never fabricated feelings',async()=>{
 for(const [id,stream] of [['provider',async function*(){throw Error('failure')}],['incomplete',async function*(){yield {type:'text-delta',text:JSON.stringify(raw())}}]]){
  const f=fixture(undefined,id);const r=await impl.prepareAppraisal({llm:{stream}},f.agent,f.options,{home,now});assert.equal(r.status,'failed');assert.equal(impl.replacesPostAssessment(home,who,{provenance:{messageId:id}}),true);
 }
});
test('cancellation cannot install inferred states or relationship edits',async()=>{
 const f=fixture('以后叫我新的昵称','cancelled-source'),controller=new AbortController();f.options.signal=controller.signal;
 const before=JSON.stringify(impl.readDossier(home,who).relationships);const ctx={llm:{async *stream(){controller.abort();yield {type:'text-delta',text:JSON.stringify(raw(f.message.content[0].text))};yield {type:'finish',reason:{kind:'stop'}}}}};
 await assert.rejects(()=>impl.prepareAppraisal(ctx,f.agent,f.options,{home,now}));assert.equal(JSON.stringify(impl.readDossier(home,who).relationships),before);
});
test('timeout is bounded and the next turn is not blocked by the failed evaluator',async()=>{
 const f=fixture('现在聊点别的','timeout-source'),ctx={llm:{async *stream(o){await new Promise(resolve=>o.signal.addEventListener('abort',resolve,{once:true}));}}};
 const start=Date.now(),r=await impl.prepareAppraisal(ctx,f.agent,f.options,{home,now:Date.now()});assert.equal(r.reason,'timeout');assert.ok(Date.now()-start<9000);assert.ok(Date.now()-start>=7900);
 const next=fixture('今天晚饭吃了饭团','after-timeout');const out=await impl.prepareAppraisal(mock(raw(next.message.content[0].text)),next.agent,next.options,{home,now:Date.now()});assert.equal(out.status,'ready');
});
test('current failed/unknown input never receives unrelated previous inferred emotion',()=>{
 const d=core.emptyDossier('owner:test');d.receipts.push({messageId:'previous',at:now,status:'ready',result:{event:{quote:'我喜欢你'},reactions:[{axis:'sweet',value:30,confidence:90}]}});
 assert.equal(core.appraisalReference(d,{messageId:'new-topic',now:now+100}).前事余留,undefined);
 assert.ok(core.appraisalReference(d,{now:now+100}).前事余留);assert.equal(core.appraisalReference(d,{now:now+5*3600000}).前事余留,undefined);
});
test('actual frozen production request waits for appraisal, passes a detached projected request and retains max',async()=>{
 const f=fixture('我们可以一起看电影','hook-input'),listeners=new Map(),calls=[];const ctx={agents:{get:()=>f.agent},effect:fn=>fn(),on:(n,fn)=>listeners.set(n,fn),logger:{warn:()=>{}},webServer:{register:()=>()=>{}},llm:{}};
 ctx.llm.stream=options=>{
  calls.push(options);
  const terminal=async function*(){if(options.purpose==='xinghe-event-appraisal'){yield {type:'text-delta',text:JSON.stringify({...raw(f.message.content[0].text),relationship:null})};yield {type:'finish',reason:{kind:'stop'}};}else yield {type:'text-delta',text:'普通回复'};};
  return listeners.get('llm/stream')(options,()=>terminal());
 };
 apply(ctx);const frozen=Object.freeze({...f.options,messages:Object.freeze([Object.freeze(f.message)])});
 let text='';for await(const c of ctx.llm.stream(frozen))if(c.type==='text-delta')text+=c.text;
 assert.equal(text,'普通回复');assert.equal(calls.filter(c=>c.purpose==='xinghe-event-appraisal').length,1);
 const actual=calls.find(c=>c.purpose==='paopao-context-projected');assert.equal(actual.reasoningEffort,'max');assert.equal(actual.messages.at(-1),f.message);assert.match(actual.messages.find(m=>m.source?.kind==='paopao-tidal-reference').content[0].text,/当下来意/);
 assert.equal(frozen.messages.length,1);assert.equal(impl.replacesPostAssessment(home,who,{provenance:{messageId:f.message.id}}),true);
});
test('packet includes source-bearing relationships within the shared 1200 character budget',()=>{
 const state=projectState({scope:who,now});const data={关系依据:{原话:Array.from({length:2},()=>({内容:'关系原话'.repeat(35),来源:'source'}))},当下来意:{原话:'当前事件'.repeat(30),理解:'语境解释'},可能反应:[{倾向:'开心',强度:20}]};
 const p=compilePacket({state,appraisal:data,memories:[{quote:'历史原话',sourceMessageId:'history-source',sourceTime:now}]});assert.ok(p.text.length<=1200);assert.match(p.text,/关系依据/);assert.match(p.text,/history-source/);
});
test('repeating the same event with a new message id does not reinforce affect or relation',async()=>{
 const text='我们一起看视频挺开心的',output={...raw(text),event:{kind:'shared_interest',quote:text,meaning:'共同兴趣',confidence:90},reactions:[{axis:'happy',value:30,confidence:90}],relationship:null};
 for(const id of ['repeat-one','repeat-two']){const f=fixture(text,id);await impl.prepareAppraisal(mock(output),f.agent,f.options,{home,now});}
 const d=impl.readDossier(home,who);assert.equal(d.receipts.find(r=>r.messageId==='repeat-one').result.reactions.length,1);assert.equal(d.receipts.find(r=>r.messageId==='repeat-two').result.reactions.length,0);
});
test('bounded opt-in probe never writes state and unknown cases cannot run arbitrary prompts',async()=>{
 const {runAppraisalProbe}=await import('../runtime/srv/dsh-qq-ext/dsh-tidal/appraisal-probe.mjs');
 const before=JSON.stringify(impl.readDossier(home,who));let calls=0;
 const ctx={llm:{async *stream(o){calls++;assert.equal(o.purpose,'xinghe-appraisal-probe');const text=JSON.parse(o.messages[0].content[0].text).current.text;yield {type:'text-delta',text:JSON.stringify({...raw(text),event:{kind:'ambiguous',quote:text,meaning:'讨论引文',confidence:90},relationship:null})};yield {type:'finish',reason:{kind:'stop'}};}}};
 const r=await runAppraisalProbe(ctx,'quoted',AbortSignal.timeout(1000));assert.equal(r.passed,true);assert.equal(r.stateWrites,0);assert.equal(r.QQSends,0);assert.equal(JSON.stringify(impl.readDossier(home,who)),before);
 await assert.rejects(()=>runAppraisalProbe(ctx,'constructor'));assert.equal(calls,1);
});
test('feature disable restores old assessment eligibility without deleting newly learned evidence',async()=>{
 const before=JSON.stringify(impl.readDossier(home,who));save('tidal-state/appraisal-policy.json',{version:1,enabled:false,timeoutMs:8000});
 try{
  assert.equal(impl.replacesPostAssessment(home,who,{provenance:{messageId:'human-1'}}),false);
  const ctx=mock(raw()),f=fixture();assert.equal((await impl.prepareAppraisal(ctx,f.agent,f.options,{home,now})).status,'disabled');assert.equal(ctx.calls.length,0);
  assert.deepEqual(impl.readAppraisalReference(home,who,{messageId:f.message.id,now}),{});assert.equal(JSON.stringify(impl.readDossier(home,who)),before);
 }finally{save('tidal-state/appraisal-policy.json',{version:1,enabled:true,timeoutMs:8000});}
});
test('relationship reads neither reinforce evidence nor expose private state to group/inherited scopes',()=>{
 const before=JSON.stringify(impl.readDossier(home,who));
 for(let i=0;i<4;i++)impl.readAppraisalReference(home,who,{now:now+i*86400000});
 assert.equal(JSON.stringify(impl.readDossier(home,who)),before);
 for(const other of [{...who,role:'group'},{...who,inherited:true},{...who,conflict:true}]){assert.throws(()=>impl.readDossier(home,other));assert.deepEqual(impl.readAppraisalReference(home,other,{now}),{});}
});
test('unrecognized event category degrades to unknown without losing independently valid relation evidence',()=>{
 const r=raw();r.event.kind='unexpected_category';r.reactions=[{axis:'sad',value:30,confidence:95}];
 const v=core.validateAppraisal(r,input());assert.equal(v.event.kind,'ambiguous');assert.deepEqual(v.reactions,[]);assert.equal(v.relationship.quote,input().text);
 r.relationship.confidence=88;assert.equal(core.validateAppraisal(r,input()).relationship,null);
 r.event.kind='communication';assert.equal(core.validateAppraisal(r,input()).event.kind,'communication');
 r.event.quote='不存在的来源';assert.equal(core.validateAppraisal(r,input()),null);
});
test('style complaints preserve the prior anti-self-analysis behavior and do not generate hurt cues',async()=>{
 const text='你这句说话很机械，像在背模板',f=fixture(text,'style-complaint');
 const out={event:{kind:'criticism',quote:text,meaning:'主人指出表达不自然',confidence:95},reactions:[{axis:'sad',value:30,confidence:95}],relationship:null};
 await impl.prepareAppraisal(mock(out),f.agent,f.options,{home,now});
 assert.deepEqual(impl.readDossier(home,who).receipts.find(r=>r.messageId===f.message.id).result.reactions,[]);
 assert.deepEqual(impl.readAppraisalReference(home,who,{messageId:f.message.id,query:text,now}),{});
 assert.deepEqual(impl.readAppraisalReference(home,who,{messageId:f.message.id,query:'新的系统上线，你感觉怎么样',now}),{});
});
