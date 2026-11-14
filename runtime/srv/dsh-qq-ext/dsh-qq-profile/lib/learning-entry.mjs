import {expressionLibrary} from '../../dsh-long-memory/lib/expression-library.mjs';
// Compatibility adapter only. No global Markdown memory or additional store.
import {createHash} from 'node:crypto';
import {identity} from '../../dsh-long-memory/lib/access.js';
import {manageFact} from '../../dsh-long-memory/lib/conversation-notes.mjs';
import {notebook} from '../../dsh-long-memory/lib/personal-notebook.mjs';

export const learningEntryPolicy='scoped-expression-or-reflection-v2';
export async function writeLearning(args={},exec={}){
  exec.signal?.throwIfAborted();
  const agent=exec.agent,who=identity(agent);
  // Check at the entry itself too; do not rely only on the global tool guard.
  if(who.role!=='owner'||who.inherited||who.conflict)
    throw Error('write_learning 仅限主账号直接私聊；群聊和访客请用本会话的 conversation_fact。');
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('记事参数无效');
  const text=typeof args.text==='string'?args.text.trim():'';
  if(!text||text.length>300)throw Error('text 需为 1～300 字的文字');
  const kind=args.kind??'fact';
  if(kind==='fact'){
    const evidence=typeof args.evidence==='string'?args.evidence.trim():'';
    if(typeof args.key!=='string'||!args.key.trim()||evidence.length<4||evidence.length>200)
      throw Error('事实需提供稳定 key 和当前会话最近真人原话 evidence（4～200字）；不会将猜测降级存入其他位置。');
    // Persist the actual quote rather than the unverified model paraphrase.
    // manageFact checks authorship, rejects forwarded/tool/maintenance material,
    // and saves under the currently bound conversation with correction support.
    const result=manageFact(agent,{action:'save',key:args.key,text:evidence,evidence,
      confidence:'explicit',correction:args.correction===true,ttlDays:args.ttlDays});
    return {...result,policy:learningEntryPolicy,destination:'conversation_fact',
      verification:'human_quote_not_semantic_entailment',personaChanged:false};
  }
  if(!['lesson','reflection','idea'].includes(kind))throw Error('kind 仅支持 fact、lesson、reflection、idea');
  if(kind==='lesson'){
    if(!args.sourceId||!args.quote||!args.scene)return {saved:false,destination:'expression_library',nextTool:'expression_library',nextArguments:{action:'materials'},reason:'说话技巧写入表达库；先 materials 找原文，再 learn。未写入日记。'};
    return {...await expressionLibrary(agent,{action:'learn',sourceId:args.sourceId,quote:args.quote,scene:args.scene,lesson:text,sourceKind:args.sourceKind},exec.signal),destination:'expression_library',policy:learningEntryPolicy,personaChanged:false};
  }
  // Legacy "lesson" is a subjective reflection, never a personality rule.
  const entryKind=kind==='idea'?'idea':'reflection';
  const title=args.title===undefined?(entryKind==='idea'?'一个想法':'随手感想'):args.title;
  const events=agent?.session?.snapshotEvents?.()||[];
  const last=events.findLast(e=>e.type==='user/message'&&['qq','user'].includes((e.data?.message||e.data)?.source?.kind));
  const lastId=(last?.data?.message||last?.data)?.id||null;
  // A replay in the same human turn gets the same notebook receipt.
  const requestId=args.requestId??('learning:'+createHash('sha256').update(JSON.stringify([who.session,lastId,entryKind,title,text])).digest('hex').slice(0,48));
  const result=notebook(agent,{action:'write',kind:entryKind,title,text,requestId},exec.signal);
  return {...result,policy:learningEntryPolicy,destination:'personal_notebook',
    verification:'subjective_entry_not_user_fact',personaChanged:false};
}

export function registerLearningEntry(tool){
  tool({name:'write_learning',isConcurrencySafe:()=>false,
    description:'旧笔记兼容入口，仅主账号直接私聊。fact 必须有稳定 key 和最近真人原话 evidence，按现有 conversation_fact 校验，只保存原话；明确纠正时沿用 key 并设 correction=true。lesson 为表达学习，走 expression_library（需要sourceId、quote、scene，先materials获取）；reflection 为自己的感想，idea 为想法，后两者写入私人日记，不作为用户事实或人格规则。无需每天写。',
    parameters:{text:{type:'string'},kind:{type:'string',enum:['fact','lesson','reflection','idea']},
      sourceId:{type:'string'},quote:{type:'string'},scene:{type:'string'},sourceKind:{type:'string',enum:['owner_feedback','public_excerpt']},
      key:{type:'string',description:'fact 必填，同一事实及其纠正沿用相同 key'},
      evidence:{type:'string',description:'fact 必填，最近真人原话4～200字，不用模型概括或转发内容'},
      correction:{type:'boolean'},ttlDays:{type:'number'},title:{type:'string'},
      requestId:{type:'string',description:'感想可选防重标识，同次操作重试沿用'}},
    execute:(args,exec)=>writeLearning(args,exec)});
}
