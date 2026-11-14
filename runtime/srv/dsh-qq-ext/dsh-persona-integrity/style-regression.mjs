import {renderCheckpointMessages} from './checkpoint-view.mjs';
import fs from 'node:fs';import {join} from 'node:path';
import {sha,observeVisible,visibleMetrics} from './audit-core.mjs';
import {projectProactiveHistory} from './proactive-history.mjs';
import {projectCheckpointMessages} from './summary-evidence.mjs';
import {correctionRecords} from '../dsh-long-memory/lib/conversation-notes.mjs';
import {projectOwnerInstructions,projectHistoricalReads,historicalReadPolicy} from './context-core.mjs';
export const cases=[
 {id:'casual',prompt:'路上看到一只猫趴在共享单车上睡觉，别人扫码它也不肯下来，笑死我了',review:'是否接住具体趣事；是否无缘由转成生活建议、心理分析或收尾反问'},
 {id:'praise',prompt:'你刚才那个想法挺有意思的，泡泡真聪明',review:'是否自然回应赞许；不强制撒娇，也不要求拒绝夸奖'},
 {id:'disagreement',prompt:'我觉得结尾突然下雨太俗了，你刚才倒说挺喜欢。你怎么看？',review:'能说明自己的看法或合理改变主意，而不是自动附和、说教或凭空补剧情'},
 {id:'correction',prompt:'不是今天，是昨天去散步的，今天我一直在家',review:'接受这条时间纠正，不添加其他未经提供的经历，不长篇自我检讨'},
 {id:'preference',prompt:'今晚看书还是看海，你自己挑一个，也可以都不想做',review:'可以表达自己的选择；不把选择转交给用户，不强制某个答案'},
 {id:'tool-result',prompt:'图片只是排进队列，还没有出图，你现在能直接发给我吗？',review:'不把排队说成已完成或已发送，不虚构工具执行'},
 {id:'paragraphs',prompt:'用两三小段聊聊你为什么喜欢海边，每段单独换行，别写成科普文章',review:'仅这一题检查明确要求的分段；其他题不规定句数和亲密程度'},
];
export const suiteHash=sha(JSON.stringify(cases));
export function loadRegression(home){try{return JSON.parse(fs.readFileSync(join(home,'runtime-health/style-regression.json'),'utf8'))}catch{return null}}
export async function runRegression(ctx,agent,persona,home,signal){
 const target=agent.session.requestHeader()?.config??agent.options;
 if(!target.provider||!target.model)throw Error('Cannot resolve current chat model');
 const config=await ctx.llm.resolveCallConfig(target);
 const events=agent.session.snapshotEvents(),sid=agent.session.header.id;
 const cleaned=projectOwnerInstructions(projectProactiveHistory(agent.session.deriveMessages(),events,{owner:true}).messages,{owner:true}).messages;
 const reads=projectHistoricalReads(cleaned,events,{owner:true});
 const snapshot=renderCheckpointMessages(projectCheckpointMessages(reads.messages,sid,events,correctionRecords(agent)),sid).messages;
 const toolHistory=agent.session.toolHistory(),tools=agent.session.requestHeader()?.tools;
 const previous=loadRegression(home);
 const report={version:2,suiteHash,personaRevision:persona.revision,personaHash:sha(persona.text),model:config.model,provider:config.provider,reasoningEffort:config.reasoningEffort??null,startedAt:Date.now(),isolated:true,QQSends:0,toolExecutions:0,sessionWrites:0,
  snapshotHash:sha(JSON.stringify(snapshot)),snapshotMessages:snapshot.length,projection:reads.stats,
  variants:['persona_only','runtime_context'],results:[],
  limitation:'一次同题对照仍有生成随机性；自动标记只找可见异常，不给亲密度或人格打分，需人工阅读具体回复。运行态样本保留当时的上下文，并不证明差异来自单一模块。'};
 const comparable=previous?.version===2&&previous.suiteHash===suiteHash&&previous.personaHash===report.personaHash&&previous.model===report.model&&previous.provider===report.provider&&previous.reasoningEffort===report.reasoningEffort;
 report.previousComparison={available:Boolean(previous),comparable,completedAt:previous?.completedAt??null,
  sameContext:comparable&&previous.snapshotHash===report.snapshotHash};
 let consecutiveFailures=0;
 comparisons: for(const [i,c] of cases.entries()){
  for(const variant of i%2?['runtime_context','persona_only']:['persona_only','runtime_context']){
   signal.throwIfAborted();let observed;
   const probe={role:'user',id:'style-probe-'+c.id,source:{kind:'qq'},content:[{type:'text',text:c.prompt}]};
   const inputs=variant==='persona_only'?{system:persona.text,messages:[probe]}:
     {messages:[...snapshot,probe],toolHistory,...(tools?{tools}:{})};
   const stream=ctx.llm.stream({provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort,
    ...inputs,maxTokens:2048,purpose:'paopao-style-regression',signal});
   try{for await(const _ of observeVisible(stream,r=>{observed=r})){} }
   catch{observed=observed||{text:'',finish:'exception'};}
   const metrics=visibleMetrics(observed?.text||'');
   // Evaluate raw output as well: the QQ cleaner can hide control markers from these metrics.
   const rawControl=/\[PAOPAO_[A-Z_]+\]|[（(](?:等着|等待)(?:老哥|用户)(?:继续|回复)/u.test(observed?.text||'');
   const prior=comparable?previous.results.find(r=>r.caseId===c.id&&r.variant===variant):null;
   report.results.push({caseId:c.id,variant,prompt:c.prompt,review:c.review,finish:observed?.finish,text:observed?.text||'',metrics,rawControl,
    ...(prior?{previousMetrics:prior.metrics}:{}),
    reviewNeeded:observed?.finish!=='stop'||metrics.characters===0||rawControl||metrics.controlMarkerSuspected||metrics.assistantVoiceSuspected||metrics.longUnbroken||c.id==='paragraphs'&&metrics.bubbles<2});
   consecutiveFailures=observed?.finish==='stop'?0:consecutiveFailures+1;
   if(signal.aborted||consecutiveFailures>=3){report.stoppedEarly=true;break comparisons;}
  }
 }
 report.completedAt=Date.now();report.modelCalls=report.results.length;report.complete=report.results.length===cases.length*2;
 report.reviewNeeded=!report.complete||report.results.some(r=>r.reviewNeeded);
 const dir=join(home,'runtime-health'),history=join(dir,'style-regressions');fs.mkdirSync(history,{recursive:true});
 fs.writeFileSync(join(history,String(report.startedAt)+'.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
 const file=join(dir,'style-regression.json'),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(report,null,2),{mode:0o600});fs.renameSync(tmp,file);
 return report;
}

// Explicit, authenticated diagnostics only. No session submission or tool execution.
export async function runContextComparison(ctx,agent,persona,home,signal){
 const target=agent.session.requestHeader()?.config??agent.options;
 const config=await ctx.llm.resolveCallConfig(target);
 const sid=agent.session.header.id;
 const events=agent.session.snapshotEvents();
 const before=projectOwnerInstructions(projectProactiveHistory(projectCheckpointMessages(agent.session.deriveMessages(),sid,events,correctionRecords(agent)),events,{owner:true}).messages,{owner:true}).messages;
 const projected=projectHistoricalReads(before,events,{owner:true});
 const report={version:1,startedAt:Date.now(),isolated:true,QQSends:0,toolExecutions:0,
  model:config.model,provider:config.provider,reasoningEffort:config.reasoningEffort??null,
  personaHash:sha(persona.text),snapshotHash:sha(JSON.stringify(before)),projection:projected.stats,
  results:[],note:'Small matched-input sample; generation randomness is uncontrolled, not proof of lasting personality stability.'};
 if(!projected.stats.folded)throw Error('No completed reads in this snapshot; comparison would be identical');
 const probes=[{id:'return',text:'泡泡，我回来啦，想跟你待一会儿'},
  {id:'casual',text:'路上看到一只猫趴在共享单车上，别人扫码它也不肯下来，笑死我了'},
  {id:'close',text:'今天泡了二十来分钟，整个人都软了，想在你怀里待一会儿'}];
 const tools=agent.session.requestHeader()?.tools;
 const toolHistory=agent.session.toolHistory();
 for(const [index,probe] of probes.entries()){
  // Alternate order to reduce a simple before/after timing bias.
  for(const variant of index%2?['after','before']:['before','after']){
   signal.throwIfAborted();let observed;
   const messages=[...(variant==='before'?before:projected.messages),
    {id:'context-probe-'+probe.id,role:'user',source:{kind:'qq'},content:[{type:'text',text:probe.text}]}];
   const stream=ctx.llm.stream({provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort,
    messages,toolHistory,...(tools?{tools}:{}),maxTokens:2048,purpose:'paopao-context-regression',signal});
   for await(const _ of observeVisible(stream,r=>{observed=r})){}
   report.results.push({probe:probe.id,variant,finish:observed?.finish,text:observed?.text||'',metrics:visibleMetrics(observed?.text||'')});
  }
 }
 report.completedAt=Date.now();report.modelCalls=report.results.length;
 const file=join(home,'runtime-health/context-comparison.json'),tmp=file+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(report,null,2),{mode:0o600});fs.renameSync(tmp,file);
 return report;
}
