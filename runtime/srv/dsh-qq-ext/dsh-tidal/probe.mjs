import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readBounded,hash} from './store.mjs';
// An explicit authenticated maintenance request calls one fixed, tool-free fixture.
// Uses the mounted provider pipeline, not an alternative endpoint or credential.
export async function runTidalProbe(ctx,persona,home,signal,{caseId,variant}){
 if(!['baseline','compact'].includes(variant)||!['0','1'].includes(caseId))throw Error('Invalid probe case');
 const data=readBounded(join(home,'tidal-state/probe.private.json'),65536);
 if(data.version!==1||hash(persona.text)!==data.expectedPersonaHash)throw Error('Probe persona drift');
 const route=readBounded(join(home,'model-routing.json'),65536);
 if(!route.enabled||route.chatModel!=='deepseek-flash')throw Error('Probe only supports current Flash route');
 const fixture=data.cases[Number(caseId)],system=variant==='compact'?data.candidatePersona:persona.text;
 const messages=fixture.messages.map(m=>({id:randomUUID(),role:m.role,source:{kind:'plugin',plugin:'paopao-tidal-probe'},content:[{type:'text',text:m.content}]}));
 let text='',finish=null;
 for await(const c of ctx.llm.stream({provider:'deepseek-official',model:route.chatModel,reasoningEffort:'high',purpose:'paopao-tidal-probe',system,messages,tools:[],maxTokens:1536,signal})){
  if(c.type==='text-delta')text+=c.text||'';
  if(c.type==='finish')finish=c.reason?.kind||'unknown';
  if(text.length>8000)throw Error('Probe output bound');
 }
 return {caseId,variant,model:route.chatModel,effort:'high',systemCharacters:system.length,text,finish,complete:finish==='stop'&&Boolean(text),QQSends:0,sessionWrites:0,toolExecutions:0};
}
