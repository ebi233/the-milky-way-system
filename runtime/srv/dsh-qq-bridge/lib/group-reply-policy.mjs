import {createHash} from 'node:crypto';
export function callsPaopao(text,sender,owner){
  // Callers supply only top-level text segments, never nicknames, quoted
  // forwards, file contents, image captions or model-created summaries.
  const plain=String(text||'').normalize('NFKC').replace(/泡泡(?:糖|机|浴|玛特|袖)|吹泡泡|肥皂泡泡/g,'');
  return /泡泡|浮鲸|小肥鱼|大肥鱼|鲸鱼娘/.test(plain) ||
    (String(sender)===String(owner)&&/^\d+$/.test(String(owner))&&/我的鱼/.test(plain));
}
// Match the delivered user event to transport evidence; text alone cannot grant a reply.
export function createInputEvidence({now=Date.now}={}){
  const pending=new Map();
  const signature=text=>createHash('sha256').update(String(text).trim()).digest('hex');
  return {
    queue(sid,text,evidence){
      const list=(pending.get(sid)||[]).filter(x=>now()-x.at<600000);
      list.push({...evidence,at:evidence.at??now(),signature:signature(text)});pending.set(sid,list.slice(-32));
    },
    take(sid,text){
      const list=(pending.get(sid)||[]).filter(x=>now()-x.at<600000),hash=signature(text);
      const i=list.findIndex(x=>x.signature===hash);const item=i<0?null:list.splice(i,1)[0];
      if(list.length)pending.set(sid,list);else pending.delete(sid);
      return item;
    },
    clear(){pending.clear()},
  };
}
export function groupReplyAllowed(decision,turn){
  if(!decision||decision.turn!==turn)return false;
  if(decision.declined || decision.invalidOutput)return false;
  if(!['qq','group-proactive'].includes(decision.input?.source))return false;
  if(decision.decided)return decision.reply===true;
  // A visible reply is itself a choice to speak. Require matching transport
  // evidence, not a name mention or a redundant model tool call. An explicit
  // decline above remains authoritative; desktop/manual turns stay blocked.
  return ['qq','group-proactive'].includes(decision.input?.source);
}

// A decision belongs to actual inbound evidence, never to assistant-created
// messages. Repeated gate calls cannot reverse a decline on the same input.
export function decideGroupReply(decision,reply){
  if(reply===false)decision.declined=true;
  decision.decided=true;
  decision.reply=reply===true && !decision.declined && !decision.invalidOutput;
  return decision.reply;
}
export function recordGroupOutput(decision,turn,text){
  if(!decision || decision.turn!==turn)return;
  // These are bridge-owned envelopes, not ordinary conversational prose.
  // Check all steps, not just the final sentence that would reach QQ.
  if(/【本群连续消息】|【本次自主活动的实际时间】/.test(String(text||''))){
    decision.invalidOutput=true;decision.reply=false;
  }
}
