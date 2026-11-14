import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const home=fs.mkdtempSync(join(tmpdir(),'xinghe-growth-'));process.env.DSH_HOME=home;
globalThis.fetch=()=>{throw Error('NO_NETWORK')};
const root='../runtime/srv/dsh-qq-ext/';
const {observeExpressionFeedback,collectExchanges,expressionLibrary,selectExpressions,renderExpressions}=await import(root+'dsh-long-memory/lib/expression-library.mjs');
const {learningProgress,selectQuality}=await import(root+'dsh-long-memory/lib/expression-quality.mjs');
const {feedbackWindow,installExpressionLearning,learningStatus}=await import(root+'dsh-long-memory/lib/expression-observer.mjs');
const {projectTidal}=await import(root+'dsh-tidal/runtime.mjs');
const session='session-growth',qq='10001',now=Date.now(),day=86400000;
const hash=s=>createHash('sha256').update(s).digest('hex');
const file=join(home,'expression-library',hash('owner:'+qq)+'.json');
const save=(p,v)=>{fs.mkdirSync(join(home,p,'..'),{recursive:true});fs.writeFileSync(join(home,p),JSON.stringify(v))};
save('qq-bridge-config.json',{主人号码:qq,绑定:[{类型:'私聊',号码:qq,会话:session}]});save('guests.json',{});
save('tidal-state/policy.json',{version:1,enabled:true,allowSelfTune:true,revision:1,params:{},history:[]});
save('feiyu-mood/config.json',{模式:'session',slots:[{id:'main',sessions:[session]}]});save('feiyu-mood/tidal-current.json',{version:1,moods:{main:{}}});
const msg=(role,text,id,kind=role==='user'?'qq':'model')=>({role,id,source:{kind},content:[{type:'text',text}]});
function fixture(feedback='刚才那句很自然，我很喜欢',suffix='a',at=now){
 const events=[
  {seq:1,type:'turn/start',time:at-40000,data:{turn:11}},
  {seq:2,type:'user/message',time:at-39000,data:msg('user','下班到家啦','u-'+suffix)},
  {seq:3,type:'assistant/message',time:at-38000,data:{turn:11,message:msg('assistant','拖鞋又踢哪儿去了，怎么还光着脚呀。','a-'+suffix)}},
  {seq:4,type:'turn/end',time:at-37000,data:{turn:11,reason:{kind:'completed'}}},
  {seq:5,type:'turn/start',time:at-1000,data:{turn:12}},
  {seq:6,type:'user/message',time:at,data:msg('user',feedback,'feedback-'+suffix)}];
 return {events,agent:{id:session,session:{header:{id:session},snapshotEvents:()=>events}}};
}
const reset=()=>{fs.mkdirSync(join(home,'expression-library'),{recursive:true});fs.writeFileSync(file,JSON.stringify({version:1,owner:qq,revision:0,entries:[]}))};
const store=()=>JSON.parse(fs.readFileSync(file));
const material=(suffix='a',at=now)=>{const f=fixture(undefined,suffix,at),w=feedbackWindow(f.events,session,{now:at});return collectExchanges([...w.previous,w.feedback],session)[0]};

