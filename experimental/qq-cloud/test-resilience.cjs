'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {ACCOUNT}=require('./adapter.cjs'),{reconcile,order}=require('./recovery.cjs');
const peer={chatType:1,peerUid:'u_ExampleOwner0000000000',uin:'10001',checkpoint:'100'};
const message=(id,extra={})=>({chatType:1,peerUid:peer.peerUid,senderUin:peer.uin,msgId:id,msgTime:'1700000000',msgSeq:id,...extra});
function adapter(){let seq=0;const received=[],reports=[];return {received,reports,peers:()=>[{...peer}],health:()=>({eventSequence:seq}),receive:(_,m)=>{received.push(m);seq++;},finishRecovery(){},recovery:(_,r)=>reports.push(r)};}
async function recoverPage(list,a=adapter()){
 const result=await reconcile(a,async()=>({result:0,msgList:list}),ACCOUNT);
 return {a,result:result[0]};
}
for(const [label,list] of [
 ['duplicate message IDs',[message('100'),message('101'),message('101',{msgSeq:'102'})]],
 ['ambiguous native ordering',[message('100'),message('101',{msgSeq:'100'})]],
 ['invalid message ID',[message('100'),message('invalid',{msgSeq:'101'})]],
 ['mixed client/server sequence',[message('100'),message('101',{msgSeq:undefined,clientSeq:'101'})]],
 ['another conversation in the page',[message('100'),message('101',{peerUid:'u_AnotherExample0000000'})]],
])test('recovery rejects '+label+' before importing a partial page',async()=>{
 const {a,result}=await recoverPage(list);assert.equal(result.complete,false);assert.equal(result.gap,true);assert.equal(a.received.length,0);
});
test('a failed checkpoint commit cannot report a complete recovery',async()=>{
 const a=adapter();a.finishRecovery=()=>{throw Error('CHECKPOINT_WRITE_FAILED');};
 const {result}=await recoverPage([message('100'),message('101')],a);
 assert.equal(result.complete,false);assert.equal(result.gap,true);assert.match(result.error,/CHECKPOINT_WRITE_FAILED/);
});
test('strict native ordering still supports zero sequence and an out-of-order valid page',()=>{
 assert.deepEqual(order([message('102'),message('100',{msgSeq:0}),message('101')]).map(x=>x.msgId),['100','101','102']);
});
const flush=()=>new Promise(r=>setImmediate(r));
async function serviceFixture({removeThrows=false,deferredHistory=false}={}){
 let tick,fail=false,recv=0,removals=0,queries=0,resolveHistory;
 const listeners=[],recoveries=[];
 const nativeMsg={addKernelMsgListener(l){listeners.push(l);},removeKernelMsgListener(){removals++;if(removeThrows)throw Error('NATIVE_DETACH_FAILED');},getAioFirstViewLatestMsgs:()=>{queries++;return deferredHistory&&queries===1?new Promise(r=>{resolveHistory=r;}):Promise.resolve({result:0,msgList:[message('100')]});}};
 const native={NodeIKernelLoginService:{get:()=>({getLoginList:async()=>{if(fail)throw Error('TEMPORARY_NATIVE_ERROR');return {LocalLoginInfoList:[{uin:ACCOUNT,isUserLogin:true}]};}})},NodeIQQNTWrapperSession:{getNTWrapperSession:()=>({getMsgService:()=>nativeMsg})}};
 const a=adapter();a.receive=()=>{recv++;};a.recovery=(_,r)=>recoveries.push(r);
 const dependencies={fs:{readFileSync:()=>JSON.stringify({account:ACCOUNT,token:'a'.repeat(64)})},http:{createServer:()=>({listen(){}})},crypto:require('node:crypto'),'./adapter.cjs':{ACCOUNT,createAdapter:()=>a},'./media.cjs':{createMediaStore:()=>({})},'./recovery.cjs':{reconcile}};
 const context={module:{exports:{}},require:n=>dependencies[n],Date,Buffer,URL,setTimeout,clearTimeout,setInterval(fn){tick=fn;return {unref(){}};},global:{authData:{uin:ACCOUNT},statusData:{disconnect:0}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'service.cjs'),'utf8'),context);
 const service=context.module.exports(()=>native);await flush();
 return {service,listeners,recoveries,context,fail:v=>{fail=v;},tick:async()=>{await tick();await flush();},counts:()=>({recv,removals,queries}),resolveHistory:r=>resolveHistory(r)};
}
test('transient native login inspection failure detaches and rebinds once',async()=>{
 const f=await serviceFixture();assert.equal(f.listeners.length,1);
 f.fail(true);await f.tick();assert.equal(f.service.status.subscribed,false);assert.equal(f.counts().removals,1);
 f.fail(false);await f.tick();await f.tick();assert.equal(f.listeners.length,2);assert.equal(f.counts().queries,2);
});
test('retired callbacks stay inert even if native listener removal throws',async()=>{
 const f=await serviceFixture({removeThrows:true}),old=f.listeners[0];
 f.context.global.statusData.disconnect=1;await f.tick();
 f.context.global.statusData.disconnect=0;await f.tick();
 const before=f.counts().recv;old.onRecvMsg(message('101'));assert.equal(f.counts().recv,before);
 f.listeners.at(-1).onRecvMsg(message('102'));assert.equal(f.counts().recv,before+1);
});
test('callbacks cannot consume messages after an observed account switch',async()=>{
 const f=await serviceFixture();f.context.global.authData.uin='10099';
 const before=f.counts().recv;f.listeners[0].onRecvMsg(message('101'));assert.equal(f.counts().recv,before);
});
test('an old pending history result is discarded and the reconnect still gets recovery',async()=>{
 const f=await serviceFixture({deferredHistory:true});
 f.context.global.statusData.disconnect=1;await f.tick();
 f.context.global.statusData.disconnect=0;await f.tick();
 f.resolveHistory({result:0,msgList:[message('100'),message('101')]});await flush();
 assert.equal(f.counts().recv,0);assert.equal(f.recoveries[0].gap,true);
 await f.tick();assert.equal(f.counts().queries,2);assert.equal(f.recoveries.at(-1).complete,true);
});
