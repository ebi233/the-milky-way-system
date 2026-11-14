import fs from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {portalPolicy,digest,equalSecret,ownerBinding,validateInput,createReceipts,webTurn,isBusy} from './private-chat-core.mjs';
import {identity} from '../../dsh-qq-ext/dsh-long-memory/lib/access.js';
import {admitIncomingImages} from '../../dsh-qq-ext/dsh-vision/ingress.mjs';
const prefix='/paopao-private';
const errors={UNAUTHORIZED:401,DISABLED:503,BUSY:409,ID_CONFLICT:409,EXPIRED_INPUT:400,TOO_LARGE:413,NOT_FOUND:404};
async function body(req) {
  const chunks=[];let length=0;const timer=setTimeout(()=>req.destroy(),15000);timer.unref?.();
  try {for await(const chunk of req){length+=chunk.length;if(length>12*1024*1024)throw Error('TOO_LARGE');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  finally{clearTimeout(timer);}
}
export function installPrivateChat(ctx,{home,readConfig,cleanText}) {
  const dir=join(home,'private-chat'),receipts=createReceipts(dir),media=new Map();let preparing=false;
  receipts.uncertain();
  function settings(){const file=join(dir,'config.json');if(!fs.existsSync(file)||fs.statSync(file).size>4096)throw Error('DISABLED');const c=JSON.parse(fs.readFileSync(file,'utf8'));if(c.version!==1||c.enabled!==true||!/^[a-f0-9]{64}$/.test(c.tokenHash))throw Error('DISABLED');return c;}
  function scope(){const c=settings(),s=ownerBinding(readConfig());if(s.owner!==c.owner||s.session!==c.session)throw Error('OWNER_BINDING_CHANGED');return s;}
  async function agent(){const s=scope();const found=ctx.agents.get(s.session)|| (await ctx.sessionController.agents.resolveAgent(s.session)).agent;const who=found&&identity(found);if(!found||who.role!=='owner'||who.inherited||who.conflict||who.qq!==s.owner||who.session!==s.session)throw Error('OWNER_BINDING_CHANGED');return found;}
  function authenticated(req){const c=settings();const value=String(req.headers.authorization||'');if(!value.startsWith('Bearer ')||!equalSecret(digest(value.slice(7)),c.tokenHash))throw Error('UNAUTHORIZED');scope();}
  function imageRef(b) {
    try {const path=ctx.attachments.imageHostPath(b.attachment);if(!path)return null;const id=digest(JSON.stringify(b.attachment));media.set(id,{attachment:b.attachment});return {id,url:prefix+'/image?id='+id};}catch{return null;}
  }
  function visible(a) {
    media.clear();
    const events=a.session.snapshotEvents().slice(-512),messages=[];
    let batch=[],human=false,turn=0;
    const flush=()=>{if(human)messages.push(...batch);batch=[];human=false;};
    for(const e of events){
      if(e.type==='turn/start'){flush();turn=e.data?.turn;}
      const m=e.data?.message||e.data;
      if(e.type==='user/message'&&['qq','user'].includes(m?.source?.kind)){
        human=true;const text=m.content?.filter(b=>b.type==='text').map(b=>b.text||'').join('\n')||'';
        batch.push({id:m.id,role:'user',text:text.slice(0,20000),at:e.time||e.timestamp,channel:m.source.channel||m.source.kind,images:(m.content||[]).filter(b=>b.type==='image'&&b.attachment).map(imageRef).filter(Boolean),turn});
      }
      if(e.type==='assistant/message'&&!e.data?.interrupted){
        const text=cleanText((m?.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n'));
        const images=(m?.content||[]).filter(b=>b.type==='image'&&b.attachment).map(imageRef).filter(Boolean);
        // Only image files explicitly linked in visible owner-room output may be served.
        const stripped=text.replace(/!\[[^\]\r\n]*\]\(([^\r\n)]+)\)/g,(match,path)=>{
          try {const target=fs.realpathSync(path),root=fs.realpathSync(join(home,'drawings'));if(!target.startsWith(root+sep)||fs.statSync(target).size>5*1024*1024)return match;const id=digest(target);media.set(id,{path:target});images.push({id,url:prefix+'/image?id='+id});return ''; }catch{return match;}
        });
        if(stripped||images.length)batch.push({id:m.id||'reply-'+turn+'-'+batch.length,role:'assistant',text:stripped.slice(0,20000),images:images.slice(0,8),at:e.time||e.timestamp,turn});
      }
      if(e.type==='turn/end')flush();
    }
    flush();const rows=messages.slice(-100),allowed=new Set(rows.flatMap(row=>row.images.map(image=>image.id)));
    for(const id of media.keys())if(!allowed.has(id))media.delete(id);
    return rows;
  }
  async function submit(input) {
    input=validateInput(input);const s=scope(),old=receipts.get(input.id);
    if(old)return {ok:true,receipt:receipts.claim(input,s.session).receipt};
    if(preparing)throw Error('BUSY');preparing=true;
    let claimed;
    try {
      const a=await agent();if(isBusy(a))throw Error('BUSY');
      claimed=receipts.claim(input,s.session);if(!claimed.fresh)return {ok:true,receipt:claimed.receipt};
      let content=[{type:'text',text:input.text||'（发来了一张图片）'}];
      if(input.images.length){
        content=(await admitIncomingImages(ctx,{sessionId:s.session,kind:'私聊',qq:s.owner,source:'private-web',messageId:input.id},content[0].text,input.images.map((x,i)=>({...x,name:'private-'+input.id+'-'+i,original:''})))).content;
      }
      scope();if(isBusy(a))throw Error('BUSY');
      const message={id:claimed.receipt.messageId,role:'user',content,source:{kind:'user',channel:'private-web',requestId:input.id}};
      await a.followup(message);
      await ctx.sessions.flush(a.session);
      return {ok:true,receipt:receipts.get(input.id)};
    }catch(e){if(claimed)receipts.settle(input.id,'needs_check');throw e;}
    finally{preparing=false;}
  }
  function ownsEvent(session,event) {
    if(event.type!=='turn/end')return false;
    const messages=webTurn(session.snapshotEvents().slice(-256),event.data?.turn);
    if(!messages.length)return false;
    for(const m of messages)receipts.settle(m.source.requestId,event.data?.reason?.kind==='completed'?'completed':'failed');
    return true;
  }
  function blocksInput(session) {
    try{const s=scope();if(s.session!==session)return false;if(preparing)return true;const a=ctx.agents.get(session);if(!a||!isBusy(a))return false;const events=a.session.snapshotEvents().slice(-256),start=events.findLast(e=>e.type==='turn/start');return webTurn(events,start?.data?.turn).length>0;}catch{return false;}
  }
  ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:prefix,handler:async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const url=new URL(req.url,'http://localhost'),endpoint=url.pathname.slice(prefix.length);
    try {
      if(req.method==='GET'&&['','/','/app.js','/style.css'].includes(endpoint)){
        const file=endpoint==='/app.js'?'private-chat-ui.js':endpoint==='/style.css'?'private-chat.css':'private-chat.html';
        res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(fs.readFileSync(join(dirname(fileURLToPath(import.meta.url)),file)));return;
      }
      authenticated(req);res.setHeader('Content-Type','application/json; charset=utf-8');
      if(endpoint==='/state'&&req.method==='GET'){const a=await agent();res.end(JSON.stringify({ok:true,policy:portalPolicy,busy:preparing||isBusy(a),messages:visible(a),qqDependency:false,notifications:false}));return;}
      if(endpoint==='/send'&&req.method==='POST'){res.end(JSON.stringify(await submit(await body(req))));return;}
      if(endpoint==='/receipt'&&req.method==='GET'){res.end(JSON.stringify({ok:true,receipt:receipts.get(url.searchParams.get('id'))||null}));return;}
      if(endpoint==='/image'&&req.method==='GET'){
        const a=await agent();visible(a);const item=media.get(url.searchParams.get('id'));if(!item)throw Error('NOT_FOUND');
        const path=item.path||ctx.attachments.imageHostPath(item.attachment);if(!path||fs.statSync(path).size>5*1024*1024)throw Error('NOT_FOUND');
        const data=fs.readFileSync(path),type=data[0]===137?'image/png':data[0]===255?'image/jpeg':data.subarray(0,3).toString()==='GIF'?'image/gif':data.subarray(8,12).toString()==='WEBP'?'image/webp':null;
        if(!type)throw Error('NOT_FOUND');res.setHeader('Content-Type',type);res.end(data);return;
      }
      throw Error('NOT_FOUND');
    }catch(e){res.statusCode=errors[e.message]||400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error:/^[A-Z_]+$/.test(e.message)?e.message:'REQUEST_FAILED'}));}
  }}));
  return {ownsEvent,blocksInput,submit,visible};
}
