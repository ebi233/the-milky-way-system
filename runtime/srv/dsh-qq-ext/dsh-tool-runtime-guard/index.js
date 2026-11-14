import {writeFileSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LIMITS,installGuard} from './guard.mjs';

export const name='dsh-tool-runtime-guard';
export const inject=['tools','systemPrompt','shell'];
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";

export function apply(ctx){
  const home=process.env.DSH_HOME;
  const status={active:true,pid:process.pid,loadedAt:new Date().toISOString(),limits:LIMITS,
    shell:{wallSeconds:45,rssMiB:320,minAvailableMiB:160,cpuSeconds:30,maxConcurrent:1},timeouts:0,unconfirmedCancellations:0};
  const save=()=>{if(!home)return;try{
    const file=join(home,'tool-runtime-status.json'),tmp=file+'.tmp';
    writeFileSync(tmp,JSON.stringify(status,null,2)+'\n',{mode:0o600});renameSync(tmp,file);
  }catch{console.warn('[tool-runtime] status write failed');}};
  installGuard(ctx,LIMITS,event=>{status.lastEvent=event;if(event.timeout)status.timeouts++;if(!event.settled)status.unconfirmedCancellations++;save();});
  const shell=ctx.shell, original=shell.execute;
  const runner=join(dirname(fileURLToPath(import.meta.url)),'runner.py');
  let busy=false;
  const wrapped=async function(spec){
    if(busy)throw new Error('已有命令正在运行；为保留聊天资源，本次不再启动新命令');
    spec.signal?.throwIfAborted();
    busy=true;
    try{
      const proc=await original.call(this,{...spec,onExpiry:'kill',timeoutMs:Math.min(spec.timeoutMs??45000,45000),
        command:`exec /usr/bin/python3 ${quote(runner)} -- ${quote(spec.command)}`});
      // Release admission only after the actual subprocess has joined.
      Promise.resolve(proc.result()).then(()=>{busy=false;},()=>{busy=false;});
      return proc;
    }catch(error){busy=false;throw error;}
  };
  shell.execute=wrapped;
  ctx.on('dispose',()=>{if(shell.execute===wrapped)shell.execute=original;status.active=false;save();});
  save();
  console.log('[tool-runtime] deadlines, turn budget and bounded shell runner loaded');
}
