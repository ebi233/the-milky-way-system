import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {candidateRoots} from '../dsh-draw/lib/hostdeps.mjs';
import {registerMemoryRecall,recallConversation} from '../dsh-long-memory/lib/memory-read.mjs';
import {readRecentDialogue,isRecentQuery,recentDialoguePolicy} from '../dsh-long-memory/lib/recent-dialogue.mjs';
import {sha} from './audit-core.mjs';
async function assemblerClass(){
 for(const root of candidateRoots())for(const rel of ['dsh-llm/lib/index.js','dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js']){
  const file=join(root,rel);if(fs.existsSync(file))return (await import(pathToFileURL(file).href)).BlockAssembler;
 }
 throw Error('Host LLM assembler unavailable');
}
// Explicit diagnostic. Synthetic conversation only, read-only fixture tools;
// no live history queries, no deliveries, no session writes or hidden reasoning log.
export async function runRecentDialogueProbe(ctx,agent,persona,home,signal){
 const cfg=await ctx.llm.resolveCallConfig(agent.session.requestHeader()?.config??agent.options);
 const Assembler=await assemblerClass(),session=agent.session.header.id;
 const report={policy:recentDialoguePolicy,startedAt:Date.now(),model:cfg.model,reasoningEffort:cfg.reasoningEffort,
  personaHash:sha(persona.text),isolated:true,syntheticConversation:true,QQSends:0,sessionWrites:0,archiveReads:0,modelCalls:0,results:[]};
 let spec;registerMemoryRecall(t=>{spec=t});
 const schema={name:spec.name,description:spec.description,parameters:{type:'object',properties:spec.parameters,additionalProperties:false}};
 const tools=[schema,{name:'recall_archive',description:'查具体旧事用 mode=search 和具体话题；核对刚才指代用 conversation_recall 的 recent 层或 mode=recent。裸指代只返回当前原话，不查旧档案。',parameters:{type:'object',properties:{query:{type:'string'},mode:{type:'string',enum:['search','recent']},limit:{type:'number'},days:{type:'number'}},additionalProperties:false}}];
 const cases=[
  {id:'ambiguous-reference',dialogue:[['user','那是别人的鱼，我只有你一条'],['assistant','我以为你又养了一条呢'],['user','你又忘啦']]},
  {id:'ordered-recent-recall',dialogue:[['user','昨天说想出门，今天我改主意了，就在家待着'],['assistant','行，一起窝着'],['user','把我刚才说的那句找出来，今天我到底打算去哪里？']]}
 ];
 const call=async messages=>{
  const assembled=new Assembler();report.modelCalls++;
  for await(const chunk of ctx.llm.stream({provider:cfg.provider,model:cfg.model,reasoningEffort:cfg.reasoningEffort,system:persona.text,messages,tools,maxTokens:2048,purpose:'paopao-recent-dialogue-test',signal}))assembled.push(chunk);
  const blocks=assembled.blocks();
  return {message:{id:randomUUID(),role:'assistant',source:{kind:'model',provider:cfg.provider,model:cfg.model,...(assembled.replayState?{replayState:assembled.replayState}:{})},content:blocks},
   calls:blocks.filter(b=>b.type==='tool-call'),text:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n'),finish:assembled.finish.kind};
 };
 try{for(const c of cases){
  const messages=c.dialogue.map(([role,text])=>({id:randomUUID(),role,source:{kind:role==='user'?'qq':'model'},content:[{type:'text',text}]}));
  let seq=0,turn=1;const now=Date.now(),events=[{type:'session',id:session,version:4}];
  const ev=(type,data)=>events.push({type,data,seq:++seq,time:now-1000+seq});
  for(const m of messages){if(m.role==='user'){turn++;ev('turn/start',{turn});ev('user/message',m);}else{ev('assistant/message',{turn,message:m});ev('turn/end',{turn,reason:{kind:'completed'}});}}
  const fixture={session:{header:{id:session},snapshotEvents:()=>events}},row={case:c.id,steps:[]};report.results.push(row);
  for(let attempt=0;attempt<3;attempt++){
   signal.throwIfAborted();const reply=await call(messages);
   const step={finish:reply.finish,text:reply.text,toolRequests:[]};row.steps.push(step);
   if(!reply.calls.length){row.complete=reply.finish==='stop'&&Boolean(reply.text);break;}
   messages.push(reply.message);
   for(const t of reply.calls){
    let result;
    try{
     const args=JSON.parse(t.arguments);
     // The fixtures may only read recent turns. No real archive/tool dispatch.
     if(t.name==='conversation_recall'&&(args.layer==='recent'||(!args.layer||args.layer==='all')&&args.days===undefined&&isRecentQuery(args.query)))result=await recallConversation(fixture,args,now+1000,signal);
     else if(t.name==='recall_archive'&&(args.mode==='recent'||args.mode===undefined&&args.days===undefined&&isRecentQuery(args.query)))result=readRecentDialogue(fixture,{limit:Math.min(args.limit??4,6),now:now+1000,signal});
     else result={ok:false,error:'isolated_probe_only_supports_current_dialogue',archiveSearched:false};
     step.toolRequests.push({name:t.name,layer:args.layer||null,mode:args.mode||null,query:args.query||null,recentCount:result.count??null});
    }catch{result={ok:false,error:'invalid_fixture_request'};}
    messages.push({id:randomUUID(),role:'tool',source:{kind:'tool',callId:t.id},toolCallId:t.id,content:[{type:'text',text:JSON.stringify(result)}]});
   }
  }
 }}catch{report.failure=signal.aborted?'deadline_or_cancelled':'model_or_protocol_error';}
 report.completedAt=Date.now();report.complete=report.results.length===cases.length&&report.results.every(r=>r.complete);
 fs.writeFileSync(join(home,'runtime-health/recent-dialogue-probe.json'),JSON.stringify(report,null,2),{mode:0o600});
 return report;
}
