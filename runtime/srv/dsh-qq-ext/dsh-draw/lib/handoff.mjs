import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const qualityGuide='保留精致二次元插画的立体光影、自然材质、人物外观和柔和暖光。去掉背景及材质里树根状、龟裂状、网状、斑块状的伪纹理；不要用全图扁平化或模糊代替清理。头发需要连贯发束走向、选择性细发丝、自然遮挡和轮廓光。鲸尾保持有厚度但不膨胀的柔韧不透明皮肤，不做果冻、气球、乳胶亮面。背景建筑透视、植物枝叶与远景结构合理，细节密度低于主体。';
export const poseSuggestions=['平视半身：自然微笑或眨眼，手势清楚','三分之二侧脸回眸：注意肩颈转向与视线','轻微俯视自拍：手臂透视自然，避免极端广角','靠窗托腮：手掌支撑合理，保留眼神','坐姿轻抱尾鳍：两臂与尾巴遮挡清楚','站姿或行走回头：显示人物日常活动，尾巴自然随身'];
export function createHandoff(home){
 const dir=join(home,'image-handoff');
 const list=()=>{
  if(!existsSync(dir))return [];
  return readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>JSON.parse(readFileSync(join(dir,n),'utf8')));
 };
 function submit(args,who,signal){
  signal?.throwIfAborted();
  if(who?.role!=='owner'||who.inherited)throw Error('只接收主账号当前会话的生图需求');
  const prompt=String(args.prompt||'').trim();
  if(!prompt||prompt.length>12000)throw Error('画面描述需为 1～12000 字符');
  const dimension=n=>Math.round(Math.max(256,Math.min(Number(n)||1024,1536)));
  const width=dimension(args.width),height=dimension(args.height);
  const key=JSON.stringify([who.session,prompt,width,height,args.seed??null,new Date().toISOString().slice(0,10)]);
  const id=createHash('sha256').update(key).digest('hex').slice(0,32),file=join(dir,id+'.json');
  if(!existsSync(file)){
   if(list().filter(x=>x.status==='awaiting_codex').length>=40)throw Error('待处理队列已满，请先处理现有需求');
   mkdirSync(dir,{recursive:true,mode:0o700});
   const job={id,status:'awaiting_codex',engine:'chatgpt_builtin_handoff',createdAt:new Date().toISOString(),session:who.session,ownerQQ:who.qq,prompt,width,height,qualityGuide,poseSuggestions,reference:join(home,'appearance-assets/paopao-window-v3-20261101.png'),automatic:false};
   signal?.throwIfAborted();
   try{writeFileSync(file,JSON.stringify(job,null,2)+'\n',{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}
  }
  const job=JSON.parse(readFileSync(file,'utf8'));
  return {requestId:id,status:job.status,engine:job.engine,generated:job.status==='completed',path:job.status==='completed'?job.path:null,automatic:false,
   next:job.status==='completed'?'图片已回传，可使用该路径；不代表已经向 QQ 发送。':'需求已保存，等待用户在 Codex 当前聊天让维护助手接手内置生图。现在尚无图片；不能承诺自动重试、完成时间或额度恢复后补发。',qualityGuide,
   poseSuggestions,poseAdvice:'这些只是可选建议，按自己的创作意愿选用，不强制轮换姿势，也不改变外观设定。'};
 }
 return {submit,list};
}
