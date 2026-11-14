'use strict';
const fs=require('fs'),http=require('http'),crypto=require('crypto');
const {ACCOUNT,createAdapter}=require('./adapter.cjs');
const {createMediaStore,MAX_IMAGE}=require('./media.cjs');
const {reconcile}=require('./recovery.cjs');
module.exports=function start(qqRequire){
 const dir='/home/qq/lab',config=JSON.parse(fs.readFileSync(dir+'/transport-config.json','utf8'));
 if(config.account!==ACCOUNT||!/^[a-f0-9]{64}$/.test(config.token))throw Error('INVALID_TRANSPORT_CONFIG');
 let native,login,session,msg,listener,checking=false,quickAttempted=false,fatal=false,recovering=false,recoveryDue=true,mutating=false,historyPending=false,recoveryPeers;
 const status={account:null,online:false,subscribed:false,phase:'starting',startedAt:Date.now(),lastNativeEventAt:null};
 function detach(){
  if(status.subscribed)recoveryPeers=adapter.peers();
  if(listener&&typeof msg?.removeKernelMsgListener==='function')try{msg.removeKernelMsgListener(listener);}catch{}
  status.subscribed=false;session=null;msg=null;listener=null;recoveryDue=true;
 }
 const media=createMediaStore(dir);
 function bounded(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));}
 function sendNative(id,peer,elements,attributes){
  for(const e of elements)if(e.picElement){
   const p=e.picElement,destination=msg.getRichMediaFilePathForGuild({md5HexStr:p.md5HexStr,fileName:p.fileName,elementType:2,elementSubType:0,thumbSize:0,needCreate:true,downloadType:1,file_uuid:''});
   p.sourcePath=media.stageNative(p.fileName,destination);
   status.lastImagePreparation={at:Date.now(),nativeCache:true,size:p.fileSize};
  }
  return bounded(msg.sendMsg(id,peer,elements,attributes),12000,'NATIVE_SEND_UNCONFIRMED_TIMEOUT');
 }
 const adapter=createAdapter({dir,media,identity:()=>({...status,account:global.authData?.uin||null,online:status.online&&!fatal&&!global.statusData?.disconnect}),sendNative,allowedPrivateUins:config.allowedPrivateUins||[],allowedGroupUins:config.allowedGroupUins||[]});
 recoveryPeers=adapter.peers();
 function ready(){if(fatal||!status.online||!status.subscribed||global.authData?.uin!==ACCOUNT||global.statusData?.disconnect)throw Error('ACCOUNT_OFFLINE_OR_UNBOUND');}
 function shapes(input){return (Array.isArray(input)?input:[input]).filter(m=>m&&adapter.peers().some(p=>p.peerUid===m.peerUid&&p.chatType===m.chatType)).slice(-6).map(m=>({msgId:m.msgId,chatType:m.chatType,peerUin:m.peerUin,senderUin:m.senderUin,senderUidMatchesPeer:m.senderUid===m.peerUid,sendStatus:m.sendStatus,elementTypes:m.elements?.map(e=>e.elementType),textLengths:m.elements?.map(e=>typeof e.textElement?.content==='string'?e.textElement.content.length:null),hasPictures:m.elements?.map(e=>!!e.picElement)}));}
 async function recover(peers){
  ready();if(recovering||historyPending)throw Error('RECOVERY_BUSY');recovering=true;
  try{const r=await reconcile(adapter,(p,n)=>{
   ready();if(historyPending)throw Error('NATIVE_HISTORY_PENDING');historyPending=true;
   const pending=Promise.resolve().then(()=>msg.getAioFirstViewLatestMsgs(p,n)).then(r=>{status.lastHistoryShape=shapes(r?.msgList||[]);return r;}).finally(()=>{historyPending=false;});
   return bounded(pending,8000,'NATIVE_HISTORY_TIMEOUT');
  },ACCOUNT,peers);status.lastRecoveryAt=Date.now();return r;}finally{recovering=false;}
 }
 async function tick(){
  if(checking||fatal)return;checking=true;
  try{
   native??=qqRequire('/opt/QQ/resources/app/wrapper.node');login??=native.NodeIKernelLoginService.get();
   const data=await login.getLoginList(),active=data.LocalLoginInfoList?.filter(x=>x.isUserLogin)||[];
   if(active.some(x=>x.uin!==ACCOUNT)){detach();status.online=false;status.phase='account-mismatch';return;}
   const self=active.find(x=>x.uin===ACCOUNT);status.account=self?.uin||null;
   status.online=!!self&&global.authData?.uin===ACCOUNT&&!global.statusData?.disconnect;
   if(!status.online){
    if(status.subscribed)detach();
    recoveryDue=true;
    status.phase='login-required';
    if(!quickAttempted&&data.LocalLoginInfoList?.some(x=>x.uin===ACCOUNT&&x.isQuickLogin)){
     quickAttempted=true;
     try{const r=await login.quickLoginWithUin(ACCOUNT);status.quickLogin={attempted:true,result:r?.result,errMsg:String(r?.errMsg||'').slice(0,160)};}catch(e){status.quickLogin={attempted:true,error:String(e.message).slice(0,160)};}
    }return;
   }
   // Version-pinned QQ 3.2.32 session, observed and verified with native send/receive.
   const current=native.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
   if(!current){detach();status.phase='session-unavailable';return;}
   // Native getters may return fresh JavaScript wrappers for the same nt_1 session.
   // Rebind after an observed offline transition, not on wrapper object inequality.
   if(!status.subscribed){
    const candidate=current.getMsgService();
    if(!candidate||typeof candidate.addKernelMsgListener!=='function'){status.phase='message-service-initializing';return;}
    const candidateListener=new Proxy({}, {get:(_t,key)=>typeof key==='string'?value=>{
     if(!['onRecvMsg','onAddSendMsg','onMsgInfoListUpdate'].includes(key))return;
     status.lastNativeEventAt=Date.now();
     const shape=shapes(value);if(shape.length)status.lastMessageShape={event:key,items:shape};
     if(Array.isArray(value)&&value.length>64){status.nativeBatchOverflow={at:Date.now(),count:value.length};recoveryPeers=adapter.peers();recoveryDue=true;}
     try{adapter.receive(key,value);}catch{fatal=true;status.phase='storage-error';status.online=false;}
    }:undefined});
    candidate.addKernelMsgListener(candidateListener);
    session=current;msg=candidate;listener=candidateListener;status.subscribed=true;
    status.subscriptionCount=(status.subscriptionCount||0)+1;
   }
   status.phase='online';delete status.lastError;
   if(recoveryDue&&!recovering){recoveryDue=false;void recover(recoveryPeers).catch(e=>{status.recoveryError=String(e.message).slice(0,120);});}
  }catch(e){status.online=false;status.phase='initializing';status.lastError=String(e.message).slice(0,160);}
  finally{checking=false;}
 }
 function authorized(req){const got=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+config.token);return got.length===expected.length&&crypto.timingSafeEqual(got,expected);}
 const server=http.createServer(async(req,res)=>{
  const reply=(code,data)=>{if(!res.destroyed){res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}};
  if(!authorized(req))return reply(401,{error:'UNAUTHORIZED'});
  try{
   const url=new URL(req.url,'http://localhost');
   if(req.method==='GET'&&url.pathname==='/health')return reply(200,{...status,...adapter.health(),scope:'spare-allowlisted-text-images',protocolReimplemented:false,recovering});
   if(req.method==='GET'&&url.pathname==='/groups'){
    ready();const groupService=session.getGroupService();let candidate;
    const result=new Promise(resolve=>{candidate=new Proxy({}, {get:(_t,key)=>key==='onGroupListUpdate'?(...args)=>{const list=args.find(Array.isArray);if(list)resolve(list.slice(0,32).map(g=>({uin:String(g.groupCode||''),name:String(g.groupName||'').slice(0,80)})));}:()=>{}});});
    groupService.addKernelGroupListener(candidate);
    try{await groupService.getGroupList(false);return reply(200,{groups:await bounded(result,6000,'GROUP_LIST_TIMEOUT')});}finally{groupService.removeKernelGroupListener(candidate);}
   }
   if(req.method==='GET'&&/^\/media\/[a-f0-9]{64}\.(png|jpg)$/.test(url.pathname)){
    const m=media.get(url.pathname.split('/')[2]);res.writeHead(200,{'Content-Type':m.extension==='png'?'image/png':'image/jpeg','Content-Length':m.size,'Cache-Control':'no-store'});res.end(m.bytes);return;
   }
   if(req.method==='GET'&&/^\/requests\/[A-Za-z0-9-]{8,64}$/.test(url.pathname)){
    const record=adapter.request(url.pathname.split('/')[2]);return reply(record?200:404,record||{error:'REQUEST_NOT_FOUND'});
   }
   if(req.method==='GET'&&url.pathname==='/events'){
    const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw Error('INVALID_CURSOR');
    return reply(200,adapter.events(after));
   }
   if(req.method==='POST'&&['/send-text','/send-image','/media','/recover','/fetch-image'].includes(url.pathname)){
    ready();if(mutating)throw Error('TRANSPORT_BUSY');mutating=true;
    try{
    if(url.pathname==='/media'){
     const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>MAX_IMAGE)throw Error('IMAGE_SIZE_OUT_OF_BOUNDS');chunks.push(c);}return reply(200,media.put(Buffer.concat(chunks)));
    }
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768){reply(413,{error:'BODY_TOO_LARGE'});req.destroy();return;}chunks.push(chunk);}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
    if(url.pathname==='/recover')return reply(200,{results:await recover()});
    if(url.pathname==='/fetch-image'){
     const key=body.msgId+':'+body.elementId,n=adapter.nativeImage(key);
     try{return reply(200,{status:'ready',media:media.importNative(n.sourcePath,n.md5)});}catch{}
     const dest=media.downloadPath(key);
     try{return reply(200,{status:'ready',media:media.finishDownload(key,n.md5)});}catch{}
     await bounded(Promise.resolve(msg.downloadRichMedia({fileModelId:'',downSourceType:1,triggerType:0,msgId:n.msgId,chatType:n.chatType,peerUid:n.peerUid,elementId:n.elementId,thumbSize:0,downloadType:1,filePath:dest})),10000,'NATIVE_DOWNLOAD_PENDING');
     try{return reply(200,{status:'ready',media:media.finishDownload(key,n.md5)});}catch(e){return reply(200,{status:'pending',reason:e.code==='ENOENT'?'download-in-progress':String(e.message).slice(0,120)});}
    }
    if((url.pathname==='/send-image')!==!!body.mediaId)throw Error('MESSAGE_ENDPOINT_MISMATCH');
    const result=await adapter.send(body);return reply(200,result);
    }finally{mutating=false;}
   }
   reply(404,{error:'NOT_FOUND'});
  }catch(e){reply(409,{error:String(e.message).slice(0,200)});}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=8;
 server.listen(9229,'0.0.0.0');setInterval(tick,3000).unref();void tick();
 return {server,status};
};
