'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
test('waits for native message service before binding and retries without losing subscription',async()=>{
 let scheduled,ready=false,subscriptions=0;
 const nativeMsg={addKernelMsgListener(){subscriptions++;}};
 const native={NodeIKernelLoginService:{get:()=>({getLoginList:async()=>({LocalLoginInfoList:[{uin:'10002',isUserLogin:true}]})})},NodeIQQNTWrapperSession:{getNTWrapperSession:()=>({getMsgService:()=>ready?nativeMsg:undefined})}};
 const dependencies={fs:{readFileSync:()=>JSON.stringify({account:'10002',token:'a'.repeat(64),allowedPrivateUins:['10001']})},http:{createServer:()=>({listen(){}})},crypto:require('crypto'),'./media.cjs':{createMediaStore:()=>({})},'./recovery.cjs':{reconcile:async()=>[]},'./adapter.cjs':{ACCOUNT:'10002',createAdapter:()=>({health:()=>({}),peers:()=>[],receive(){}})}};
 const context={module:{exports:{}},require:n=>dependencies[n],Date,Buffer,URL,setTimeout,clearTimeout,setInterval(fn){scheduled=fn;return {unref(){}};}};
 context.global={authData:{uin:'10002'},statusData:{disconnect:0}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'service.cjs'),'utf8'),context);
 const service=context.module.exports(()=>native);await new Promise(r=>setImmediate(r));
 assert.equal(service.status.subscribed,false);assert.equal(subscriptions,0);
 ready=true;await scheduled();assert.equal(service.status.subscribed,true);assert.equal(subscriptions,1);
 await scheduled();assert.equal(subscriptions,1);
});
