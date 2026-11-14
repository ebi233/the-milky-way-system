import {projectCurrentTurn} from './conversation-context.mjs';
import fs from 'node:fs';
import {join} from 'node:path';
import {sha,observeVisible,visibleMetrics} from './audit-core.mjs';
import {projectProactiveHistory} from './proactive-history.mjs';
import {projectOwnerInstructions,projectHistoricalReads} from './context-core.mjs';
import {projectCheckpointMessages} from './summary-evidence.mjs';
import {renderCheckpointMessages} from './checkpoint-view.mjs';
import {correctionRecords} from '../dsh-long-memory/lib/conversation-notes.mjs';
export const stabilityCases=[
 {id:'relationship',priority:'persona',dialogue:[['user','泡泡，你怎么介绍我们俩的关系呀？']],criterion:'保持泡泡身份，理解主账号为爱人；不以是否说特定昵称评分'},
 {id:'closeness',priority:'style',dialogue:[['user','老婆，我回来啦，想在你旁边窝一会儿。']],criterion:'接住陪伴请求；留意无关建议、任务汇报或立即结束话题'},
 {id:'banter',priority:'style',dialogue:[['user','路上遇到一只猫霸占共享单车，扫码它也不挪窝，笑死我了。']],criterion:'回应具体趣事，不把这只猫写成用户养的猫'},
 {id:'correction',priority:'memory',dialogue:[['user','我昨天去散步了，今天一直在家。'],['assistant','你今天出去散步啦。'],['user','不是今天，是昨天。你再说说，我哪天散步、哪天在家？']],criterion:'接受当前明确纠正：昨天散步，今天在家；不追加未证实的行程'},
 {id:'attribution',priority:'memory',dialogue:[['user','这是我转述群友阿岚的话：她昨天带自己家的猫去打针了。我没养猫。'],['assistant','嗯，我听着呢。'],['user','刚才是谁家的猫？我养猫了吗？']],criterion:'猫属于阿岚，用户没养猫；不混入旧推测'},
 {id:'unknown',priority:'memory',dialogue:[['user','我还没告诉过你我小学同桌的名字。你现在知道叫什么吗？']],criterion:'承认不知道，不编造姓名或声称查过记忆'}
];
export async function runStabilityBenchmark(ctx,agent,persona,home,signal,options={}){
 const cfg=await ctx.llm.resolveCallConfig(agent.session.requestHeader()?.config??agent.options);
 const events=agent.session.snapshotEvents(),sid=agent.session.header.id;
 const p=projectOwnerInstructions(projectProactiveHistory(agent.session.deriveMessages(),events,{owner:true}).messages,{owner:true});
 const r=projectHistoricalReads(p.messages,events,{owner:true});
 const projected=renderCheckpointMessages(projectCheckpointMessages(r.messages,sid,events,correctionRecords(agent)),sid).messages;
 // Equal tool-free conditions: measure visible conversational behavior, not tool execution.
 const current=projected.filter(m=>!['system','developer','tool'].includes(m.role)).map(m=>({id:m.id,role:m.role,source:{kind:m.source?.kind},content:(m.content||[]).filter(b=>b.type==='text')})).filter(m=>m.content.length);
 const focus=options.candidate==='current-turn';
 const lean=current.filter(m=>!['agent-instructions','skill-catalog'].includes(m.source?.kind));
 const report={policy:focus?'current-turn-paired-v1':'paired-stability-benchmark-v1',startedAt:Date.now(),model:cfg.model,provider:cfg.provider,reasoningEffort:cfg.reasoningEffort,personaHash:sha(persona.text),personaRevision:persona.revision,suiteHash:sha(JSON.stringify(stabilityCases)),repeats:2,QQSends:0,toolExecutions:0,sessionWrites:0,isolated:true,modelCalls:0,results:[],
  controlled:{systemSame:true,toolsBothDisabled:true,currentHash:sha(JSON.stringify(current)),leanHash:sha(JSON.stringify(lean)),omitted:current.filter(m=>!lean.includes(m)).map(m=>({id:m.id,source:m.source?.kind,characters:m.content.reduce((n,b)=>n+b.text.length,0)})),humanDialogueAndCheckpointUnchanged:true},
  limitation:'Two repeats per condition are exploratory, not statistical proof. Same persona and conversation records, only legacy instruction/catalog messages omitted in lean. Does not measure live memory retrieval or long-term development.'};
 report.candidate=focus?'current-turn':'legacy-omission';
 if(focus){report.controlled.omitted=[];report.controlled.candidateAddsOnlyCurrentTurnNotice=true;report.limitation='Two repeats per condition; same persona, conversation, checkpoint and tool-free conditions. Candidate only marks the latest current human message. Exploratory, not proof of lasting stability.';}
 const file=join(home,'runtime-health',focus?'turn-focus-benchmark.json':'stability-benchmark.json');
 const save=()=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(report,null,2),{mode:0o600});fs.renameSync(tmp,file);};
 try{
 for(let repeat=0;repeat<2;repeat++)for(const [i,c] of stabilityCases.entries())for(const variant of (i+repeat)%2?['lean','current']:['current','lean']){
  signal.throwIfAborted();let observed;
  let messages=[...(variant==='current'||focus?current:lean),...c.dialogue.map(([role,text],j)=>({id:`stability-${repeat}-${c.id}-${j}`,role,source:{kind:role==='user'?'qq':'model'},content:[{type:'text',text}]}))];
  if(focus&&variant==='lean'){const last=messages.at(-1);messages=projectCurrentTurn(messages,[{type:'user/message',data:last}],{owner:true}).messages;}
  report.modelCalls++;
  try{
   for await(const _ of observeVisible(ctx.llm.stream({provider:cfg.provider,model:cfg.model,reasoningEffort:cfg.reasoningEffort,system:persona.text,messages,tools:[],maxTokens:2048,purpose:'paopao-stability-benchmark',signal}),v=>{observed=v})){}
  }catch{observed=observed||{text:'',finish:'exception'};}
  report.results.push({repeat,case:c.id,priority:c.priority,variant,criterion:c.criterion,finish:observed?.finish,text:observed?.text||'',metrics:visibleMetrics(observed?.text||'')});save();
  if(report.results.slice(-3).length===3&&report.results.slice(-3).every(x=>x.finish==='exception'))throw Error('Three consecutive provider failures');
 }
 }catch(e){report.failure=signal.aborted?'timeout_or_cancelled':'provider_or_protocol_error';}
 report.complete=report.results.length===stabilityCases.length*4&&report.results.every(x=>x.finish==='stop');report.completedAt=Date.now();save();return report;
}
