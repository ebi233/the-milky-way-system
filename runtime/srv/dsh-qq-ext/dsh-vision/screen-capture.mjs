import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {captureArgs} from './see-now-vendor/capture.js';
import {encodePng} from './see-now-vendor/png.js';

export const WIDTH=1280, HEIGHT=800;
export function findFFmpeg(){
  // Absolute Windows path: bare ffmpeg is redirected to Linux by the hybrid host.
  const candidates=['C:/ffmpeg/ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe'];
  return candidates.find(existsSync) || null;
}
export function oneFrameArgs(engine){
  if(!['ddagrab','gdigrab'].includes(engine))throw Error('INVALID_CAPTURE_ENGINE');
  const args=captureArgs({source:{kind:'screen',engine},width:WIDTH,height:HEIGHT,fps:1,engine,platform:'win32'}).slice(1);
  const at=args.indexOf('-vf')+1;
  args[at]=args[at].replace(`scale=${WIDTH}:${HEIGHT}:flags=area`,`scale=${WIDTH}:${HEIGHT}:flags=area:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`);
  args.splice(args.length-1,0,'-frames:v','1','-threads','1');
  return args;
}
export function captureFrame(ffmpegPath,engine,signal,{spawnProcess=spawn,timeoutMs=4000}={}){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const need=WIDTH*HEIGHT*3;
    const child=spawnProcess(ffmpegPath,oneFrameArgs(engine),{windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
    const chunks=[];let bytes=0,problem=null,done=false;
    const kill=()=>{try{child.kill('SIGKILL')}catch{}};
    const abort=()=>{problem=Error('CANCELLED');kill()};
    const timer=setTimeout(()=>{problem=Error('CAPTURE_TIMEOUT');kill()},timeoutMs);
    const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(result)};
    child.stdout.on('data',b=>{bytes+=b.length;if(bytes>need){problem=Error('CAPTURE_OUTPUT_LIMIT');kill();return}chunks.push(b)});
    // Never echo desktop/device details or unbounded ffmpeg stderr to the model.
    child.stderr.on('data',()=>{});
    child.on('error',()=>{problem ||= Error('CAPTURE_START_FAILED');kill();finish(problem)});
    child.on('close',code=>{
      if(problem)return finish(problem);
      if(code!==0||bytes!==need)return finish(Error('CAPTURE_FAILED'));
      const rgb=Buffer.concat(chunks);let max=0;for(let i=0;i<rgb.length;i+=97)max=Math.max(max,rgb[i]);
      if(max<3)return finish(Error('SCREEN_BLACK_OR_LOCKED'));
      finish(null,{data:encodePng(rgb,WIDTH,HEIGHT,{level:1}),width:WIDTH,height:HEIGHT,engine,capturedAt:new Date().toISOString()});
    });
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
export async function captureScreen(signal,{ffmpegPath=findFFmpeg(),platform=process.platform,capture=captureFrame}={}){
  if(platform!=='win32')throw Error('LOCAL_SCREEN_OFFLINE');
  if(!ffmpegPath)throw Error('WINDOWS_FFMPEG_MISSING');
  signal?.throwIfAborted();
  try{return await capture(ffmpegPath,'ddagrab',signal)}catch(e){
    signal?.throwIfAborted();if(e.message==='CANCELLED')throw e;
    // Capture-engine fallback only; never automatically retry a paid vision request.
    return await capture(ffmpegPath,'gdigrab',signal);
  }
}
