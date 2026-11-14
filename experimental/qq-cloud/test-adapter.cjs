'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createAdapter}=require('./adapter.cjs');
const text='Paopao-cloud-check-1234';
const incoming={chatType:8,senderUin:'10002',peerUid:'u_ExampleDevice000000000',msgId:'123456789',sendStatus:2,elements:[{textElement:{content:text}}]};
function fixture(t,extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paopao-adapter-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let calls=0;const identity={account:'10002',online:true,subscribed:true};
 const options={dir,identity:()=>identity,sendNative:async()=>{calls++;return {result:0};},write:(f,v)=>fs.writeFileSync(f,JSON.stringify(v)),...extra};
 return {adapter:createAdapter(options),options,identity,calls:()=>calls};
}
test('rejects unknown account, offline session, unbound device, and arbitrary targets',async t=>{
 const f=fixture(t),req={requestId:'test-0001',text};
 await assert.rejects(f.adapter.send(req),/NO_VERIFIED/);
 f.adapter.receive('onRecvMsg',incoming);f.identity.account='999';await assert.rejects(f.adapter.send(req),/OFFLINE_OR_UNBOUND/);
 f.identity.account='10002';f.identity.online=false;await assert.rejects(f.adapter.send(req),/OFFLINE_OR_UNBOUND/);
 f.identity.online=true;await assert.rejects(f.adapter.send({...req,peerUid:'any'}),/INVALID/);assert.equal(f.calls(),0);
});
test('ignores unrelated and group text; deduplicates native event updates',t=>{
 const f=fixture(t);f.adapter.receive('onRecvMsg',{...incoming,chatType:2});f.adapter.receive('onRecvMsg',{...incoming,senderUin:'123'});
 assert.equal(f.adapter.events(0).events.length,0);
 f.adapter.receive('onRecvMsg',incoming);f.adapter.receive('onRecvMsg',incoming);assert.equal(f.adapter.events(0).events.length,1);
});
test('concurrent duplicate and restarted duplicate never dispatch twice',async t=>{
 let release,calls=0;const gate=new Promise(r=>release=r);
 const f=fixture(t,{sendNative:async()=>{calls++;await gate;return {result:0};}});f.adapter.receive('onRecvMsg',incoming);
 const req={requestId:'test-0002',text},first=f.adapter.send(req);
 const duplicate=await f.adapter.send(req);assert.equal(duplicate.phase,'attempting');assert.equal(duplicate.replayed,true);
 release();assert.equal((await first).phase,'accepted');
 assert.equal((await createAdapter(f.options).send(req)).replayed,true);assert.equal(calls,1);
 await assert.rejects(f.adapter.send({...req,text:'Paopao-cloud-other-1234'}),/CONFLICT/);
});
test('uncertain native errors remain non-retryable across restart',async t=>{
 let calls=0;const f=fixture(t,{sendNative:async()=>{calls++;throw Error('connection closed');}});f.adapter.receive('onRecvMsg',incoming);
 const req={requestId:'test-0003',text};assert.equal((await f.adapter.send(req)).phase,'unknown');
 assert.equal((await createAdapter(f.options).send(req)).phase,'unknown');assert.equal(calls,1);
});
test('failed intent persistence prevents native send',async t=>{
 const f=fixture(t);f.adapter.receive('onRecvMsg',incoming);
 const options={...f.options,write:()=>{throw Error('disk full');}};const adapter=createAdapter(options);
 await assert.rejects(adapter.send({requestId:'test-0004',text}),/disk full/);assert.equal(f.calls(),0);
});
test('retained events are bounded and report the oldest cursor',t=>{
 const f=fixture(t);for(let i=0;i<160;i++)f.adapter.receive('onRecvMsg',{...incoming,msgId:String(100000+i)});
 const events=f.adapter.events(0);assert.equal(events.oldestSequence,33);assert.equal(events.latestSequence,160);assert.equal(events.events.length,64);
});
