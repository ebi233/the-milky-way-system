import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {readObject,writeObject,singleFlight} from './runtime-state.mjs';
import {sealGroupBindings,validateBindings} from '../../dsh-qq-ext/dsh-long-memory/lib/group-privacy.mjs';
const home=process.env.DSH_HOME || join(homedir(),'.dsh');
const registry=join(home,'groups.json'), journal=join(home,'group-onboarding.json');
const fresh=()=>({session:'session-'+randomUUID(),createdAt:Date.now()});
export function createGroupOnboarding(ctx,readConfig){
  const metrics={created:0,recovered:0,errors:0,lastSuccessAt:null,reserveReady:false,stage:'idle'};
  function pending(){const p=readObject(journal,{version:1,records:{}});if(p.version!==1 || !p.records || Array.isArray(p.records))throw new Error('Invalid onboarding journal');return p;}
  async function ensureRoom(record){
    if(!/^session-[a-zA-Z0-9-]+$/.test(record?.session||''))throw new Error('Invalid reserved session');
    if(typeof ctx.sessionController?.create!=='function')throw new Error('Durable session creation unavailable');
    const cwd=join(home,'group-workspaces',record.session);mkdirSync(cwd,{recursive:true,mode:0o700});
    metrics.stage='creating';
    const result=await ctx.sessionController.create({sessionId:record.session,cwd,agentPreset:'standard'});
    metrics.stage='mounting';
    if(result?.sessionId!==record.session)throw new Error('Unexpected created session');
    const session=ctx.sessions?.get?.(record.session);
    if(!session)throw new Error('Created session not mounted');
    if(typeof ctx.sessions.flush==='function')await ctx.sessions.flush(session);
    return session;
  }
  const sync=singleFlight(async(list)=>{
    if(!Array.isArray(list))throw new Error('Invalid group list');
    const conf=readConfig();
    if(!conf.总开关 || conf.试运行 || !conf.自动接群)return;
    validateBindings(conf);
    let budget=3;
    for(const row of list){
      const group=String(row?.group_id||'');if(!/^\d+$/.test(group))continue;
      if(readObject(registry)[group] || (readConfig().绑定||[]).some(x=>x.类型==='群' && String(x.号码)===group))continue;
      if(budget--<=0)break;
      let p=pending();
      if(!p.records[group]){
        p.records[group]=p.reserve || fresh();delete p.reserve;writeObject(journal,p);
      }else metrics.recovered++;
      const record=p.records[group];
      await ensureRoom(record);
      const latest=readConfig();
      if(!latest.总开关 || latest.试运行 || !latest.自动接群)throw new Error('Group onboarding disabled during creation');
      const groups=readObject(registry);
      if(groups[group])continue;
      if(Object.values(groups).some(x=>x?.session===record.session))throw new Error('Reserved room already assigned');
      metrics.stage='sealing';
      sealGroupBindings(ctx,{...latest,绑定:[...(latest.绑定||[]),{类型:'群',号码:group,会话:record.session,门槛:true}]});
      groups[group]={session:record.session,name:String(row.group_name||'').slice(0,80),first:Date.now()};
      writeObject(registry,groups); // Publish only AFTER fresh-room privacy validation.
      p=pending();delete p.records[group];writeObject(journal,p);
      metrics.created++;
    }
    // Keep one genuinely empty room ready; never borrow the private visitor pool.
    let p=pending();
    if(!p.reserve){p.reserve=fresh();writeObject(journal,p);}
    const room=await ensureRoom(p.reserve);
    const bootstrap=new Set(['permission/preset','sandbox/mode','approval/policy','session/end-seed','model/selection','session/title']);
    if(room.header?.isSeeded || Number(room.header?.delegationDepth||0)!==0 || room.snapshotEvents().some(e=>!bootstrap.has(e.type)))
      throw new Error('Reserved group room is not empty');
    metrics.reserveReady=true;metrics.lastSuccessAt=Date.now();metrics.stage='ready';
  });
  return {sync:async list=>{try{return await sync(list);}catch(e){metrics.errors++;metrics.reserveReady=false;throw e;}},status:()=>({...metrics})};
}
