import {renderedCheckpoint,checkpointViewPolicy} from './checkpoint-view.mjs';
import {createHash} from 'node:crypto';
import {parseCheckpoint} from './summary-evidence.mjs';
export const inputReceiptPolicy='projected-input-receipts-v1';
const hash=v=>createHash('sha256').update(v).digest('hex');
const text=m=>(Array.isArray(m?.content)?m.content:[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
const id=v=>typeof v==='string'&&/^[\w:./-]{1,180}$/.test(v)?v:null;
const seq=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const memories=new Set(['conversation_recall','conversation_fact','conversation_topic','conversation_preference','list_long_memory','recall_archive','friend_conversation_recall','self_persona','personal_notebook']);
function reference(item,fallbackSession){
 const evidence=item.evidence&&typeof item.evidence==='object'?item.evidence:{};
 return {id:id(item.id),sourceSession:id(item.sourceSession)||fallbackSession,
  seq:seq(item.sourceSeq??item.seq??evidence.seq),messageId:id(item.messageId??evidence.messageId),
  at:typeof (item.at??evidence.at)==='number'?(item.at??evidence.at):null,
  basis:id(item.evidenceBasis??item.verification??item.confidence??item.basis),superseded:item.superseded===true};
}
export function inputReceipt(options,events=[]){
 const messages=options.messages||[],calls=new Map(events.filter(e=>e.type==='tool/call').map(e=>[e.data?.callId,e]));
 const results=new Map(events.filter(e=>e.type==='tool/result').map(e=>[e.data?.message?.id,e]));
 const manifest=[],checkpoints=[],memoryReads=[],counts={messages:messages.length,characters:0,systemMessages:0,toolMessages:0,checkpointMessages:0};
 const digest=createHash('sha256');let omittedMessages=0;
 for(const m of messages){
  const raw=text(m),kind=id(m.source?.kind),item={id:id(m.id),role:id(m.role),source:kind,characters:raw.length,sha256:hash(raw)};
  counts.characters+=raw.length;if(m.role==='system')counts.systemMessages++;if(m.role==='tool')counts.toolMessages++;
  digest.update(JSON.stringify([item.id,item.role,kind,item.sha256])+'\n');
  if(manifest.length<128)manifest.push(item);else omittedMessages++;
  if(kind==='compact-checkpoint'){
   counts.checkpointMessages++;let parsed=null;try{if(raw.length<=131072)parsed=renderedCheckpoint(m)||parseCheckpoint(raw)}catch{}
   checkpoints.push({messageId:item.id,sha256:item.sha256,characters:raw.length,version:parsed?2:1,
    presentation:renderedCheckpoint(m)?checkpointViewPolicy:'structured',sourceSession:id(parsed?.scope),personaRevision:id(parsed?.personaRevision),policy:id(parsed?.policy),itemCount:parsed?.items?.length??null,
    references:parsed?Object.entries(parsed.sources||{}).slice(0,64).map(([key,s])=>({...reference(s,id(parsed.scope)),id:id(key)})):[],
    referencesTruncated:parsed?Object.keys(parsed.sources||{}).length>64:false});
  }
  if(m.role!=='tool')continue;
  const call=calls.get(m.source?.callId),name=call?.data?.name;if(!memories.has(name))continue;
  const result=results.get(m.id);let value=null;try{if(raw.length<=131072)value=JSON.parse(raw)}catch{}
  const listed=value?['items','facts','corrections','messages','hits'].flatMap(key=>Array.isArray(value[key])?value[key]:[]).filter(x=>x&&typeof x==='object'):[];
  const source=id(value?.sourceSession)||options.sessionId;
  memoryReads.push({tool:name,callId:id(m.source?.callId),messageId:item.id,resultSeq:seq(result?.seq),sha256:item.sha256,
   ok:value?.ok===true,projection:id(value?.projection),sourceSession:id(source),references:listed.slice(0,48).map(x=>reference(x,id(source))),
   referenceCount:listed.length,referencesTruncated:listed.length>48,parsed:Boolean(value),characters:raw.length});
 }
 const system=typeof options.system==='string'?options.system:'';digest.update(JSON.stringify(['system-option',hash(system)]));
 return {policy:inputReceiptPolicy,stage:'after-paopao-projection-before-provider',visibleInputHash:digest.digest('hex'),counts,manifest,omittedMessages,
  checkpoints:checkpoints.slice(-8),memoryReads:memoryReads.slice(-16),omittedCheckpoints:Math.max(0,checkpoints.length-8),omittedMemoryReads:Math.max(0,memoryReads.length-16),
  toolSchemaHash:hash(JSON.stringify(options.tools||[])),toolCount:Array.isArray(options.tools)?options.tools.length:null,
  excludes:['reasoning','raw_text','tool_arguments','images_audio','provider_wire_transform']};
}
