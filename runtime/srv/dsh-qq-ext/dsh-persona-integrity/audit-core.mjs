import {createHash} from 'node:crypto';
import {inputReceipt} from './input-receipt.mjs';
import {isMaintenanceMessage} from './maintenance-memory.mjs';
import {cleanOutgoingText,splitReplyBubbles} from '../../dsh-qq-bridge/lib/output-control.mjs';
export const sha=s=>createHash('sha256').update(String(s)).digest('hex');
export function visibleMetrics(text){
 const cleaned=cleanOutgoingText(text),bubbles=splitReplyBubbles(cleaned),code=/```|~~~/u.test(cleaned);
 const control=/\[(?:PAOPAO_SILENT|PAOPAO_[A-Z_]+)\]|^\s*[（(](?:决定回复|回复策略|接下来(?:我)?(?:应该|需要)|等待(?:用户|老哥)(?:回复|继续))/mu.test(cleaned);
 return {characters:cleaned.length,bubbles:bubbles.length,longestBubble:Math.max(0,...bubbles.map(x=>x.length)),controlMarkerSuspected:control,
  longUnbroken:!code&&bubbles.length===1&&cleaned.length>400,
  assistantVoiceSuspected:/(?:我是|作为|我会当)(?:你(?:的)?(?:专属)?)?(?:AI助手|人工智能助手|营养管家|贴心小助手)/u.test(cleaned),
  voluntarySilence:!cleaned&&text.includes('[PAOPAO_SILENT]'),generatedOnly:true};
}
// Consume only text protocol fields; never save reasoning or tool arguments.
export async function* observeVisible(stream,complete){
 const blocks=new Map();let finish=null,truncated=false,thrown=null;
 try{
  for await(const chunk of stream){
   if(chunk.type==='text-delta'){
    const key=chunk.index??0,value=(blocks.get(key)||'')+(chunk.text||'');
    if(value.length>16000)truncated=true;blocks.set(key,value.slice(0,16000));
   }
   if(chunk.type==='block-end'&&chunk.block?.type==='text'){
    const value=chunk.block.text||'';if(value.length>16000)truncated=true;blocks.set(chunk.index??0,value.slice(0,16000));
   }
   if(chunk.type==='finish')finish=chunk.reason?.kind||'unknown';
   yield chunk;
  }
 }catch(e){thrown=e;throw e;}
 finally{try{complete({text:[...blocks.values()].join('\n'),finish:thrown?'exception':finish||'interrupted',truncated})}catch{}}
}
export function traceSnapshot(options,agent,persona){
 const events=agent.session.snapshotEvents(),checkpoint=events.findLast(e=>e.type==='compaction/summary');
 const summary=(checkpoint?.data?.summary||[]).filter(x=>x.type==='text').map(x=>x.text||'').join('\n');
 const sys=options.system??(options.messages||[]).findLast(m=>m.role==='system')?.content?.filter(x=>x.type==='text').map(x=>x.text||'').join('\n')??'';
 const last=(options.messages||[]).findLast(m=>m.role==='user'&&['qq','user'].includes(m.source?.kind)&&!isMaintenanceMessage(m));
 return {sessionId:options.sessionId,requestMessageId:last?.id||null,turn:events.findLast(e=>e.type==='turn/start')?.data?.turn??null,
  provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,purpose:options.purpose||'conversation',
  personaRevision:persona.revision,personaMode:persona.mode,personaHash:sha(persona.text),inputSystemHash:sha(sys),
  inputReceipt:inputReceipt(options,events),personaSystemMatches:sha(sys.trim())===sha(persona.text.trim()),
  checkpointSeq:checkpoint?.seq??null,checkpointHash:summary?sha(summary):null,checkpointVersion:summary.includes('[paopao-checkpoint-v2]')?2:summary?1:0};
}
export function publicTargets(conf,guests={},groups={}){
 const targets=new Map();
 const add=(sid,kind)=>{if(!/^session-[\w-]+$/.test(sid||''))return;const old=targets.get(sid);targets.set(sid,{sessionId:sid,kind:old&&old.kind!==kind?'conflict':kind});};
 for(const r of conf.绑定||[])if(r.类型==='群'||r.类型==='私聊'&&String(r.号码)!==String(conf.主人号码))add(r.会话,r.类型==='群'?'group':'guest');
 for(const [qq,r] of Object.entries(guests))if(String(qq)!==String(conf.主人号码))add(r?.session,'guest');
 for(const r of Object.values(groups))add(r?.session,'group');
 return [...targets.values()];
}
export function coverageStatus(rows){
 const checked=rows.filter(x=>x.promptChecked).length,mounted=rows.filter(x=>x.historyChecked).length;
 return {registered:rows.length,promptChecked:checked,historyChecked:mounted,promptStatus:!rows.length?'not_applicable':checked===rows.length?'complete':'incomplete',historyStatus:!rows.length?'not_applicable':mounted===rows.length?'complete':'partial',rooms:rows};
}
