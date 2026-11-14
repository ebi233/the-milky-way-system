import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverEmpty,eligible} from './reply-core.mjs';
import {prepareMessages,cleanCheckpoint} from './context-core.mjs';
import {isMaintenanceMessage} from './maintenance-memory.mjs';
const end={type:'finish',reason:{kind:'stop'}};
const text={type:'text-delta',index:0,text:'在呢'};
async function* stream(xs){yield* xs;}
async function run(xs,ys=[text,end]){
 let retries=0,events=[],out=[];
 for await(const c of recoverEmpty(stream(xs),()=>{retries++;return stream(ys)},x=>events.push(x)))out.push(c);
 return {out,retries,events};
}
test('ordinary answer is untouched',async()=>{const r=await run([text,end]);assert.equal(r.retries,0);assert.deepEqual(r.out,[text,end]);});
test('explicit voluntary silence is not an error',async()=>{assert.equal((await run([{...text,text:'[PAOPAO_SILENT]'},end])).retries,0);});
test('reasoning-only normal finish retries once, reasoning is not copied to answer',async()=>{
 const r=await run([{type:'block-start',index:0,blockType:'reasoning'},end]);
 assert.equal(r.retries,1);assert.deepEqual(r.out,[text,end]);assert.deepEqual(r.events,['empty_detected','empty_recovered']);
});
test('tool output is never retried',async()=>{assert.equal((await run([{type:'tool-call-delta',index:0,id:'t',name:'voice',argumentsDelta:'{}'},end])).retries,0);});
test('abort/error/max tokens are not retried',async()=>{for(const kind of ['aborted','error','max-tokens'])assert.equal((await run([{type:'finish',reason:{kind}}])).retries,0);});
test('second empty answer fails explicitly, no recursion',async()=>{const r=await run([end],[end]);assert.equal(r.retries,1);assert.equal(r.out.at(-1).reason.kind,'error');});
test('compaction, tool-result steps and maintenance never trigger reply retry',()=>{
 const q={sessionId:'s',messages:[{role:'user',source:{kind:'qq'}}]};assert.equal(eligible(q),true);
 assert.equal(eligible({...q,purpose:'compaction'}),false);
 assert.equal(eligible({...q,purpose:'paopao-empty-recovery'}),false);
 assert.equal(eligible({...q,messages:[{role:'tool'}]}),false);
 assert.equal(eligible({...q,messages:[{role:'user',source:{kind:'user'}}]}),false);
 assert.equal(eligible({...q,messages:[...q.messages,{role:'developer',content:[]}]}),true);
 assert.equal(eligible({...q,messages:[...q.messages,{role:'user',source:{kind:'model-selection'}}]}),true);
 assert.equal(eligible({...q,messages:[...q.messages,{role:'assistant',content:[]}]}),false);
});
test('maintenance turns excluded without discarding real QQ user quotes',()=>{
 const u=(kind,text)=>({role:'user',source:{kind},content:[{type:'text',text}]});
 const a={role:'assistant',content:[{type:'text',text:'maintenance answer'}]};
 const q=u('qq','我是维护助手这个称呼好奇怪');
 assert.deepEqual(prepareMessages([u('user','我是维护助手'),a,q,a]),[q,a]);
});
test('obsolete speaker/persona instructions leave checkpoint, facts retained',()=>{
 const text='**身份**\n- 当前对话方是维护助手，不是老哥\n**关系**\n- 喜欢海洋\n**说话约束**\n- 当客服\n**待办**\n- 明天看书';
 const clean=cleanCheckpoint(text);assert.ok(clean.includes('喜欢海洋'));assert.ok(clean.includes('明天看书'));assert.ok(!clean.includes('维护助手'));assert.ok(!clean.includes('当客服'));
});
test('timestamps anchored to original event, source messages immutable',()=>{
 const msg={id:'a',role:'user',source:{kind:'qq'},content:[{type:'text',text:'今天练腿'}]};
 const r=prepareMessages([msg],[{type:'user/message',time:1793437200000,data:{id:'a'}}],{stamp:true});
 assert.match(r[0].content[0].text,/2026-10-31/);assert.equal(msg.content.length,1);
});
test('owner date correction never injected into another room',()=>{
 const t='- 练腿硬拉 80kg 后臀、大腿外侧、腰酸';
 assert.equal(cleanCheckpoint(t),t);assert.match(cleanCheckpoint(t,{owner:true}),/2026-10-31/);
});

test('review variants excluded across model switches, genuine user quotes retained',()=>{
 const u=(kind,text)=>({role:'user',source:{kind},content:[{type:'text',text}]});
 const reply={role:'assistant',content:[{type:'text',text:'维护答复'}]};
 const real=u('qq','维护助手为什么这样说');
 for(const text of ['【维护助手的功能说明】','泡泡，我是前面与你讨论外观的维护助手','老哥已经授权固定创作流程']){
  assert.ok(isMaintenanceMessage(u('user',text)));
  assert.deepEqual(prepareMessages([u('user',text),u('model-selection','切换'),reply,real]),[real]);
 }
});
