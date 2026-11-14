'use strict';
// Version-pinned spare-account transport. Targets must be explicitly allowed and observed.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ACCOUNT='10002';
function atomic(file,value){
 const tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);
 const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
const MAX_STATE_BYTES=2*1024*1024;
const uidPattern=/^u_[\w-]{10,40}$/;
function createAdapter({dir,identity,sendNative,allowedPrivateUins=[],allowedGroupUins=[],media=null,write=atomic}){
 const allowed=new Set(allowedPrivateUins);
 if(allowed.size>16||[...allowed].some(u=>typeof u!=='string'||!/^\d{5,12}$/.test(u)||u===ACCOUNT))throw Error('INVALID_PRIVATE_ALLOWLIST');
 const groups=new Set(allowedGroupUins);
 if(groups.size>8||[...groups].some(u=>typeof u!=='string'||!/^\d{5,12}$/.test(u)))throw Error('INVALID_GROUP_ALLOWLIST');
 const file=path.join(dir,'transport-state.json');
 let state={version:3,account:ACCOUNT,seq:0,peer:null,privatePeers:{},groupPeers:{},events:[],seenEvents:[],requests:{},checkpoints:{},recovery:{},nativeImages:{}};
 if(fs.existsSync(file)){
  if(fs.statSync(file).size>MAX_STATE_BYTES)throw Error('STATE_TOO_LARGE');
  state=JSON.parse(fs.readFileSync(file,'utf8'));
  if(![1,2,3].includes(state.version)||state.account!==ACCOUNT||!Array.isArray(state.events)||!state.requests||!Number.isSafeInteger(state.seq))throw Error('INVALID_STATE');
  state.privatePeers??={};state.groupPeers??={};state.seenEvents??=state.events.map(e=>e.key);
  state.checkpoints??={};state.recovery??={};state.nativeImages??={};
  if(state.version<3)for(const e of state.events)if(e.chatType===1&&e.peerUid)state.checkpoints['1:'+e.peerUid]=e.msgId;
  state.version=3;
 }
 let storageHealthy=true;
 const save=()=>{try{if(Buffer.byteLength(JSON.stringify(state))>MAX_STATE_BYTES)throw Error('STATE_CAPACITY');write(file,state);}catch(e){storageHealthy=false;throw e;}};
 const guard=()=>{const id=identity();if(!storageHealthy)throw Error('STORAGE_UNHEALTHY');if(id.account!==ACCOUNT||!id.online||!id.subscribed)throw Error('ACCOUNT_OFFLINE_OR_UNBOUND');};
 const textValid=t=>typeof t==='string'&&t.trim().length>0&&Buffer.byteLength(t)<=4096&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t);
 const peerOf=item=>item.nativePeer||(item.target?.kind==='private'?null:state.peer);
 function receive(name,input,{source='live',advanceCheckpoint=true}={}){
  if(identity().account!==ACCOUNT||!storageHealthy||!['onRecvMsg','onAddSendMsg','onMsgInfoListUpdate'].includes(name))return;
  for(const m of (Array.isArray(input)?input:[input]).slice(0,64)){
   if(!m||typeof m.msgId!=='string'||!/^\d{1,24}$/.test(m.msgId))continue;
   const group=m.chatType===2&&groups.has(m.peerUin)&&m.peerUid===m.peerUin&&/^\d{5,12}$/.test(m.senderUin||'')&&uidPattern.test(m.senderUid||'');
   if(!group&&!uidPattern.test(m.peerUid||''))continue;
   const self=m.chatType===8&&m.senderUin===ACCOUNT;
   const incomingPrivate=m.chatType===1&&name==='onRecvMsg'&&allowed.has(m.peerUin)&&m.senderUin===m.peerUin&&m.senderUid===m.peerUid;
   const outgoingPrivate=m.chatType===1&&name!=='onRecvMsg'&&allowed.has(m.peerUin)&&m.senderUin===ACCOUNT&&state.privatePeers[m.peerUin]?.peerUid===m.peerUid;
   if(!self&&!incomingPrivate&&!outgoingPrivate&&!group)continue;
   if(!Array.isArray(m.elements)||m.elements.length>64)continue;
   const text=m.elements.map(e=>e.textElement?.content||'').join('');
   const pics=m.elements.filter(e=>e.elementType===2&&e.picElement).slice(0,4);
   if((!textValid(text)&&!(text===''&&pics.length))||(self&&!/^Paopao-cloud-[A-Za-z0-9-]{1,80}$/.test(text)))continue;
   const incoming=(incomingPrivate||group)&&m.senderUin!==ACCOUNT;
   if(group&&name!=='onRecvMsg'&&m.senderUin!==ACCOUNT)continue;
   // Incoming receipt updates/history replay must not create duplicate chat messages.
   const eventKey=[name==='onRecvMsg'?'onRecvMsg':name,m.msgId,name==='onRecvMsg'?2:m.sendStatus].join(':');
   if(state.seenEvents.includes(eventKey))continue;
   if(self&&name==='onRecvMsg')state.peer={chatType:8,peerUid:m.peerUid,guildId:'',evidenceMsgId:m.msgId};
   if(incomingPrivate){
    const previous=state.privatePeers[m.peerUin];
    if(previous&&previous.peerUid!==m.peerUid){previous.conflict=true;save();continue;}
    if(!previous)state.privatePeers[m.peerUin]={chatType:1,peerUid:m.peerUid,guildId:'',evidenceMsgId:m.msgId,uin:m.peerUin};
   }
   if(group&&name==='onRecvMsg'&&incoming)state.groupPeers[m.peerUin]={chatType:2,peerUid:m.peerUin,guildId:'',uin:m.peerUin,evidenceMsgId:m.msgId};
   const images=pics.map(e=>{
    const p=e.picElement,key=m.msgId+':'+e.elementId;
    const info={elementId:String(e.elementId||''),md5:String(p.md5HexStr||'').toLowerCase(),width:p.picWidth,height:p.picHeight,size:Number(p.fileSize)||0,status:'pending'};
    if(media&&/^\d{1,24}$/.test(info.elementId)&&/^[a-f0-9]{32}$/.test(info.md5)&&info.size>0&&info.size<=8*1024*1024){
     state.nativeImages[key]={msgId:m.msgId,elementId:info.elementId,chatType:m.chatType,peerUid:m.peerUid,peerUin:m.peerUin,sourcePath:typeof p.sourcePath==='string'?p.sourcePath.slice(0,2048):'',md5:info.md5,size:info.size};
     try{info.media=media.importNative(p.sourcePath,info.md5);info.status='ready';}catch(e){info.reason=e.code==='ENOENT'?'not-downloaded':String(e.message).slice(0,100);}
    }else{info.status='unsupported';}
    return info;
   });
   const allImages=Object.keys(state.nativeImages);for(const k of allImages.slice(0,Math.max(0,allImages.length-128)))delete state.nativeImages[k];
   let requestId;
   if(name!=='onRecvMsg'&&m.senderUin===ACCOUNT){
    const candidates=Object.values(state.requests).filter(r=>{const p=peerOf(r);const matches=r.mediaId?images.length===1&&images[0].md5===r.mediaMd5:pics.length===0;return p?.chatType===m.chatType&&p.peerUid===m.peerUid&&(r.msgId===m.msgId||(!r.msgId&&r.text===text&&matches&&['attempting','accepted','unknown'].includes(r.phase)));});
    if(candidates.length===1){const r=candidates[0];r.msgId=m.msgId;r.nativeSendStatus=m.sendStatus;r.nativeReceiptAt=Date.now();requestId=r.requestId;}
   }
   state.events.push({seq:++state.seq,key:eventKey,at:Date.now(),event:name,source,msgId:m.msgId,msgTime:String(m.msgTime||''),msgSeq:String(m.msgSeq||''),sendStatus:m.sendStatus,chatType:m.chatType,peerUid:m.peerUid,peerUin:m.peerUin||'0',senderUin:m.senderUin,direction:name==='onRecvMsg'?'incoming':'outgoing',text,images,...(requestId?{requestId}:{}),hasNonTextElements:m.elements.some(e=>e.elementType!==1&&e.elementType!==undefined)});
   if(advanceCheckpoint&&[1,2].includes(m.chatType))state.checkpoints[m.chatType+':'+m.peerUid]=m.msgId;
   state.events=state.events.slice(-128);state.seenEvents.push(eventKey);state.seenEvents=state.seenEvents.slice(-512);save();
  }
 }
 async function send(request){
  guard();
  if(!request||Object.keys(request).some(k=>!['requestId','text','target','mediaId','replyTo'].includes(k))||!/^[A-Za-z0-9-]{8,64}$/.test(request.requestId||'')||(!textValid(request.text)&&!(request.mediaId&&request.text==='')))throw Error('INVALID_TEXT_REQUEST');
  const image=request.mediaId&&media?media.get(request.mediaId):null;
  if(request.mediaId&&!image)throw Error('INVALID_MEDIA_ID');
  const target=request.target??{kind:'self'};
  if(!target||typeof target!=='object'||Array.isArray(target)||!['self','private','group'].includes(target.kind)||Object.keys(target).some(k=>!(target.kind==='self'?['kind']:['kind','uin']).includes(k)))throw Error('INVALID_TARGET');
  let peer;
  if(target.kind==='self'){
   if(image||!/^Paopao-cloud-[A-Za-z0-9-]{1,80}$/.test(request.text))throw Error('INVALID_SELF_TEST_REQUEST');
   peer=state.peer;if(!peer||peer.chatType!==8)throw Error('NO_VERIFIED_SELF_DEVICE');
  }else if(target.kind==='private'){
   if(!allowed.has(target.uin))throw Error('PRIVATE_TARGET_NOT_ALLOWED');
   peer=state.privatePeers[target.uin];if(!peer||peer.conflict)throw Error('NO_VERIFIED_PRIVATE_PEER');
  }else{
   if(!groups.has(target.uin))throw Error('GROUP_TARGET_NOT_ALLOWED');
   peer=state.groupPeers[target.uin];if(!peer)throw Error('NO_VERIFIED_GROUP');
  }
  const fingerprint=crypto.createHash('sha256').update(target.kind==='self'?request.text:JSON.stringify([target.kind,target.uin,request.text,...(image?[image.sha256]:[]),...(target.kind==='group'?[request.replyTo]:[])])).digest('hex');
 const previous=Object.hasOwn(state.requests,request.requestId)?state.requests[request.requestId]:null;
  if(previous){if(previous.fingerprint!==fingerprint)throw Error('REQUEST_ID_CONFLICT');return {...previous,replayed:true};}
  if(target.kind==='group'&&!state.events.some(e=>e.chatType===2&&e.peerUin===target.uin&&e.msgId===request.replyTo&&e.direction==='incoming'&&e.source==='live'&&e.senderUin!==ACCOUNT&&Date.now()-e.at<600000&&/^\d{10,12}$/.test(e.msgTime||'')&&Date.now()-Number(e.msgTime)*1000<600000&&Number(e.msgTime)*1000<Date.now()+120000))throw Error('GROUP_REQUIRES_FRESH_INCOMING_MESSAGE');
  if(Object.keys(state.requests).length>=128)throw Error('REQUEST_LEDGER_FULL');
  const nativePeer={chatType:peer.chatType,peerUid:peer.peerUid,guildId:peer.guildId||''};
  if(Object.values(state.requests).some(r=>{const p=peerOf(r);return !r.msgId&&['attempting','accepted','unknown'].includes(r.phase)&&r.text===request.text&&(r.mediaId||null)===(request.mediaId||null)&&p?.chatType===nativePeer.chatType&&p.peerUid===nativePeer.peerUid;}))throw Error('MATCHING_SEND_AWAITING_NATIVE_ID');
  const item={requestId:request.requestId,fingerprint,text:request.text,target:{...target},nativePeer,...(image?{mediaId:image.id,mediaMd5:image.md5}:{}),...(request.replyTo?{replyTo:request.replyTo}:{}),phase:'attempting',at:Date.now(),dispatchAttempts:1};
  state.requests[request.requestId]=item;save();
  try{
   const elements=request.text?[{elementType:1,elementId:'',textElement:{content:request.text,atType:0,atUid:'',atTinyId:'',atNtUid:''}}]:[];
   if(image)elements.push(media.element(image.id));
   const result=await sendNative('0',nativePeer,elements,new Map());
   item.phase=result?.result===0||result?.result==='0'?'accepted':'rejected';item.result={result:result?.result,errMsg:String(result?.errMsg||'').slice(0,200)};
  }catch(e){item.phase='unknown';item.error=String(e.message).slice(0,200);}
  save();return {...item,replayed:false};
 }
 return {
  receive,send,
  health:()=>({expectedAccount:ACCOUNT,peerVerified:!!state.peer,privatePeers:Object.values(state.privatePeers).filter(p=>allowed.has(p.uin)).map(p=>({uin:p.uin,verified:!p.conflict})),allowedPrivateUins:[...allowed],allowedGroupUins:[...groups],recovery:structuredClone(state.recovery),eventSequence:state.seq,requestCount:Object.keys(state.requests).length,storageHealthy}),
  peers:()=>[...Object.values(state.privatePeers).filter(p=>allowed.has(p.uin)&&!p.conflict),...Object.values(state.groupPeers).filter(p=>groups.has(p.uin))].map(p=>({...p,checkpoint:state.checkpoints[p.chatType+':'+p.peerUid]||null})),
  recovery:(peer,result)=>{state.recovery[peer.chatType+':'+peer.peerUid]={...result,at:Date.now()};save();},
  finishRecovery:(peer,last)=>{const key=peer.chatType+':'+peer.peerUid;if(last&&state.checkpoints[key]===peer.checkpoint)state.checkpoints[key]=last;},
  nativeImage:key=>{const n=state.nativeImages[key];if(!n||!(n.chatType===1?allowed.has(n.peerUin):n.chatType===2&&groups.has(n.peerUin)))throw Error('IMAGE_NOT_AUTHORIZED');return {...n};},
  request:id=>Object.hasOwn(state.requests,id)?structuredClone(state.requests[id]):null,
  events:after=>{const oldest=state.events[0]?.seq??state.seq+1,events=state.events.filter(e=>e.seq>after).slice(0,64),nextCursor=events.at(-1)?.seq??Math.min(after,state.seq);return {oldestSequence:oldest,latestSequence:state.seq,nextCursor,hasMore:nextCursor<state.seq,cursorAhead:after>state.seq,gap:after<oldest-1||after>state.seq,events:structuredClone(events)};}
 };
}
module.exports={ACCOUNT,createAdapter,atomic};
