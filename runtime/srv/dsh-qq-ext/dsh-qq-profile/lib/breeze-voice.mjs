import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const URL='http://127.0.0.1:18187';
export function breezeSettings(){return {current:{engine:'breeze-local',voice:'paopao-bright-v1',description:'成年女声，保留参考音色，略明亮轻快'},modes:['speech','singing'],singing:'短段清唱尝试',requiresLocalComputer:true,fallback:false};}
export async function breezeVoice(args,signal,{fetcher=fetch,timeoutMs=185000}={}){
  const mode=args.mode??'speech',emotion=args.emotion??'normal',text=String(args.text??'').trim();
  if(!['speech','singing'].includes(mode)||!['normal','happy','gentle','sad','cold','angry','tease'].includes(emotion))throw Error('未知语音模式或情绪');
  if(!text||[...text].length>(mode==='singing'?60:80))throw Error('Breeze语音限80字，短段清唱限60字；请缩短后再调用');
  signal?.throwIfAborted();
  let token;
  try{token=JSON.parse(readFileSync(join(process.env.DSH_HOME||'/srv/dsh-cloud/home','breeze-relay.json'),'utf8')).token;if(!token)throw Error();}
  catch{throw Error('Breeze本地通道尚未配置，未换声、未发送');}
  const headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'};
  const nonce=randomUUID();let started=false,completed=false;
  const budget=AbortSignal.timeout(timeoutMs);
  const active=signal?AbortSignal.any([signal,budget]):budget;
  try{
    const health=await fetcher(URL+'/status',{headers,signal:AbortSignal.any([active,AbortSignal.timeout(4000)])});
    if(!health.ok)throw Error('OFFLINE');
    const status=await health.json();
    if(status.engine!=='breeze-local'||!status.available)throw Error('OFFLINE');
    if(status.busy)throw Error('BUSY');
    active.throwIfAborted();started=true;
    const res=await fetcher(URL+'/synthesize',{method:'POST',headers,body:JSON.stringify({nonce,text,mode,emotion}),signal:active});
    if(!res.ok){throw Error(res.status===409?'BUSY':'SYNTHESIS_FAILED');}
    // WAV is at most 20 seconds / 960KB; cap responses before allocation grows.
    const reader=res.body.getReader();const chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1500000)throw Error('INVALID_AUDIO');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));active.throwIfAborted();
    const buffer=Buffer.from(result.audio||'','base64');
    if(!result.ok||result.nonce!==nonce||result.engine!=='breeze-local'||result.mode!==mode||buffer.length<1024||buffer.length>1000000||buffer.toString('ascii',0,4)!=='RIFF'||buffer.toString('ascii',8,12)!=='WAVE'||createHash('sha256').update(buffer).digest('hex')!==result.sha256)throw Error('INVALID_AUDIO');
    completed=true;return {buffer,voice:result.voice,seconds:result.seconds};
  }catch(error){
    if(active.aborted)throw Error('Breeze语音已取消或生成超时，未发送；本轮不要重试');
    if(error.message==='BUSY')throw Error('Breeze正在生成另一段声音，本次未生成、未发送；不要立刻重复调用');
    throw Error('Breeze本地语音不可用或合成失败，未换声、未发送。请确认电脑已开机且语音通道在线');
  }finally{
    if(started&&!completed)await fetcher(URL+'/cancel',{method:'POST',headers,body:JSON.stringify({nonce}),signal:AbortSignal.timeout(1200)}).catch(()=>{});
  }
}
