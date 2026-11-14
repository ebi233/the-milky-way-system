import {StringDecoder} from 'node:string_decoder';
const fail=code=>{throw Object.assign(new Error(code),{code});};
// Bound decompressed data, individual events, and retained visible records
// separately. Large reasoning/tool payloads never become recall results.
export async function projectJsonlStream(stream,projector,{signal,maxBytes=256*1024*1024,maxLineBytes=16*1024*1024,maxVisibleBytes=12*1024*1024,maxMessages=30000}={}){
  const decoder=new StringDecoder('utf8');let pending='',bytes=0,visibleBytes=0,lines=0;const messages=[];
  function line(raw){
    if(!raw.trim())return;
    if(Buffer.byteLength(raw)>maxLineBytes)fail('HISTORY_TOO_LARGE');
    let event;try{event=JSON.parse(raw);}catch{fail('HISTORY_FORMAT_INVALID');}
    lines++;
    for(const m of projector.push(event)){
      visibleBytes+=Buffer.byteLength(m.text||'');
      if(visibleBytes>maxVisibleBytes||messages.length>=maxMessages)fail('HISTORY_TOO_LARGE');
      messages.push(m);
    }
  }
  for await(const chunk of stream){
    signal?.throwIfAborted();bytes+=chunk.length;
    if(bytes>maxBytes)fail('HISTORY_TOO_LARGE');
    pending+=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
    let from=0,pos;
    while((pos=pending.indexOf('\n',from))!==-1){line(pending.slice(from,pos));from=pos+1;}
    pending=pending.slice(from);
    if(Buffer.byteLength(pending)>maxLineBytes)fail('HISTORY_TOO_LARGE');
  }
  pending+=decoder.end();if(pending.trim())line(pending);
  signal?.throwIfAborted();if(!lines)fail('HISTORY_FORMAT_INVALID');
  return messages.sort((a,b)=>a.at-b.at||a.seq-b.seq);
}
