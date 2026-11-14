import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export function chooseFrames(delays) {
  const timeline=[]; let duration=0;
  for (let i=0;i<delays.length;i++) {timeline.push({page:i,ms:duration});duration+=Math.max(20,Number(delays[i])||100);}
  const out=[];
  for(const target of [0,duration/3,duration*2/3,Math.max(0,duration-1)]) {
    const frame=timeline.findLast(f=>f.ms<=target)||timeline[0];
    if(frame&&!out.some(f=>f.page===frame.page))out.push(frame);
  }
  return {frames:out,duration};
}

// Isolated process: one decoder, bounded input/output/pixels/pages and hard timeout.
export async function extractFrames(data, timeoutMs=3000) {
  return new Promise((resolve,reject)=>{
    if(typeof data!=='string'||data.length>7*1024*1024) return reject(Error('ANIMATION_INPUT_LIMIT'));
    const child=spawn(process.execPath,['--max-old-space-size=96',fileURLToPath(import.meta.url),'--worker'],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{PATH:process.env.PATH}});
    let output='',bytes=0,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('ANIMATION_TIMEOUT'));},Math.max(1,timeoutMs));
    child.stdout.on('data',c=>{bytes+=c.length;if(bytes>4*1024*1024){child.kill('SIGKILL');finish(Error('ANIMATION_OUTPUT_LIMIT'));}else output+=c;});
    child.on('error',()=>finish(Error('ANIMATION_DECODER_UNAVAILABLE')));
    child.on('close',code=>{try{if(code!==0)throw Error();const r=JSON.parse(output);if(!Array.isArray(r.frames)||r.frames.length>4)throw Error();finish(null,r);}catch{finish(Error('ANIMATION_DECODE_FAILED'));}});
    child.stdin.on('error',()=>{});child.stdin.end(data);
  });
}

async function worker() {
  let input='',n=0;
  for await(const c of process.stdin){n+=c.length;if(n>7*1024*1024)throw Error();input+=c;}
  const data=Buffer.from(input,'base64');if(data.length>5*1024*1024)throw Error();
  const require=createRequire('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/package.json');
  const sharp=require('sharp');sharp.concurrency(1);sharp.cache(false);
  const options={failOn:'error',limitInputPixels:10000000};
  const meta=await sharp(data,options).metadata();
  const pages=meta.pages||1;if(pages<2){process.stdout.write(JSON.stringify({frames:[],duration:0}));return;}
  if(pages>300||!['gif','webp'].includes(meta.format))throw Error();
  const selected=chooseFrames(Array.from({length:pages},(_,i)=>meta.delay?.[i]||100));
  const frames=[],hashes=new Set();
  for(const frame of selected.frames){
    const image=await sharp(data,{...options,page:frame.page,pages:1}).rotate().resize({width:768,height:768,fit:'inside',withoutEnlargement:true}).webp({quality:78}).toBuffer();
    const hash=createHash('sha256').update(image).digest('hex');if(hashes.has(hash))continue;hashes.add(hash);
    frames.push({...frame,data:image.toString('base64')});
  }
  process.stdout.write(JSON.stringify({frames,duration:selected.duration}));
}
if(process.argv[2]==='--worker')worker().catch(()=>{process.exitCode=1;});
