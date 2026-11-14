import {defineTool} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import {identity} from '/srv/dsh-qq-ext/dsh-long-memory/lib/access.js';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export const name='paopao-tool-economy';
export const inject=['tools','webServer'];
export const version='browser-consolidation-v1';
export const families={
  workspace:['pwsh','bash','workflow','edit','write','glob','grep','present','job_output','job_list','job_kill','ask_user_question','exit_plan_mode','todo_write'],
  agents:['subagent','subagent_fork','send_message','list_agents','interrupt_agent'],
  bili_account:['bili_config','bili_login_poll','bili_login_start','bili_setup','bili_status','bili_whoami','bili_reply','bili_send_message','bili_triple'],
  qq_profile:['qq_avatar_set','qq_friend_remark','qq_online_status','qq_profile_get','qq_profile_set','qq_send_like'],
  qzone:['qq_qzone_post','qq_qzone_delete','qzone_board_post','qzone_board_read','qzone_board_reply','qzone_comment','qzone_feeds','qzone_comments','qzone_reply'],
  media:['dy_hot','short_media_browse','imagegen_skill','draw_image','draw_recent'],
  media_legacy:['dy_search','xhs_page','xhs_search'],
};
const validSelection=n=>typeof n==='string' && (Object.hasOwn(families,n)||Object.values(families).some(a=>a.includes(n)));
export function restoreFromEvents(events) {
  const pending=new Map(),selected=new Set();
  for(const e of Array.isArray(events)?events:[]) {
    const d=e?.data;
    if(e?.type==='tool/call' && d?.name==='load_optional_tools' && typeof d.callId==='string') {
      try {
        const a=typeof d.arguments==='string'?JSON.parse(d.arguments):d.arguments;
        pending.set(d.callId,(Array.isArray(a?.names)?a.names:[]).filter(validSelection));
      }catch{}
    }
    if(e?.type==='tool/result' && d?.message) {
      const m=d.message,id=m.toolCallId||m.source?.callId,requested=pending.get(id);
      pending.delete(id);
      if(!requested || d.error || m.isError)continue;
      const texts=(Array.isArray(m.content)?m.content:[]).filter(x=>x?.type==='text').map(x=>String(x.text||''));
      if(!texts.some(x=>x.startsWith('已加载：')))continue;
      for(const n of requested)selected.add(n);
    }
  }
  return selected;
}
export function selectionStore(path) {
  function read() {
    try {
      const d=JSON.parse(readFileSync(path,'utf8'));
      if(d.version!==1||!d.sessions||typeof d.sessions!=='object'||Array.isArray(d.sessions))throw Error('Invalid tool selection state');
      return d;
    }catch(e){if(e.code==='ENOENT')return {version:1,sessions:{}};throw e;}
  }
  return {
    get(sid){const v=read().sessions[sid]?.selected;return (Array.isArray(v)?v:[]).filter(validSelection);},
    put(sid,selected){
      if(!/^session-[a-zA-Z0-9-]+$/.test(sid))throw Error('Invalid session');
      const d=read();d.sessions[sid]={selected:[...selected].filter(validSelection),updatedAt:Date.now()};
      const rows=Object.entries(d.sessions).sort((a,b)=>(b[1].updatedAt||0)-(a[1].updatedAt||0));d.sessions=Object.fromEntries(rows.slice(0,100));
      mkdirSync(dirname(path),{recursive:true,mode:0o700});const tmp=path+'.'+randomUUID()+'.tmp';
      writeFileSync(tmp,JSON.stringify(d),{mode:0o600});renameSync(tmp,path);
    },
  };
}
export function mountGate(tools,agent,hidden,released,old) {
  const known=tools.view(agent).restrictableNames;
  const deny=[...hidden].filter(n=>known.has(n)&&!released.has(n));
  const dispose=deny.length?tools.restrict({deny}):()=>{};
  old?.();
  return dispose;
}
export function apply(ctx) {
  const gates=new Map();
  const store=selectionStore(join(process.env.DSH_HOME||'/srv/dsh-cloud/home','optional-tool-selections.json'));
  ctx.on('agent/created',({agent})=>{
    const who=identity(agent);
    // This gate only reduces the direct owner's inherited surface. It never
    // registers capabilities in a group/guest/child scope or changes auth guards.
    if(who.role!=='owner'||who.inherited||!agent.ctx?.tools) return;
    const tools=agent.ctx.tools, view=tools.view(agent);
    const hidden=new Set(Object.values(families).flat().filter(n=>view.visible.has(n)&&view.restrictableNames.has(n)));
    if(!hidden.size)return;
    const selected=restoreFromEvents(agent.session?.snapshotEvents?.()||[]);
    let persistenceError=false;
    try{for(const n of store.get(who.session))selected.add(n);}catch{persistenceError=true;}
    const released=new Set([...selected].flatMap(n=>families[n]||[n]).filter(n=>hidden.has(n)));
    const gate={tools,hidden,released,selected,dispose:null,persistenceError};gates.set(agent,gate);
    try{store.put(who.session,selected);}catch{gate.persistenceError=true;}
    const index=Object.entries(families).map(([group,names])=>`${group}: ${names.filter(n=>hidden.has(n)).join(', ')}`).join('; ');
    const unregister=tools.register(defineTool({
      name:'load_optional_tools',
      description:'按需加载已安装的功能。需要终端、文件编辑、工作流、任务代理、QQ空间读写、账号设置、绘图或小红书/抖音浏览时先调用；已加载选择在本会话重启后恢复。若遇unknown tool，先重新加载相应分组，不要据此声称平台拒绝或要求扩大权限。只管理工具可见性，不授予权限。分组及工具：'+index,
      parameters:{names:{type:'array',items:{type:'string'},description:'分组名或工具名，可以多个'}},
      output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},
      isConcurrencySafe:()=>false,
      async execute(args,exec) {
        const w=identity(exec?.agent);
        if(exec?.agent!==agent||w.role!=='owner'||w.inherited) return '当前会话不能加载这些工具';
        const names=(Array.isArray(args?.names)?args.names:[]).filter(validSelection);
        const requested=names.flatMap(n=>families[n]||[n]);
        const next=new Set([...gate.released,...requested.filter(n=>hidden.has(n))]);
        gate.dispose=mountGate(tools,agent,hidden,next,gate.dispose);gate.released=next;
        for(const n of names)gate.selected.add(n);
        try{store.put(w.session,gate.selected);gate.persistenceError=false;}catch{gate.persistenceError=true;}
        return '已加载：'+[...next].join(', ')+'。现有权限限制仍然生效'+(gate.persistenceError?'；本次持久化失败，重启后可能需要重新加载':'');
      },
    }));
    gate.dispose=mountGate(tools,agent,hidden,gate.released,null);
    agent.ctx.on('dispose',()=>{gate.dispose?.();unregister?.();gates.delete(agent)});
  });
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/dsh-token-economy/state',handler:(req,res)=>{
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)){res.writeHead(403);res.end();return;}
    const owners=[];
    for(const [agent,g]of gates) {
      const w=identity(agent);if(w.role!=='owner'||w.inherited)continue;
      const view=g.tools.view(agent);
      owners.push({visibleTools:[...view.visible.keys()],hiddenTools:[...g.hidden].filter(n=>!view.visible.has(n)),selected:[...g.selected],visibleQzone:families.qzone.filter(n=>view.visible.has(n)),persistenceError:g.persistenceError});
    }
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({version,owners}));
  }}));
}
