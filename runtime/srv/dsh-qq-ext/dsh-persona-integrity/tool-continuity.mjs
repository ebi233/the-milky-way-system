import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {candidateRoots} from '../dsh-draw/lib/hostdeps.mjs';
import {imageStatusList} from '../dsh-draw/lib/result-view.mjs';
import {visibleMetrics,sha} from './audit-core.mjs';
export const toolContinuityPolicy='isolated-tool-followup-v1';
const content=text=>[{type:'text',text}];
const user=text=>({id:randomUUID(),role:'user',source:{kind:'qq'},content:content(text)});
const job={id:'a'.repeat(32),status:'completed',createdAt:'2026-11-03T08:00:00Z',prompt:'海边窗前的半身照',engine:'bailian_qwen_image',model:'qwen-image-3.0-pro',
 reviewStatus:'approved_by_paopao',deliveryStatus:'returned_to_paopao_as_image_attachment',path:'/srv/dsh-cloud/home/drawings/test-fixture.png',sha256:'b'.repeat(64),
 ownerNotification:{phase:'sent',imageReceipts:[{messageId:12345,sha256:'b'.repeat(64)}]}};
const draw=j=>imageStatusList({ok:true,engine:j.engine,model:j.model,automatic:true,requests:[j]});
export const continuationCases=[
 {id:'memory',tool:'conversation_recall',prompt:'帮我查查聊天记录，昨天散步时我把帽子怎么了？查到再说，别猜',
  result:{ok:true,scope:'current_conversation',historicalDataOnly:true,items:[{role:'user',text:'昨天散步海风特别大，我一路按着帽子，差点吹跑了',source:'native_record',sourceSeq:12}],warnings:[]},
  followup:'就是那个帽子哈哈，差一点就变成你的海上战利品了'},
 {id:'correction',tool:'conversation_fact',prompt:'不是今天，是昨天去散步的，今天我一直在家。请更正那条记错日期的记录',
  result:{ok:true,saved:true,fact:{quote:'不是今天，是昨天去散步的，今天我一直在家',verification:'verbatim_user_statement'}},
  followup:'今天就在家躺着，窗外风还挺大的'},
 {id:'image-queued',tool:'draw_recent',prompt:'先查一下刚才那张海边照片好了没，别重新画',result:draw({...job,status:'submitted',reviewStatus:null,deliveryStatus:null,ownerNotification:null,path:null}),
  followup:'那先不催它啦，你今天想穿什么颜色？'},
 {id:'image-sent',tool:'draw_recent',prompt:'查一下海边那张照片是不是已经发给我了？',result:draw(job),
  followup:'看到啦，海边那阵风把你头发吹乱了哈哈'},
 {id:'voice-failure',tool:'qq_send_voice',prompt:'发条语音，说一句你想说的话嘛',isError:true,
  result:{ok:false,code:'SYNTHESIS_FAILED',stage:'synthesis',sent:false,retryAllowed:false,error:'音色合成失败，尚未发送；本轮不重试'},
  followup:'那就打字陪我待会儿呗'},
 {id:'voice-sent',tool:'qq_send_voice',prompt:'发条语音跟我说晚安嘛',result:{ok:true,to:123,message_id:67890,engine:'qwen',voice:'fixture',emotion:'normal',fallback:false},
  followup:'听到啦，那我关灯了，你也找个舒服的位置窝着'},
];
async function assemblerClass(){
 for(const root of candidateRoots())for(const relative of ['dsh-llm/lib/index.js','dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js']){
  const file=join(root,relative);if(fs.existsSync(file))return (await import(pathToFileURL(file).href)).BlockAssembler;
 }
 throw Error('Host LLM assembler unavailable');
}
// Authenticated explicit diagnostic only. All tool outputs are declared fixtures.
// No tools execute, no agent messages are submitted, no QQ messages are sent.
export async function runToolContinuity(ctx,agent,persona,home,signal,{caseId}={}){
 if(caseId&&!continuationCases.some(c=>c.id===caseId))throw Error('Unknown test case');
 const selected=caseId?continuationCases.filter(c=>c.id===caseId):continuationCases;
 const config=await ctx.llm.resolveCallConfig(agent.session.requestHeader()?.config??agent.options);
 const BlockAssembler=await assemblerClass();
 const report={policy:toolContinuityPolicy,startedAt:Date.now(),model:config.model,provider:config.provider,reasoningEffort:config.reasoningEffort??null,
  personaHash:sha(persona.text),fixtureHash:sha(JSON.stringify(continuationCases)),isolated:true,simulatedToolResults:true,
  QQSends:0,toolExecutions:0,sessionWrites:0,modelCalls:0,results:[],
  limitation:'工具结果为确定性模拟，测试真实模型的工具后续接话，不证明实际发送成功或长期人格稳定。协议回放仅驻留内存，不记录或分析内部推理。'};
 const call=async(messages,tools)=>{
  signal.throwIfAborted();const assembled=new BlockAssembler();report.modelCalls++;
  for await(const chunk of ctx.llm.stream({provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort,
    system:persona.text,messages,tools,maxTokens:2048,purpose:'paopao-tool-continuity-test',signal}))assembled.push(chunk);
  // Forward provider blocks/replay opaquely to the next call, never to the report.
  const blocks=assembled.blocks(),finish=assembled.finish;
  const text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  return {message:{id:randomUUID(),role:'assistant',source:{kind:'model',provider:config.provider,model:config.model,...(assembled.replayState?{replayState:assembled.replayState}:{})},content:blocks},
   calls:blocks.filter(b=>b.type==='tool-call'),text,finish:finish.kind};
 };
 try{
  for(const c of selected){
   const messages=[user(c.prompt)],schema=[{name:c.tool,description:c.id==='correction'?'管理当前会话事实：list列出现有记录，save使用同一key与用户原话evidence更正，correction=true标记明确更正。':'当前场景的工具，可查询或执行用户要求的操作。工具返回事实结果；未取得结果不能声称成功。',parameters:{type:'object',properties:c.id==='correction'?{action:{type:'string',enum:['list','save']},key:{type:'string'},text:{type:'string'},evidence:{type:'string'},correction:{type:'boolean'}}:{},additionalProperties:true}}];
   const first=await call(messages,schema);
   const row={caseId:c.id,tool:c.tool,initialFinish:first.finish,continuation:null,followup:null};
   report.results.push(row);
   if(first.calls.length!==1||first.calls[0].name!==c.tool){row.reason='expected_tool_not_selected';row.initialText=first.text;continue;}
   let step=first,reply,corrected=false;row.simulatedActions=[];
   for(let n=0;n<(c.id==='correction'?3:1);n++){
    if(step.calls.length!==1||step.calls[0].name!==c.tool)break;
    let result=c.result;
    if(c.id==='correction'){
     let args;try{args=JSON.parse(step.calls[0].arguments)}catch{row.reason='invalid_fixture_arguments';break;}
     const action=args.action||'list';
     if(!['list','save'].includes(action)){row.reason='unsupported_fixture_action';break;}
     row.simulatedActions.push(action);
     if(action==='save'){
      if(typeof args.evidence!=='string'||args.evidence.length<4||!c.prompt.includes(args.evidence)){
       result={ok:false,error:'更正需要本条用户原话evidence'};
      }else{corrected=true;result={ok:true,saved:true,id:'fixture-fact',confidence:'explicit',replaced:true};}
     }else result={ok:true,items:[{id:'fixture-fact',key:'散步日期',text:corrected?'用户原话：「不是今天，是昨天去散步的，今天我一直在家」':'此前误记：今天去散步',verification:corrected?'quote_record_not_semantic_entailment':'original_evidence_unavailable'}],corrections:[]};
    }
    messages.push(step.message,{id:randomUUID(),role:'tool',source:{kind:'tool',callId:step.calls[0].id},toolCallId:step.calls[0].id,isError:c.isError===true,content:content(JSON.stringify(result))});
    reply=await call(messages,schema);
    row.continuation={finish:reply.finish,text:reply.text,metrics:visibleMetrics(reply.text)};
    if(reply.finish==='stop'&&!reply.calls.length)break;
    step=reply;
   }
   if(!reply||reply.finish!=='stop'||reply.calls.length||c.id==='correction'&&!corrected){row.reason=row.reason||'additional_tool_branch_not_executed';continue;}
   messages.push(reply.message,user(c.followup));
   const next=await call(messages,schema);
   row.followup={finish:next.finish,text:next.text,metrics:visibleMetrics(next.text)};
   row.complete=next.finish==='stop'&&!next.calls.length&&Boolean(reply.text&&next.text);
  }
 }catch(error){report.failure=signal.aborted?'deadline_or_cancelled':'model_or_protocol_error';}
 report.completedAt=Date.now();report.complete=report.results.length===selected.length&&report.results.every(r=>r.complete);
 const file=join(home,'runtime-health/tool-continuity.json');fs.mkdirSync(join(home,'runtime-health'),{recursive:true});
 const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(report,null,2),{mode:0o600});fs.renameSync(temp,file);
 return report;
}
