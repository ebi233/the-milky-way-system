'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {createAdapter}=require('./adapter.cjs'),{createMediaStore,MAX_IMAGE}=require('./media.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=','base64');
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-http-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let handler;
 const deps={fs:{readFileSync:()=>JSON.stringify({account:'10002',token:'a'.repeat(64)})},http:{createServer:h=>{handler=h;return {listen(){}};}},crypto:require('crypto'),'./adapter.cjs':{ACCOUNT:'10002',createAdapter:o=>createAdapter({...o,dir,write:(p,v)=>fs.writeFileSync(p,JSON.stringify(v))})},'./media.cjs':{MAX_IMAGE,createMediaStore:()=>createMediaStore(dir)},'./recovery.cjs':require('./recovery.cjs')};
 const native={NodeIKernelLoginService:{get:()=>({getLoginList:async()=>({LocalLoginInfoList:[{uin:'10002',isUserLogin:true}]})})},NodeIQQNTWrapperSession:{getNTWrapperSession:()=>({getMsgService:()=>({addKernelMsgListener(){}})})}};
 const context={module:{exports:{}},require:n=>deps[n],Date,Buffer,URL,setTimeout,clearTimeout,setInterval:()=>({unref(){}}),global:{authData:{uin:'10002'},statusData:{disconnect:0}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'service.cjs'),'utf8'),context);context.module.exports(()=>native);await new Promise(r=>setImmediate(r));
 return async(method,url,body,authorized=true)=>{
  let consumed=false;const req={method,url,headers:{authorization:authorized?'Bearer '+'a'.repeat(64):''},destroy(){},async *[Symbol.asyncIterator](){consumed=true;yield body||Buffer.alloc(0);}};
  const response={destroyed:false,writeHead(code,headers){this.code=code;this.headers=headers;},end(data){this.body=data;}};await handler(req,response);return {...response,consumed,json:()=>JSON.parse(response.body)};
 };
}
test('unauthorized upload is denied before reading bytes; arbitrary execution remains absent',async t=>{const call=await setup(t);const denied=await call('POST','/media',png,false);assert.equal(denied.code,401);assert.equal(denied.consumed,false);assert.equal((await call('POST','/execute',Buffer.from('{}'))).code,404);});
test('authenticated image upload/download preserves exact bytes and cannot read arbitrary paths',async t=>{const call=await setup(t),put=await call('POST','/media',png);assert.equal(put.code,200);const get=await call('GET','/media/'+put.json().id);assert.equal(get.code,200);assert.deepEqual(get.body,png);assert.equal((await call('GET','/media/../../etc/passwd')).code,404);assert.equal((await call('POST','/fetch-image',Buffer.from('{"msgId":"1","elementId":"2"}'))).json().error,'IMAGE_NOT_AUTHORIZED');});
test('oversized upload releases request slot and malformed requests cannot reach native sender',async t=>{const call=await setup(t);const tooBig=await call('POST','/media',Buffer.alloc(MAX_IMAGE+1));assert.equal(tooBig.code,409);assert.match(tooBig.json().error,/SIZE/);assert.equal((await call('POST','/media',png)).code,200);assert.equal((await call('POST','/send-image',Buffer.from('{"text":"x"}'))).json().error,'MESSAGE_ENDPOINT_MISMATCH');});
