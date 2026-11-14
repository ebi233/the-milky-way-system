'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createAdapter}=require('./adapter.cjs');
const owner='10001',uid='u_ExampleOwner0000000000';
const incoming={chatType:1,peerUin:owner,peerUid:uid,senderUin:owner,senderUid:uid,msgId:'11111111111',sendStatus:2,elements:[{elementType:1,textElement:{content:'好友测试：你好\n第二行'}}]};
function fixture(t,extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paopao-private-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let calls=0;const options={dir,identity:()=>({account:'10002',online:true,subscribed:true}),allowedPrivateUins:[owner],write:(f,v)=>fs.writeFileSync(f,JSON.stringify(v)),sendNative:async()=>{calls++;return {result:0};},...extra};
 return {a:createAdapter(options),options,dir,calls:()=>calls};
}
const request={requestId:'private-0001',target:{kind:'private',uin:owner},text:'你好，云端私聊测试。\n第二行'};
test('binds only allowlisted authentic private metadata, rejects groups and forged direction',async t=>{
 const f=fixture(t);
 for(const patch of [{chatType:2},{senderUin:'9999999'},{senderUid:'u_AnotherUserId00000'},{peerUin:'9999999'}])f.a.receive('onRecvMsg',{...incoming,...patch});
 assert.equal(f.a.events(0).events.length,0);await assert.rejects(f.a.send(request),/NO_VERIFIED_PRIVATE/);
 f.a.receive('onRecvMsg',incoming);assert.equal(f.a.health().privatePeers[0].uin,owner);
 assert.equal((await f.a.send(request)).phase,'accepted');assert.equal(f.calls(),1);
 await assert.rejects(f.a.send({...request,requestId:'private-0002',target:{kind:'private',uin:'9999999'}}),/NOT_ALLOWED/);
});
test('private UID change is blocked until independently reviewed',async t=>{
 const f=fixture(t);f.a.receive('onRecvMsg',incoming);
 f.a.receive('onRecvMsg',{...incoming,msgId:'11111111112',peerUid:'u_AnotherUserId00000',senderUid:'u_AnotherUserId00000'});
 await assert.rejects(f.a.send(request),/NO_VERIFIED_PRIVATE/);assert.equal(f.calls(),0);
});
test('send callback binds actual ID and status, survives reload, repeated request never resends',async t=>{
 const f=fixture(t);f.a.receive('onRecvMsg',incoming);await f.a.send(request);
 const sent={...incoming,msgId:'22222222222',senderUin:'10002',senderUid:'u_SelfUserId00000000',elements:[{elementType:1,textElement:{content:request.text}}]};
 f.a.receive('onAddSendMsg',{...sent,sendStatus:1});f.a.receive('onMsgInfoListUpdate',sent);
 const r=f.a.request(request.requestId);assert.equal(r.msgId,sent.msgId);assert.equal(r.nativeSendStatus,2);assert.equal(r.dispatchAttempts,1);
 const reloaded=createAdapter(f.options);assert.equal((await reloaded.send(request)).replayed,true);assert.equal(f.calls(),1);
 assert.equal(reloaded.request(request.requestId).nativeSendStatus,2);
});
test('ambiguous identical sends cannot be matched to the wrong request',async t=>{
 const f=fixture(t);f.a.receive('onRecvMsg',incoming);await f.a.send(request);
 await assert.rejects(f.a.send({...request,requestId:'private-0002'}),/AWAITING_NATIVE_ID/);assert.equal(f.calls(),1);
});
test('same request ID cannot switch recipient or content; Unicode is preserved',async t=>{
 const f=fixture(t);f.a.receive('onRecvMsg',incoming);await f.a.send(request);
 await assert.rejects(f.a.send({...request,text:'不同文字'}),/CONFLICT/);
 assert.equal(f.a.request(request.requestId).text,request.text);
 const r=f.a.request(request.requestId);r.text='外部改写';assert.equal(f.a.request(request.requestId).text,request.text);
});
test('event dedup survives event-ring eviction and exposes expired cursor gap',t=>{
 const f=fixture(t);for(let i=0;i<150;i++)f.a.receive('onRecvMsg',{...incoming,msgId:String(10000000000+i)});
 f.a.receive('onRecvMsg',{...incoming,msgId:'10000000000'});
 assert.equal(f.a.health().eventSequence,150);assert.equal(f.a.events(1).gap,true);
});
test('old self-device state migrates without deleting its send ledger',async t=>{
 const f=fixture(t),file=path.join(f.dir,'transport-state.json');
 fs.writeFileSync(file,JSON.stringify({version:1,account:'10002',seq:1,peer:{chatType:8,peerUid:uid,guildId:''},events:[{key:'old-event',seq:1}],requests:{'old-request':{requestId:'old-request',phase:'attempting',text:'Paopao-cloud-old'}}}));
 const a=createAdapter(f.options);a.receive('onRecvMsg',incoming);
 assert.equal(a.request('old-request').phase,'attempting');assert.equal(a.events(0).events[0].key,'old-event');
 assert.equal(JSON.parse(fs.readFileSync(file)).version,3);
});
test('oversized text is rejected and allowlist removal revokes persisted private target',async t=>{
 const f=fixture(t);f.a.receive('onRecvMsg',incoming);
 await assert.rejects(f.a.send({...request,text:'字'.repeat(1400)}),/INVALID/);
 const revoked=createAdapter({...f.options,allowedPrivateUins:[]});await assert.rejects(revoked.send(request),/NOT_ALLOWED/);assert.equal(f.calls(),0);
});
test('request IDs matching Object prototype names still get a real persisted ledger entry',async t=>{
 const f=fixture(t);f.a.receive('onRecvMsg',incoming);
 assert.equal((await f.a.send({...request,requestId:'toString'})).phase,'accepted');
 assert.equal(f.a.request('toString').dispatchAttempts,1);assert.equal(f.calls(),1);
});
