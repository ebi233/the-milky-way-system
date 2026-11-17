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

const {archiveCard,corpusStats,corpusMaterials}=await import(pathToFileURL(join(dir,'tieba-corpus.mjs')));
const {recordCard,history}=await import(pathToFileURL(join(dir,'browse-history.mjs')));
const {approvedTieba}=await import(pathToFileURL(join(dir,'tieba-source.mjs')));
const unlimited=()=>save('public-social/config.json',{enabled:true,platforms:['tieba'],continuousLearning:true,browseDailyLimit:null,modelDailyLimit:null,tokenDailyLimit:null});
test('null daily quotas permit a real reviewed read after all old limits were exceeded',async()=>{
 const s=setup({browseCount:600,modelCount:800,tokens:2400000});unlimited();
 const r=await browse();assert.equal(r.reading.freshRead,true);assert.deepEqual(r.reading.remaining,{browse:null,modelCalls:null,tokens:null});assert.equal(r.reading.dailyQuotas,false);assert.equal(s.calls,1);
 assert.equal(s.social.status().browseToday,601);assert.equal(s.social.status().modelCallsToday,801);assert.ok(s.social.status().accountedTokensToday>2400000);
});
test('continuous worker advances slots and listing pages, rotating forums without daily caps',async()=>{
 setup();unlimited();let clock=time;const visits=[];
 const s=createSocial({home,now:()=>clock,tieba:async(h,signal,c,seen,opts)=>{visits.push(opts);throw Error('filtered')},llm:{},publish:()=>assert.fail('publish')});
 for(let i=0;i<9;i++){await s.tickLearning();clock+=60001;}
 assert.equal(visits.length,36);assert.deepEqual(visits.slice(0,3).map(x=>x.forum),['多肉','花卉','烘焙']);assert.ok(visits.some(x=>x.page===2));assert.equal(s.status().browseToday,36);s.stop();
});
test('one restricted forum backs off while other forums continue',async()=>{
 setup();unlimited();const visits=[];
 const s=createSocial({home,now:()=>time,tieba:async(h,signal,c,seen,opts)=>{visits.push(opts.forum);throw Error(opts.forum==='多肉'?'platform_restricted':'filtered')},llm:{}});
 await s.tickLearning();assert.equal(visits.filter(x=>x==='多肉').length,1);assert.equal(visits.length,4);assert.ok(s.readingStatus().forumProgress['多肉'].retryAfter>time);assert.equal(s.readingStatus().retryAfter, null);s.stop();
});
test('empty later listing returns to recent posts with backoff rather than looping on an empty page',async()=>{
 setup();unlimited();const s=createSocial({home,now:()=>time,tieba:async()=>{throw Error('listing_empty')},llm:{}});
 await s.tickLearning();for(const p of Object.values(s.readingStatus().forumProgress)){assert.equal(p.page,1);assert.equal(p.offset,0);assert.ok(p.retryAfter>time)}s.stop();
});
test('continuous scheduler and owner request share one lock; stopping prevents review',async()=>{
 setup();unlimited();let done;const wait=new Promise(r=>done=r);let calls=0;
 const s=createSocial({home,now:()=>time,tieba:async()=>{await wait;return normalizeTieba(raw,'花卉')},llm:{async *stream(){calls++;yield {text:JSON.stringify(accept)}}}});
 const pending=s.tickLearning();assert.equal((await s.readNow({forum:'花卉'})).outcome,'busy');s.stop();done();await pending;assert.equal(calls,0);assert.equal(corpusStats(home).threads,0);
});
test('reviewed corpus survives cache eviction and a week, is deduplicated, and old quotes remain learnable',async()=>{
 setup();const now=Date.now()-8*86400000;let first;
 for(let i=0;i<85;i++){
  const card={...approvedTieba(normalizeTieba({...raw,id:'tieba:'+(123456789+i)},'花卉'),accept),at:now+i};
  archiveCard(home,card);archiveCard(home,card);recordCard(home,card,{},card.at);if(i===0)first=corpusMaterials(home)[0];
 }
 assert.equal(history(home).items.length,80);assert.deepEqual(corpusStats(home),{threads:85,excerpts:85});
 const result=await expressionLibrary(agent,{action:'learn',sourceKind:'public_excerpt',sourceId:first.id,quote:first.records[0].text,scene:'daily',lesson:'留意眼前的小变化'});assert.equal(result.entry.status,'candidate');
 assert.equal(archiveCard(home,{...raw,platform:'tieba',at:now}),false);
});
test('tool pagination returns every same-timestamp excerpt without gaps',async()=>{
 setup();for(let i=0;i<12;i++)archiveCard(home,{...approvedTieba(normalizeTieba({...raw,id:'tieba:'+(223456789+i)},'花卉'),accept),at:time-1000});
 const ids=[];let cursor={};for(let i=0;i<4;i++){
  const r=await expressionLibrary(agent,{action:'materials',platform:'tieba',limit:5,...cursor});ids.push(...r.items.map(x=>x.id));if(!r.items.length)break;cursor={beforeAt:r.nextBeforeAt,beforeId:r.nextBeforeId};
 }
 assert.equal(ids.length,12);assert.equal(new Set(ids).size,12);
});
test('transport forwards validated pagination and refuses invalid pages before launching',async()=>{
 setup();await readTieba(home,null,0,[],{forum:'花卉',page:4,offset:7,runner:(file,args,opts,cb)=>{const req=JSON.parse(args[1]);assert.equal(req.page,4);assert.equal(req.offset,7);cb(null,JSON.stringify(raw))}});
 for(const options of [{page:0},{page:'2'},{offset:10},{offset:-1}])await assert.rejects(readTieba(home,null,0,[],{...options,runner:()=>assert.fail('unexpected launch')}),/invalid_source/);
});
