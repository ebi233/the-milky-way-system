import {readFileSync,writeFileSync,mkdirSync,lstatSync,existsSync,openSync,closeSync,unlinkSync,renameSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {home,identity} from './access.js';
import {createGame,transition,rules,view,options} from './fusion-garden-engine.mjs';

function owner(agent){
  const who=identity(agent);
  if(who.role!=='owner'||who.inherited||!/^\d+$/.test(who.qq))throw Error('游戏仅限已绑定主账号的直接会话');
  return who;
}
function safe(path,directory=false){
  let s;try{s=lstatSync(path);}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()))throw Error('游戏存档路径异常');
  if(!directory&&s.size>1048576)throw Error('游戏存档过大');
}
function processStamp(pid){try{return readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ')[19];}catch{return null;}}
function takeLock(file){
  // DSH runs synchronous transactions in one Node process. PID and process-start
  // stamps allow recovery after a crashed writer, without expiring a live lock.
  try{const fd=openSync(file,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,start:processStamp(process.pid)}));return fd;}
  catch(e){if(e.code!=='EEXIST')throw e;}
  safe(file);const st=lstatSync(file),raw=readFileSync(file,'utf8');let data;
  try{data=JSON.parse(raw);}catch{throw Error('旧存档锁无法识别，未自动删除，请检查服务');}
  if(!Number.isInteger(data.pid)||data.pid<1)throw Error('存档锁信息异常');
  let dead=false;try{process.kill(data.pid,0);}catch(e){if(e.code==='ESRCH')dead=true;else throw Error('无法确认锁持有进程');}
  if(!dead&&data.start&&processStamp(data.pid)&&processStamp(data.pid)!==data.start)dead=true;
  if(!dead)throw Error('存档忙，请稍后status检查，勿连续重试');
  const latest=lstatSync(file);if(latest.ino!==st.ino||latest.dev!==st.dev||readFileSync(file,'utf8')!==raw)throw Error('存档锁已变化');
  unlinkSync(file);
  try{const fd=openSync(file,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,start:processStamp(process.pid)}));return fd;}
  catch{throw Error('存档忙，请稍后status检查');}
}
const summary=game=>({id:game.id,status:game.core.state,difficulty:game.difficulty,seconds:Math.round(game.core.time),kills:game.core.killed,wave:game.core.waveIndex+1});
export function playGarden(agent,args={},signal){
  signal?.throwIfAborted();const who=owner(agent);
  if(!args||typeof args!=='object'||Array.isArray(args)||JSON.stringify(args).length>16384)throw Error('游戏参数格式或大小异常');
  if(args.action==='help')return rules();
  const dir=join(home,'fusion-garden');safe(dir,true);
  const file=join(dir,createHash('sha256').update('owner:'+who.qq).digest('hex')+'.json');safe(file);
  const read=()=>{
    if(!existsSync(file))return {version:1,game:null,history:[]};
    const value=JSON.parse(readFileSync(file,'utf8'));
    if(value.version!==1||!Array.isArray(value.history)||!value.game)throw Error('存档格式异常，未覆盖');
    return value;
  };
  if(args.action==='status'||args.action===undefined)return view(read().game);
  if(args.action==='options')return options(read().game);
  if(args.action==='history'){const data=read();return {current:data.game?summary(data.game):null,completed:data.history,recentActions:data.game?.recentActions||[]};}
  mkdirSync(dir,{recursive:true,mode:0o700});safe(dir,true);
  const lock=file+'.lock';let fd;
  fd=takeLock(lock);
  try{
    safe(file);const data=read();
    if(args.action==='new'){
      if(data.game){
        if(args.gameId!==data.game.id||args.revision!==data.game.revision)throw Error('重新开局需当前gameId和revision');
        if(['playing','paused'].includes(data.game.core.state)&&args.abandon!==true)throw Error('已有未结束的局，继续玩或显式abandon后重开');
        data.history.push({...summary(data.game),status:['playing','paused'].includes(data.game.core.state)?'abandoned':data.game.core.state});
        data.history=data.history.slice(-10);
      }
      data.game=createGame({id:randomUUID(),seed:args.seed??randomBytes(4).readUInt32LE(),difficulty:args.difficulty??'normal'});
    }else{
      if(!data.game)throw Error('尚未开局，先new');
      data.game=transition(data.game,args);
    }
    signal?.throwIfAborted();const current=owner(agent);
    if(current.qq!==who.qq||current.session!==who.session)throw Error('会话绑定变化，未保存');
    const tmp=file+'.'+randomUUID()+'.tmp';let out;
    try{out=openSync(tmp,'wx',0o600);writeFileSync(out,JSON.stringify(data)+'\n');fsyncSync(out);closeSync(out);out=undefined;renameSync(tmp,file);}
    finally{if(out!==undefined)closeSync(out);if(existsSync(tmp))unlinkSync(tmp);}
    return view(data.game);
  }finally{closeSync(fd);unlinkSync(lock);}
}
const actionSchema={type:'string',required:true,enum:['plant','fuse','shovel','wait']};
const moveProperties={action:actionSchema,row:{type:'integer'},col:{type:'integer'},kind:{type:'string',enum:['sunflower','peashooter','wallnut','snowpea','repeater','cherrybomb','potatomine']},seconds:{type:'integer'}};
export function registerFusionGarden(tool){
  tool({name:'fusion_garden',description:'可选娱乐：开源植物大战僵尸+15条融合路线（非蓝飘飘原版）。help查规则，status看战场，options查能种/融合什么，history看战绩；new开局；plant/fuse/shovel或wait.seconds推进1～30秒，play最多6步。自动存档，变更需gameId+revision；失败先status/options，无需反复重试。仅主账号私聊，可自由选择玩或不玩。',
    parameters:{action:{type:'string',enum:['help','status','options','history','new','plant','fuse','shovel','wait','play','pause','resume']},
      gameId:{type:'string'},revision:{type:'integer'},difficulty:{type:'string',enum:['training','normal']},seed:{type:'integer'},abandon:{type:'boolean'},
      row:moveProperties.row,col:moveProperties.col,kind:moveProperties.kind,seconds:moveProperties.seconds,
      moves:{type:'array',items:{type:'object',properties:moveProperties,additionalProperties:false}}},
    async execute(args,exec){return playGarden(exec?.agent,args,exec?.signal);},
  });
}
