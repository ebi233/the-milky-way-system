import {cleanOutgoingText} from '../../../dsh-qq-bridge/lib/output-control.mjs';
import {isMaintenanceMessage,isIdentityDriftReply} from '../../dsh-persona-integrity/maintenance-memory.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const time=e=>typeof e.time==='string'?Date.parse(e.time):Number(e.time??e.timestamp??e.at);
const body=(m,human=false)=>{
  const text=typeof m?.content==='string'?m.content:(m?.content||[]).filter(b=>b?.type==='text').map(b=>b.text||'').join('\n');
  let result=text.split('\n\n（这台机器只把正文')[0].split('\n\n（群消息：')[0].trim();
  if(human){
    // Forwarded speakers and image-observer descriptions are not statements
    // authored by this QQ participant. Keep these out until typed ingestion exists.
    // QQ may prepend the sender's caption to a forwarded transcript. Only
    // that prefix is their own statement; nested speakers are not this user.
    // Match a whole header at a line boundary, not an inline mention of it.
    const forwarded=result.search(/^[\t ]*\[合并转发的聊天记录[^\r\n]*\][\t ]*\r?$/m);
    if(forwarded>=0)result=result.slice(0,forwarded).trim();
    if(/^\[合并转发的聊天记录/.test(result))return '';
    if(/^【本群连续消息】/.test(result))return '';
    const attachment=result.search(/^[\t ]*（(?:老哥发了 \d+ 张图|系统图片观察结果|系统文件|系统语音)/m);
    if(attachment>=0)result=result.slice(0,attachment).trim();
    result=result.replace(/^\[引用了一条消息\]\s*/,'').trim();
    if(/^（老哥发来了图片，没有配字）$/.test(result))return '';
  }
  return result;
};
// Shared with memory writes so an attachment/forward cannot become user evidence.
export function humanRecordText(message){return body(message,true);}
function trustedNotice(m){
  const s=m?.source;
  return s?.kind==='agent-instructions'&&s.form==='instructions' ||
    s?.kind==='model-selection'&&s.form==='notice' ||
    s?.kind==='compact-checkpoint'&&typeof s.compactionId==='string'&&s.compactionId.length>0;
}
// Incremental projection; the caller may feed complete records from a stream.
// Raw protocol storage is not rewritten. Never project reasoning/tool outputs.
export function createVisibleProjector(session,{allowUserAfter=null,skipFirstUserTurn=false,plainDialogueOnly=false}={}) {
  let header=false,turn=null,lastSeq=-1;
  return {push(e){
    if(!header){
      if(e.type!=='session'||e.id!==session||e.version!==4)fail('INVALID_SESSION_HEADER');
      header=true;return [];
    }
    if(!Number.isInteger(e.seq)||e.seq<=lastSeq)fail('INVALID_SOURCE_SEQUENCE');
    lastSeq=e.seq;
    const out=[];
    if(e.type==='turn/start'){turn={id:e.data?.turn,qq:false,mixed:false,interrupted:false,replies:[],seen:new Set()};return out;}
    if(e.type==='tool/call'&&plainDialogueOnly&&turn){turn.mixed=true;return [];}
    if(e.type==='user/message'){
      const m=e.data?.message||e.data||{},source=m.source?.kind;
      const valid=source==='qq'||source==='user'&&!isMaintenanceMessage(m)&&Number.isFinite(allowUserAfter)&&time(e)>=allowUserAfter&&(!skipFirstUserTurn||Number(turn?.id)>1);
      if(plainDialogueOnly&&turn&&(/\[合并转发|\[引用了一条消息\]|系统图片观察|系统文件|系统语音|老哥发了.{0,8}张图/.test(body(m))||(Array.isArray(m.content)&&m.content.some(b=>b.type!=='text'))))turn.mixed=true;
      if(valid){
        const text=body(m,true);
        if(text&&Number.isFinite(time(e)))out.push({role:'friend',text,at:time(e),seq:e.seq,turn:turn?.id??null,messageId:m.id||null,origin:source==='qq'?'qq':'local_or_bridge',delivery:'incoming_record'});
        if(turn)turn.qq=true;
      }else if(turn&&!trustedNotice(m))turn.mixed=true;
    }
    if(e.type==='assistant/message'&&turn&&e.data?.turn===turn.id){
      if(e.data?.interrupted){turn.interrupted=true;turn.replies=[];return out;}
      const m=e.data?.message||e.data,text=cleanOutgoingText(body(m));
      if(text&&!isIdentityDriftReply(text)&&!turn.seen.has(text)&&Number.isFinite(time(e))){
        turn.seen.add(text);
        turn.replies.push({role:'paopao',text,at:time(e),seq:e.seq,turn:turn.id,messageId:m.id||null,origin:'visible_generation',delivery:'generated_not_delivery_receipt'});
      }
    }
    if(e.type==='turn/end'){
      if(turn?.qq&&!turn.mixed&&!turn.interrupted&&e.data?.turn===turn.id&&e.data?.reason?.kind==='completed')out.push(...turn.replies);
      turn=null;
    }
    return out;
  },checkpoint(){return {lastCompleteSeq:lastSeq,openTurn:turn?.id??null};}};
}
export function projectVisibleEvents(events,session,options){
  const p=createVisibleProjector(session,options);
  return events.flatMap(e=>p.push(e)).sort((a,b)=>a.at-b.at||a.seq-b.seq);
}
