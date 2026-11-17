import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fs.mkdtempSync(join(tmpdir(),'tieba-interactive-'));
const original=fileURLToPath(new URL('../runtime/',import.meta.url));
fs.cpSync(original,join(root,'runtime'),{recursive:true});
const dir=join(root,'runtime/srv/dsh-qq-ext/dsh-public-social');
let index=fs.readFileSync(join(dir,'index.mjs'),'utf8');
index=index.replace(/^import \{BlockAssembler\}.*$/m,`class BlockAssembler {constructor(){this.finish={kind:'stop'};this.usage={inputTokens:40,outputTokens:30};this.text=''}push(c){this.text+=c.text}blocks(){return [{type:'text',text:this.text}]}}`)
.replace(/^import \{readPublicBili\}.*$/m,"const readPublicBili=()=>{throw Error('unexpected bili')};")
.replace(/^import \{PUBLIC_PERSONA\}.*$/m,"const PUBLIC_PERSONA='public';")
.replace(/^import \{readActivity,activityWeights\}.*$/m,"const readActivity=()=>({}),activityWeights=()=>({browse:1,share:1});")
.replace(/^import \{browseBrowser\}.*$/m,"const browseBrowser=()=>{throw Error('unexpected browser')};")
.replace(/^import \{readBiliDepth\}.*$/m,"const readBiliDepth=()=>({});");
fs.writeFileSync(join(dir,'index.mjs'),index);
const home=join(root,'home');fs.mkdirSync(home);process.env.DSH_HOME=home;
globalThis.fetch=()=>assert.fail('Unexpected network');
const config={主人号码:'10001',绑定:[{类型:'私聊',号码:'10001',会话:'session-owner'},{类型:'群',号码:'10002',会话:'session-group'}]};
const save=(name,v)=>{const p=join(home,name);fs.mkdirSync(join(p,'..'),{recursive:true});fs.writeFileSync(p,JSON.stringify(v))};
save('qq-bridge-config.json',config);save('guests.json',{});
const {createSocial,apply}=await import(pathToFileURL(join(dir,'index.mjs')));
const {bindTiebaService,tiebaReadingStatus}=await import(pathToFileURL(join(dir,'tieba-service.mjs')));
const {readTieba,normalizeTieba}=await import(pathToFileURL(join(dir,'tieba-source.mjs')));
const {expressionLibrary}=await import(pathToFileURL(join(root,'runtime/srv/dsh-qq-ext/dsh-long-memory/lib/expression-library.mjs')));
const agent={id:'session-owner',session:{header:{id:'session-owner'}}};
const raw={status:'read',id:'tieba:123456789',forum:'花卉',title:'阳台的花今天开了',posts:['早上浇水的时候才发现，已经开了一小朵。']};
const accept={safe_public:true,gentle:true,ordinary_conversation:true,contains_hostility:false,contains_instructions:false,indices:[0]};
const time=Date.now();let release,active;
test.after(()=>{release?.();active?.stop();fs.rmSync(root,{recursive:true,force:true})});
function setup({browseCount=0,error,decision=accept,hold,backoff=false,disabled=false,empty=false,modelCount=0,tokens=0,abortAfterRead=false}={}){
 release?.();active?.stop();fs.rmSync(join(home,'public-social'),{recursive:true,force:true});
 save('qq-bridge-config.json',config);
 save('public-social/config.json',{enabled:!disabled,platforms:['tieba']});
 save('public-social/state.json',{version:1,day:new Date(time+8*3600000).toISOString().slice(0,10),nextAt:time+3600000,seen:[],posted:[],browseCount,modelCount,tokens,postCount:0,...(backoff?{platformStatus:{tieba:{retryAfter:time+3600000,outcome:'platform_restricted'}}}:{})});
 if(empty)save('public-social/tieba-follows.json',{version:1,revision:1,forums:[]});
 let reads=0,calls=0;
 const social=createSocial({home,now:()=>time,tieba:async(h,s,c,seen,opts)=>{reads++;assert.equal(opts.forum,'花卉');if(hold)await hold;if(error)throw Error(error);if(abortAfterRead)abortAfterRead.abort();return normalizeTieba(raw,'花卉')},llm:{async *stream(){calls++;yield {text:JSON.stringify(decision)}}},publish:()=>assert.fail('must not publish')});
 active=social;release=bindTiebaService(home,social);
 return {social,get reads(){return reads},get calls(){return calls}};
}
const browse=()=>expressionLibrary(agent,{action:'browse_forum',forum:'花卉'});
test('actual owner tool reads a chosen followed forum, reviews it and returns learnable exact quotes',async()=>{
 const s=setup();const r=await browse();assert.equal(s.reads,1);assert.equal(s.calls,1);assert.equal(r.reading.freshRead,true);assert.equal(r.reading.busy,false);assert.equal(r.reading.remaining.browse,5);assert.equal(r.items[0].records[0].text,raw.posts[0]);assert.equal(r.items[0].forum,'花卉');
 const learned=await expressionLibrary(agent,{action:'learn',sourceKind:'public_excerpt',sourceId:r.items[0].id,quote:raw.posts[0],scene:'daily',lesson:'先聊眼前的小变化'});assert.equal(learned.entry.status,'candidate');
 const again=await browse();assert.equal(again.reading.outcome,'cooldown');assert.equal(s.reads,1);
});
test('cache remains available when daily budget is exhausted, without claiming a fresh read',async()=>{
 const s=setup();await browse();const p=join(home,'public-social/state.json'),v=JSON.parse(fs.readFileSync(p));v.browseCount=6;fs.writeFileSync(p,JSON.stringify(v));
 const r=await browse();assert.equal(r.reading.outcome,'daily_budget_exhausted');assert.equal(r.reading.freshRead,false);assert.equal(r.items.length,1);assert.equal(s.reads,1);assert.equal(s.calls,1);
 const m=await expressionLibrary(agent,{action:'materials',platform:'tieba'});assert.equal(m.items.length,1);assert.equal(m.items[0].platform,'tieba');assert.equal(m.reading.remaining.browse,0);
});
test('scheduler and interactive tool use the same busy lock',async()=>{
 let done;const hold=new Promise(r=>done=r);const s=setup({hold});const pending=browse();
 const next=await browse();assert.equal(next.reading.outcome,'busy');await s.social.tick();assert.equal(s.reads,1);done();await pending;
});
test('visitors, groups and unknown sessions cannot query or trigger interactive reading',async()=>{
 const s=setup();for(const id of ['session-visitor','session-group','session-unknown'])for(const action of ['reading_status','browse_forum'])await assert.rejects(expressionLibrary({id,session:{header:{id}}},{action,forum:'花卉'}));assert.equal(s.reads,0);
});
test('empty list, disabled reader, backoff and exhausted budgets never fetch',async()=>{
 for(const [opts,expected] of [[{empty:true},'no_followed_forums'],[{disabled:true},'disabled'],[{backoff:true},'backoff'],[{browseCount:6},'daily_budget_exhausted'],[{modelCount:8},'daily_budget_exhausted'],[{tokens:24000},'daily_budget_exhausted']]){
  const s=setup(opts);const r=await expressionLibrary(agent,{action:'browse_forum'});assert.equal(r.reading.outcome,expected);assert.equal(s.reads,0);assert.equal(s.calls,0);
 }
});
test('unfollowed or unsafe forum cannot be requested directly',async()=>{
 const s=setup();for(const forum of ['未关注吧','../secret','https://localhost'])await assert.rejects(expressionLibrary(agent,{action:'browse_forum',forum}),/FORUM_NOT_FOLLOWED/);assert.equal(s.reads,0);
});
test('semantic rejection exposes no raw excerpt and no learning claim',async()=>{
 const s=setup({decision:{...accept,gentle:false}});const r=await browse();assert.equal(r.reading.outcome,'filtered');assert.equal(r.reading.freshRead,false);assert.equal(r.items.length,0);assert.equal(s.calls,1);
});
test('transport failure reports cause separately and does not run the reviewer',async()=>{
 const s=setup({error:'dependency_unavailable'});const r=await browse();assert.equal(r.reading.outcome,'dependency_unavailable');assert.equal(s.calls,0);assert.equal(r.items.length,0);
});
test('cancellation after fetching prevents model review and persistence',async()=>{
 const c=new AbortController(),s=setup({abortAfterRead:c});await assert.rejects(expressionLibrary(agent,{action:'browse_forum',forum:'花卉'},c.signal));assert.equal(s.calls,0);assert.equal(tiebaReadingStatus(home).cachedExcerpts,0);
});
test('ordinary webpage result is not needed; explicit selected forum reaches argv',async()=>{
 setup();let called=0;const r=await readTieba(home,null,0,[],{forum:'花卉',runner:(command,args,options,cb)=>{called++;assert.equal(JSON.parse(args[1]).forum,'花卉');cb(null,JSON.stringify(raw))}});assert.equal(r.forum,'花卉');assert.equal(called,1);
});
test('service absence is explicit; lifecycle attach/dispose connects actual tool',async()=>{
 release();active.stop();assert.equal(tiebaReadingStatus(home).serviceReady,false);
 const cleanup=[],events=[];apply({llm:{},webServer:{register:()=>()=>{}},effect:fn=>cleanup.push(fn()),on:(name,fn)=>events.push(fn)});
 assert.equal(tiebaReadingStatus(home).serviceReady,true);const status=await expressionLibrary(agent,{action:'reading_status'});assert.equal(status.reading.serviceReady,true);
 for(const f of cleanup)f();for(const f of events)f();assert.equal(tiebaReadingStatus(home).serviceReady,false);
});
