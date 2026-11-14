import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const endpoint='http://127.0.0.1:18182';
function config(){
 try{const c=JSON.parse(readFileSync(join(process.env.DSH_HOME||'/srv/dsh-cloud/home','screen-relay.json'),'utf8'));return c.enabled===true&&/^[a-f0-9]{64}$/.test(c.token)?c:null}catch{return null}
}
export const remoteConfigured=()=>Boolean(config());
export async function requestRemote(path,signal,{fetcher=fetch,settings=config()}={}){
 if(!settings)throw Error('LOCAL_SCREEN_OFFLINE');
 const nonce=randomUUID();
 try{
  const r=await fetcher(endpoint+path,{method:path==='/capture'?'POST':'GET',headers:{authorization:'Bearer '+settings.token,'content-type':'application/json'},...(path==='/capture'?{body:JSON.stringify({nonce})}:{}),redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(path==='/capture'?16000:2500)])});
  if(!r.ok)throw Error(r.status===409?'BUSY':'LOCAL_SCREEN_OFFLINE');
  const reader=r.body.getReader();let length=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8*1024*1024)throw Error('CAPTURE_OUTPUT_LIMIT');chunks.push(value)}}finally{await reader.cancel().catch(()=>{})}
  const d=JSON.parse(Buffer.concat(chunks).toString());
  if(!d.ok)throw Error('LOCAL_SCREEN_OFFLINE');
  if(path==='/status')return d;
  const data=Buffer.from(d.data||'','base64'),age=Date.now()-Date.parse(d.capturedAt);
  if(d.nonce!==nonce||!Number.isFinite(age)||age < -5000||age>20000||data.length<24||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||data.readUInt32BE(16)!==1280||data.readUInt32BE(20)!==800)throw Error('CAPTURE_FAILED');
  return {data,width:1280,height:800,capturedAt:d.capturedAt,engine:'windows-ssh-snapshot'};
 }catch(e){if(signal?.aborted)signal.throwIfAborted();if(['BUSY','CAPTURE_OUTPUT_LIMIT','CAPTURE_FAILED'].includes(e.message))throw e;throw Error('LOCAL_SCREEN_OFFLINE')}
}
export const captureRemote=signal=>requestRemote('/capture',signal);
export async function remoteStatus(signal){try{return await requestRemote('/status',signal)}catch{return {available:false}}}
