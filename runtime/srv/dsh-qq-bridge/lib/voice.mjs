import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,mkdirSync,statSync,realpathSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';import {randomUUID} from 'node:crypto';
const LIMIT=8*1024*1024;let busy=false;
const metrics={active:true,requests:0,succeeded:0,busy:false,lastCode:null,lastAt:null};
function inside(base,path){const rel=relative(resolve(base),resolve(path));return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);}
export function mapNapcatPath(path){
 if(typeof path!=='string')return '';
 if(path.startsWith('/app/.config/QQ/')){const mapped=resolve('/srv/napcat/qq',path.slice('/app/.config/QQ/'.length));return inside('/srv/napcat/qq',mapped)?mapped:'';}
 return path.startsWith('/srv/napcat/qq/')&&inside('/srv/napcat/qq',path)?path:'';
}
function readLocal(path){try{const p=mapNapcatPath(path);if(!p)return null;const real=realpathSync(p);if(!inside('/srv/napcat/qq',real))return null;const st=statSync(real);return st.isFile()&&st.size<=LIMIT?readFileSync(real):null;}catch{return null;}}
export function allowedAudioURL(value,trustedApi=false,napcat='http://127.0.0.1:3000'){
 try{const u=new URL(value);if(u.username||u.password)return false;if(trustedApi&&u.origin===new URL(napcat).origin)return true;return u.protocol==='https:'&&['qq.com','qq.com.cn','qpic.cn'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h));}catch{return false;}
}
async function download(url,signal,trusted,napcat){
 if(!allowedAudioURL(url,trusted,napcat))return null;
 const r=await fetch(url,{signal,redirect:'error'});if(!r.ok||Number(r.headers.get('content-length')||0)>LIMIT)return null;
 const reader=r.body.getReader();const parts=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT){await reader.cancel();return null;}parts.push(Buffer.from(value));}}finally{reader.releaseLock();}
 return Buffer.concat(parts);
}
export async function sourceBytes(segment,request,signal,napcat){
 const d=segment?.data||{},file=String(d.file||d.url||'');let record;
 const usable=file.length<=12*1024*1024&&(file.startsWith('base64://')||mapNapcatPath(file)||allowedAudioURL(file,false,napcat)||(/^[A-Za-z0-9_.=-]{1,2048}$/.test(file)&&!file.includes('..')));
 if(!usable)return null;
 try{record=await new Promise((resolve,reject)=>{
  const abort=()=>reject(Error('VOICE_TIMEOUT'));signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>request('get_record',{file,out_format:'wav'})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  if(signal.aborted)abort();
 });}catch{}
 signal.throwIfAborted();
 if(record){
  const data=readLocal(record.file||record.path);if(data)return data;
  if(typeof record.base64==='string'&&record.base64.length<12*1024*1024){const b=Buffer.from(record.base64.replace(/^data:[^,]*,/,''),'base64');if(b.length<=LIMIT)return b;}
  if(record.url){try{const b=await download(record.url,signal,true,napcat);if(b)return b;}catch{}}
 }
 if(file.startsWith('base64://')&&file.length<12*1024*1024){const b=Buffer.from(file.slice(9),'base64');if(b.length<=LIMIT)return b;}
 const url=String(d.url||(/^https?:/.test(file)?file:''));
 if(url){try{return await download(url,signal,false,napcat);}catch{}}
 return readLocal(file);
}
export function run(command,args,signal,timeoutMs,maxOutput=100000){
 return new Promise((resolve,reject)=>{
  signal.throwIfAborted();const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',PYTHONIOENCODING:'utf-8'}});
  let output='',size=0,done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',stop);error?reject(error):resolve(value);};
  const stop=()=>{child.kill('SIGKILL');finish(Error('VOICE_TIMEOUT'));};const timer=setTimeout(stop,timeoutMs);signal.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',v=>{size+=v.length;if(size>maxOutput)stop();else output+=v;});child.stderr.on('data',()=>{});child.on('error',()=>finish(Error('PROCESS_UNAVAILABLE')));child.on('close',code=>finish(null,{code,output}));if(signal.aborted)stop();
 });
}
function save(home){try{const file=join(home,'qq-bridge-asr/state.json');writeFileSync(file+'.tmp',JSON.stringify(metrics)+'\n',{mode:0o600});renameSync(file+'.tmp',file);}catch{}}
export async function transcribeVoice(segment,request,config,options={}){
 if(!config?.语音转写)return '[语音]';
 const home=options.home||'/srv/dsh-cloud/home',base=join(home,'qq-bridge-asr'),model=join(base,'models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17');
 if(!existsSync(join(base,'.venv/bin/python'))||!existsSync(join(model,'model.int8.onnx')))return '[语音（识别组件尚未就绪）]';
 if(busy)return '[语音（另一条语音正在转写，请稍后重发）]';
 busy=true;metrics.busy=true;metrics.requests++;metrics.lastAt=Date.now();save(home);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),35000),files=[];
 try{
  const bytes=await sourceBytes(segment,request,controller.signal,config.NapCat);if(!bytes?.length)throw Error('AUDIO_UNAVAILABLE');if(bytes.length>LIMIT)throw Error('AUDIO_TOO_LARGE');
  const folder=join(base,'temporary');mkdirSync(folder,{recursive:true,mode:0o700});const name=randomUUID(),input=join(folder,name+'.input'),output=join(folder,name+'.wav');files.push(input,output);writeFileSync(input,bytes,{mode:0o600,flag:'wx'});
  const converted=await run('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-threads','1','-i',input,'-t','121','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',output],controller.signal,7000);
  if(converted.code!==0)throw Error('AUDIO_CONVERSION_FAILED');
  const decoded=await run(join(base,'.venv/bin/python'),[join(base,'transcribe.py'),'--file',output,'--model-dir',model],controller.signal,28000);
  let value;try{value=JSON.parse(decoded.output.trim());}catch{throw Error('ASR_FAILED');}
  if(value.ok&&typeof value.text==='string'&&value.text.trim()){metrics.succeeded++;metrics.lastCode='OK';return '（语音）'+value.text.slice(0,12000);}
  metrics.lastCode=['DURATION_LIMIT','EMPTY_AUDIO','EMPTY_TRANSCRIPT'].includes(value.code)?value.code:'ASR_FAILED';
  return metrics.lastCode==='DURATION_LIMIT'?'[语音（超过2分钟，请分段发送）]':'[语音（没有识别出可靠文字，请重说或发文字）]';
 }catch(error){metrics.lastCode=['AUDIO_UNAVAILABLE','AUDIO_TOO_LARGE','AUDIO_CONVERSION_FAILED','VOICE_TIMEOUT'].includes(error.message)?error.message:'ASR_FAILED';return '[语音（这次转写未完成，请重发或补一句文字）]';}
 finally{clearTimeout(timer);controller.abort();busy=false;metrics.busy=false;save(home);for(const file of files){try{unlinkSync(file);}catch{}}}
}