test('explicit adjacent approval captures real context automatically once, without a model call',()=>{
 reset();const f=fixture(),before=JSON.stringify(f.events);
 const result=observeExpressionFeedback(f.agent,{now});assert.equal(result.saved,true);assert.equal(store().entries.length,1);
 const entry=store().entries[0];assert.equal(entry.status,'active');assert.equal(entry.adoption.by,'owner_feedback');assert.equal(learningProgress(entry).stage,'situational');
 assert.equal(entry.examples[0].approval.messageId,'feedback-a');assert.equal(entry.examples[0].records[1].text,'拖鞋又踢哪儿去了，怎么还光着脚呀。');
 const bytes=fs.readFileSync(file);assert.equal(observeExpressionFeedback(f.agent,{now}).saved,false);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(JSON.stringify(f.events),before);
});
test('ordinary affection, laughter, silence and ambiguous or negated praise are never inferred approval',()=>{
 for(const text of ['哈哈哈哈','我爱你','挺好的','嗯嗯','这句不自然，我不喜欢','刚才那句可真自然，像机器人一样','刚才那句很好听，骗你的','不是刚才那句，我喜欢的是以前那个','昨天那句很好听','朋友说“刚才那句很自然”']){
  reset();const result=observeExpressionFeedback(fixture(text).agent,{now});assert.equal(store().entries.length,0,text);assert.notEqual(result.saved,true,text);
 }
});
test('only completed plain adjacent owner dialogue with valid time is learned',()=>{
 const variants=[events=>{events[3].data.reason.kind='cancelled'},events=>{events[2].data.interrupted=true},events=>{events[1].data.source.kind='speak-up'},events=>{events[5].data.source.kind='speak-up'},events=>{events[1].data.content.push({type:'image'})},events=>{events[1].data.content[0].text='[合并转发的聊天记录]\n下班到家'},events=>{events[2].type='tool/call'},events=>{events[5].time=now+1},events=>{events[0].time=events[1].time=events[2].time=now-11*60000}];
 for(const change of variants){reset();const f=fixture();change(f.events);observeExpressionFeedback(f.agent,{now});assert.equal(store().entries.length,0);}
 reset();const f=fixture();assert.equal(observeExpressionFeedback({...f.agent,id:'session-other',session:{...f.agent.session,header:{id:'session-other'}}},{now}).observed,false);
});
test('no feedback means no store reads or writes, including disabled learning',()=>{
 reset();fs.writeFileSync(file,'INVALID_STORE');const f=fixture('中午吃什么');assert.equal(observeExpressionFeedback(f.agent,{now}).observed,false);assert.equal(fs.readFileSync(file,'utf8'),'INVALID_STORE');
 save('tidal-state/policy.json',{version:1,enabled:false,revision:1,params:{},history:[]});assert.equal(observeExpressionFeedback(fixture().agent,{now}).observed,false);save('tidal-state/policy.json',{version:1,enabled:true,allowSelfTune:true,revision:1,params:{},history:[]});reset();
});
test('one owner approval stays close-topic; two independent days may support the same scene',()=>{
 const first=material('one',now-day),second=material('two',now);
 second.records[0].text='下班吃晚饭啦';second.records[1].text='先吃，锅里那口热的还给你留着。';
 const entry={id:'growth',status:'active',scene:'daily',updatedAt:now,examples:[first],adoption:{by:'owner_feedback'}};
 assert.equal(selectQuality([entry],'出门散步啦',session,{now}).length,0);
 assert.equal(selectQuality([entry],'下班到家啦',session,{now}).length,1);
 entry.examples.push(second);assert.equal(learningProgress(entry,{now}).stage,'established');assert.equal(selectQuality([entry],'出门散步啦',session,{now}).length,1);
 assert.equal(selectQuality([entry],'介绍一下量子力学原理',session,{now}).length,0);
 assert.equal(selectQuality([entry],'我好难过',session,{now}).length,0);
});
test('duplicate sources, same-day approvals, future evidence and reads cannot manufacture growth',()=>{
 const first=material('one',now-day),e={status:'active',scene:'daily',updatedAt:now,examples:[first,structuredClone(first)],adoption:{by:'owner_feedback'}};
 assert.equal(learningProgress(e,{now}).independentApprovals,1);
 e.examples[1]=material('other',now-day+1000);assert.equal(learningProgress(e,{now}).stage,'situational');
 e.examples[1].at=now+day;assert.equal(learningProgress(e,{now}).independentApprovals,1);
 const before=JSON.stringify(e);for(let i=0;i<4;i++)selectQuality([e],'下班到家啦',session,{now});assert.equal(JSON.stringify(e),before);
});
test('paopao may adopt one verified example provisionally without inventing owner approval',async()=>{
 reset();const f=fixture(),ex=material();delete ex.approval;
 const entry={id:'personal',status:'candidate',scene:'daily',lesson:'喜欢这段轻松的说法',revision:1,createdAt:now,updatedAt:now,examples:[ex],adoption:null};
 fs.writeFileSync(file,JSON.stringify({version:1,owner:qq,revision:0,entries:[entry]}));
 const result=await expressionLibrary(f.agent,{action:'activate',id:'personal',revision:1,reason:'想先在类似聊天里试试'});
 assert.equal(result.saved,true);const adopted=store().entries[0];assert.equal(learningProgress(adopted).stage,'self_selected');assert.equal(adopted.adoption.userApproval,'not_inferred');
 const out=selectExpressions([adopted],'下班到家啦',session,{now:Date.now()});assert.equal(out.length,1);assert.equal(out[0].basis,'paopao_choice_not_owner_approval');
 assert.equal(selectExpressions([adopted],'出门散步啦',session,{now:Date.now()}).length,0);
});
test('explicit rejection removes a saved or repeated exact expression from automatic use, preserving source',()=>{
 reset();const ex=material();const e={id:'old',status:'active',scene:'daily',lesson:'',revision:1,createdAt:now,updatedAt:now,examples:[ex],adoption:{by:'owner_feedback'}};
 fs.writeFileSync(file,JSON.stringify({version:1,owner:qq,revision:1,entries:[e]}));
 const f=fixture('刚才那句很机械，我不喜欢','repeated');
 const before=e.examples[0].records[1].text;assert.equal(observeExpressionFeedback(f.agent,{now}).saved,true);
 const updated=store().entries[0];assert.equal(updated.examples[0].records[1].text,before);assert.equal(updated.examples[0].rejection.messageId,'feedback-repeated');assert.equal(selectExpressions([updated],'下班到家啦',session,{now}).length,0);
 assert.equal(observeExpressionFeedback(f.agent,{now}).saved,false);
});
test('retired entries, wrong-session material and filled storage are not silently replaced',()=>{
 reset();const e={id:'retired',status:'retired',scene:'daily',lesson:'',revision:1,createdAt:now,updatedAt:now,examples:[material()]};
 fs.writeFileSync(file,JSON.stringify({version:1,owner:qq,revision:1,entries:[e]}));const before=fs.readFileSync(file);assert.equal(observeExpressionFeedback(fixture().agent,{now}).saved,false);assert.deepEqual(fs.readFileSync(file),before);
 assert.equal(selectQuality([{...e,status:'active'}],'下班到家啦','session-other',{now}).length,0);
 const full=Array.from({length:120},(_,i)=>({...e,id:'full'+i,examples:[{...material(),id:'x'+i,records:material().records.map(r=>({...r,messageId:r.messageId+i,text:r.text+i}))}]}));
 fs.writeFileSync(file,JSON.stringify({version:1,owner:qq,revision:1,entries:full}));assert.equal(observeExpressionFeedback(fixture().agent,{now}).status,'capacity');assert.equal(store().entries.length,120);
});
test('actual stream middleware learns once and leaves request, stream and group traffic intact',()=>{
 reset();const f=fixture();let listener,calls=0;
 const ctx={agents:{get:id=>id===session?f.agent:null},on:(name,fn)=>{assert.equal(name,'llm/stream');listener=fn;}};
 installExpressionLearning(ctx,observeExpressionFeedback);
 const options=Object.freeze({sessionId:session,purpose:'agent'}),stream={fixture:true};
 assert.equal(listener(options,()=>{calls++;return stream}),stream);
 assert.equal(listener({...options,purpose:'paopao-context-projected'},()=>{calls++;return stream}),stream);assert.equal(store().entries.length,1);
 listener({sessionId:session,purpose:'background'},()=>{calls++;return stream});assert.equal(calls,3);assert.equal(learningStatus().modelCallsAdded,0);
});
test('learned example reaches a bounded real request and leaves recent repeats out',()=>{
 reset();const f=fixture();observeExpressionFeedback(f.agent,{now});
 const current=msg('user','下班到家啦','new-current');const agent={...f.agent,session:{...f.agent.session,snapshotEvents:()=>[{type:'user/message',data:current}]}};
 const ref=renderExpressions(agent,{projection:true});assert.match(ref,/拖鞋/);assert.match(ref,/explicit_owner_approval/);
 const projected=projectTidal([current],agent,{now:Date.now(),who:{role:'owner',qq,session}});const packet=projected.messages.find(m=>m.source?.kind==='paopao-tidal-reference')?.content[0].text;assert.ok(packet?.includes('拖鞋'));assert.ok(packet.length<=1200);
 const recent=[msg('user','下班到家啦','u'),msg('assistant','拖鞋又踢哪儿去了，怎么还光着脚呀。','r'),current];
 assert.equal(projectTidal(recent,agent,{now:Date.now(),who:{role:'owner',qq,session}}).messages.some(m=>m.source?.kind==='paopao-tidal-reference'),false);
});
test('production long-memory plugin actually installs the observer and advertises the new policy',async()=>{
 reset();const f=fixture(),listeners=new Map(),routes=new Map(),registered=[];
 const ctx={agents:{get:id=>id===session?f.agent:null},systemPrompt:{context:()=>{},assemble:async()=>({sections:[],contexts:[],tools:[]})},tools:{guard:()=>{},register:spec=>registered.push(spec)},webServer:{register:r=>{routes.set(r.path,r.handler);return ()=>{}}},effect:fn=>fn(),on:(name,fn)=>{listeners.set(name,fn);return ()=>{}}};
 const {apply}=await import('../runtime/srv/dsh-qq-ext/dsh-long-memory/lib/index.js');apply(ctx);
 assert.ok(listeners.has('llm/stream'));assert.ok(registered.length>0);
 const result={fixture:true};assert.equal(listeners.get('llm/stream')({sessionId:session,purpose:'agent'},()=>result),result);assert.equal(store().entries.length,1);
 let body;await routes.get('/dsh-long-memory/state')({}, {writeHead:()=>{},end:text=>body=JSON.parse(text)});
 assert.equal(body.expressionLibrary.policy,'owner-expression-examples-v4');assert.equal(body.expressionLibrary.automaticExplicitFeedback,true);
 listeners.get('dispose')?.();
});
