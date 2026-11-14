import {runAppraisalProbe} from '../dsh-tidal/appraisal-probe.mjs';
import {prepareAppraisal} from '../dsh-tidal/appraisal.mjs';
import {runEventFormatProbe} from '../dsh-tidal/event-format-probe.mjs';
import {runTidalProbe} from '../dsh-tidal/probe.mjs';
import {projectTidal,tidalStatus} from '../dsh-tidal/runtime.mjs';
import {projectAttention} from './attention-runtime.mjs';
import {attentionPolicy} from './attention-selection.mjs';
import {projectCurrentTurn} from './conversation-context.mjs';
import {runStabilityBenchmark} from './stability-benchmark.mjs';
import {renderCheckpointMessages,checkpointViewPolicy} from './checkpoint-view.mjs';

import {runConversationComparison} from './conversation-comparison.mjs';

import {runRecentDialogueProbe} from './recent-dialogue-probe.mjs';

import {conversationContextPolicy} from './conversation-context.mjs';

import {taskContextPolicy} from './task-context.mjs';

import {runToolContinuity,toolContinuityPolicy} from './tool-continuity.mjs';

import {installAudit} from './conversation-audit.mjs';

import {publicTargets,coverageStatus,sha} from './audit-core.mjs';

import {loadRegression,runRegression,runContextComparison,suiteHash} from './style-regression.mjs';

import {projectProactiveHistory,proactiveHistoryPolicy} from './proactive-history.mjs';

import {parseCheckpoint,projectCheckpointMessages} from './summary-evidence.mjs';

import {personaVersions} from './self-persona-store.mjs';

import fs from 'node:fs';

import path from 'node:path';

import crypto from 'node:crypto';

import {eligible,recoverEmpty} from './reply-core.mjs';

import {identity} from '../dsh-long-memory/lib/access.js';

import {correctionRecords} from '../dsh-long-memory/lib/conversation-notes.mjs';

import {projectOwnerInstructions,ownerInstructionPolicy,projectHistoricalReads,historicalReadPolicy} from './context-core.mjs';

import {projectFriendEvents} from '../dsh-long-memory/lib/friend-recall.mjs';

import {isMaintenanceMessage,isIdentityDriftReply} from './maintenance-memory.mjs';

export const name='paopao-reply-health';

export const inject=['llm','agents','commands','webServer','systemPrompt','sessionController'];

const retries=new WeakSet();

export function apply(ctx) {

 const home=process.env.DSH_HOME || '/srv/dsh-cloud/home';

 const dir=path.join(home,'runtime-health');fs.mkdirSync(dir,{recursive:true});

 const auditState=installAudit(ctx,home,identity,personaVersions);let styleBusy=false,lastHistoryProjection=null;let lastAttentionSelection=null;

 const readRegistry=name=>{try{return JSON.parse(fs.readFileSync(path.join(home,name),'utf8'))}catch{return {}}};

 const hash=s=>crypto.createHash('sha256').update(s.trim()).digest('hex');

 function owner(){

   const c=JSON.parse(fs.readFileSync(path.join(home,'qq-bridge-config.json'),'utf8'));

   const row=c.绑定.find(r=>r.类型==='私聊'&&String(r.号码)===String(c.主人号码));

   const agent=ctx.agents.get(row?.会话);

   return agent&&identity(agent).role==='owner'?agent:undefined;

 }

 async function state(){

   const agent=owner(),persona=personaVersions(home).current(),source=persona.text;

   const baseSource=fs.readFileSync(path.join(home,'persona.md'),'utf8');

   let actual=null;

   if(agent){const a=await ctx.systemPrompt.assemble({scope:agent});actual=a.sections.map(s=>s.text).join('\n\n');}

   let events=[];try{events=fs.readFileSync(path.join(dir,'reply-events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.at>Date.now()-86400000);}catch{}

   const checkpoint=agent?.session.snapshotEvents().filter(e=>e.type==='compaction/summary').at(-1);

   const summary=(checkpoint?.data?.summary||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');

   let installed=0;try{installed=JSON.parse(fs.readFileSync(path.join(dir,'installed.json'),'utf8')).at||0;}catch{}

   const since=Math.max(installed,Date.now()-86400000);

   const conf=JSON.parse(fs.readFileSync(path.join(home,'qq-bridge-config.json'),'utf8'));

   let unexplainedEmpty=0,publicRoomsChecked=0,publicPersonaLeaks=0;

   const targets=publicTargets(conf,readRegistry('guests.json'),readRegistry('groups.json')),coverage=[];

   for(const target of targets){

     const mounted=ctx.agents.get(target.sessionId);

     const scope=mounted||{id:target.sessionId,session:{header:{id:target.sessionId}}};

     const row={...target,promptChecked:false,historyChecked:Boolean(mounted),checkKind:mounted?'mounted_runtime':'assembly_only'};

     try{

       if(identity(scope).role!==target.kind)throw Error('binding_conflict');

       const publicPrompt=await ctx.systemPrompt.assemble({scope});

       const t=publicPrompt.sections.map(s=>s.text).join('\n\n');

       row.promptChecked=true;row.personaLeak=hash(t)===hash(source)||t.includes('【边界】');

       publicRoomsChecked++;if(row.personaLeak)publicPersonaLeaks++;

     }catch{row.reason='binding_or_prompt_check_unavailable';}

     coverage.push(row);

   }

   for(const sid of new Set([...(conf.绑定||[]).map(r=>r.会话),...targets.map(r=>r.sessionId)])){

     const a=ctx.agents.get(sid);if(!a)continue;

     let human=false,action=false;

     for(const e of a.session.snapshotEvents().slice(-2000)){

       if(e.type==='user/message'&&e.data.source?.kind!=='compact-checkpoint'){human=e.data.source?.kind==='qq';action=false;}

       if(e.type!=='assistant/message'||e.time<since||!human)continue;

       const blocks=e.data.message?.content||[];

       const hasAction=blocks.some(b=>['tool-call','image','audio'].includes(b.type)||b.type==='text'&&b.text?.trim());

       const stopped=e.data.stream?.some(s=>s.chunk?.type==='finish'&&s.chunk.reason?.kind==='stop');

       if(!hasAction&&!action&&stopped&&!e.data.interrupted)unexplainedEmpty++;

       action ||= hasAction;

     }

   }

   let maintenanceRecords=0,ownerRecallContamination=0;

   try{maintenanceRecords=fs.readFileSync(path.join(home,'maintenance-memory','imported-visible.jsonl'),'utf8').trim().split('\n').filter(Boolean).length;}catch{}

   if(agent){

     const es=agent.session.snapshotEvents(),sid=agent.session.header.id;

     const recalled=projectFriendEvents(es[0]?.type==='session'?es:[{type:'session',version:4,id:sid},...es],sid,{allowUserAfter:0,skipFirstUserTurn:true});

     ownerRecallContamination=recalled.filter(r=>r.role==='friend'&&r.origin==='local_or_bridge'&&isMaintenanceMessage({source:{kind:'user'},content:r.text})||r.role==='paopao'&&isIdentityDriftReply(r.text)).length;

   }

   let evidence=null,evidenceError=false;try{evidence=parseCheckpoint(summary)}catch{evidenceError=true;}

   const regression=loadRegression(home),target=agent?.session.requestHeader()?.config??agent?.options??{};

   const regressionCurrent=Boolean(regression&&regression.suiteHash===suiteHash&&regression.personaHash===sha(source)&&regression.model===target.model&&regression.provider===target.provider&&regression.reasoningEffort===(target.reasoningEffort??null));

   return {ok:true,version:2,at:Date.now(),ownerMounted:Boolean(agent),sourceHash:hash(source),baseSourceHash:hash(baseSource),personaMode:persona.mode,personaRevision:persona.revision,selfEditEnabled:persona.editingEnabled,maintenanceRecords,ownerRecallContamination,

     runtimePersonaMatches:actual!==null&&hash(actual)===hash(source),

     proactiveHistory:{policy:proactiveHistoryPolicy,lastProjection:lastHistoryProjection},

     ownerInstructionPolicy,xinghe:tidalStatus(),tidal:tidalStatus(),attentionSelection:{policy:attentionPolicy,last:lastAttentionSelection},

     historicalReadPolicy,toolContinuityPolicy,taskContextPolicy,conversationContextPolicy,checkpointViewPolicy,

     emptyDetected24h:events.filter(e=>e.kind==='empty_detected').length,

     emptyRecovered24h:events.filter(e=>e.kind==='empty_recovered').length,

     emptyFailed24h:events.filter(e=>e.kind==='empty_failed').length,

     unexplainedEmptySinceRepair:unexplainedEmpty,publicRoomsChecked,publicPersonaLeaks,

     publicCoverage:coverageStatus(coverage),conversationAudit:auditState(),

     summaryEvidence:{version:evidence?2:summary?1:0,validStructure:!evidenceError,items:evidence?.items.length||0,unverifiedItems:evidence?.items.filter(x=>x.basis==='unverified_summary').length||0,personaVersionChanged:Boolean(evidence&&evidence.personaRevision!==persona.revision)},

     styleRegression:{available:Boolean(regression),current:regressionCurrent,reviewNeeded:Boolean(regression?.reviewNeeded),completedAt:regression?.completedAt||null,model:regression?.model||null,cases:regression?.results?.length||0,automaticModelCalls:0},

     activeChatModel:{provider:target.provider||null,model:target.model||null,reasoningEffort:target.reasoningEffort||null},

     checkpointAt:checkpoint?.time||null,checkpointHasMaintenanceIdentity:/当前对话方.*维护助手|维护助手在场/.test(summary)};

 }

 for(const endpoint of ['state','input-trace','attention-preview','context-audit','repair','maintenance-reply','maintenance-model','style-check'])ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/dsh-persona-integrity/'+endpoint,

   handler:async(req,res)=>{

     try{

       if(!['state','input-trace'].includes(endpoint)){

         const expected='Bearer '+fs.readFileSync(path.join(home,'.web-token'),'utf8').trim();

         if(req.headers.authorization!==expected){res.statusCode=403;res.end('Forbidden');return;}

       }

       if(endpoint==='input-trace'){

         if(req.method!=='GET'){res.statusCode=405;res.end();return;}

         res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,...auditState()}));return;

       }

       if(endpoint==='attention-preview'){
         if(req.method!=='GET'){res.statusCode=405;res.end();return;}
         const a=owner();if(!a)throw Error('Owner session not mounted');
         const result=projectAttention(a.session.deriveMessages(),a);
         res.setHeader('Content-Type','application/json');
         res.end(JSON.stringify({ok:true,preview:result.receipt,last:lastAttentionSelection}));return;
       }

       if(endpoint==='context-audit'){

         if(req.method!=='GET'){res.statusCode=405;res.end();return;}

         const a=owner();if(!a)throw Error('Owner session not mounted');

         const events=a.session.snapshotEvents(),before=a.session.deriveMessages();

         const projected=projectProactiveHistory(before,events,{owner:true});

         const instructions=projectOwnerInstructions(projected.messages,{owner:true});

         const reads=projectHistoricalReads(instructions.messages,events,{owner:true});

         const view=renderCheckpointMessages(projectCheckpointMessages(reads.messages,a.session.id,events,correctionRecords(a)),a.session.id);

         const focused=projectCurrentTurn(view.messages,events,{owner:true});
         const after=focused.messages;

         const count=ms=>({messages:ms.length,tools:ms.filter(m=>m.role==='tool').length,humanMessages:ms.filter(m=>m.role==='user'&&['qq','user'].includes(m.source?.kind)).length,characters:ms.reduce((n,m)=>n+(m.content||[]).filter(b=>b.type==='text').reduce((x,b)=>x+b.text.length,0),0)});

         const ids=new Set(after.map(m=>m.id));

         res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,policy:taskContextPolicy,before:count(before),after:count(after),removed:before.filter(m=>!ids.has(m.id)).map(m=>({id:m.id,role:m.role,source:m.source?.kind})),checkpointView:view.stats,currentTurnMarked:focused.marked,tasks:reads.stats.tasks,forwardedMessages:reads.stats.forwardedMessages,unrelatedCatalogsRemoved:reads.stats.unrelatedCatalogsRemoved,conversationContextPolicy,notices:projected.stats}));return;

       }

       if(endpoint==='style-check'){

         if(req.method!=='POST'){res.statusCode=405;res.end();return;}

         if(styleBusy){res.statusCode=409;res.end('{"ok":false,"reason":"style_check_busy"}');return;}

         const a=owner();if(!a)throw Error('Owner session not mounted');

         styleBusy=true;

         try{

           res.setTimeout?.(420000);

           const mode=new URL(req.url,'http://localhost').searchParams.get('mode');

           if(mode==='appraisal'){
             const caseId=new URL(req.url,'http://localhost').searchParams.get('case');
             const report=await runAppraisalProbe(ctx,caseId,AbortSignal.timeout(8000));
             res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,report}));return;
           }
           if(mode==='event-format'){
             const caseId=new URL(req.url,'http://localhost').searchParams.get('case');
             const report=await runEventFormatProbe(ctx,caseId,AbortSignal.timeout(25000));
             res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,report}));return;
           }
           if(mode==='private-reply'){
             const route=JSON.parse(fs.readFileSync(path.join(home,'model-routing.json'),'utf8'));
             if(!route.enabled||route.chatModel!=='deepseek-flash')throw Error('Diagnostic requires current Flash route');
             const original=a.session.deriveMessages(),projected=projectOwnerRequest(original,a);
             const latest=projected.messages.findLast(m=>m.role==='user'&&m.source?.kind==='qq');
             if(!latest)throw Error('No actual private input');
             let text='',finish=null;
             for await(const c of ctx.llm.stream({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high',purpose:'paopao-private-reply-check',messages:projected.messages,tools:[],maxTokens:1536,signal:AbortSignal.timeout(30000)})){
               if(c.type==='text-delta')text+=c.text||'';
               if(c.type==='finish')finish=c.reason?.kind||'unknown';
               if(text.length>8000)throw Error('Diagnostic output bound');
             }
             res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,report:{sourceMessageId:latest.id,model:'deepseek-flash',effort:'high',finish,complete:finish==='stop'&&Boolean(text.trim()),visibleCharacters:text.length,visibleHash:hash(text),projection:projected.historyProjection,QQSends:0,sessionWrites:0,toolExecutions:0}}));return;
           }
           if(mode==='tidal'){
             const q=new URL(req.url,'http://localhost').searchParams;
             const report=await runTidalProbe(ctx,personaVersions(home).current(),home,AbortSignal.timeout(30000),{caseId:q.get('case'),variant:q.get('variant')});
             res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,report}));return;
           }
           const run=['stability','focus'].includes(mode)?runStabilityBenchmark:mode==='recent'?runRecentDialogueProbe:mode==='conversation'?runConversationComparison:mode==='tools'?runToolContinuity:mode==='context'?runContextComparison:runRegression;

           const report=await run(ctx,a,personaVersions(home).current(),home,AbortSignal.timeout(360000),mode==='focus'?{candidate:'current-turn'}:mode==='tools'?{caseId:new URL(req.url,'http://localhost').searchParams.get('case')||undefined}:undefined);

           res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,report}));

         }finally{styleBusy=false;}

         return;

       }

       if(endpoint==='maintenance-reply'){

         const url=new URL(req.url,'http://localhost'),sid=url.searchParams.get('sessionId'),rid=url.searchParams.get('requestId');

         if(!/^session-maintenance-[a-z0-9-]+$/.test(sid||'')||!rid)throw Error('Invalid review target');

         const agent=ctx.agents.get(sid),events=agent?.session.snapshotEvents()||[];

         let active=false,finished=false;const reply=[];

         for(const e of events){

           if(e.type==='user/message'&&e.data.source?.rpcId===rid)active=true;

           if(!active)continue;

           if(e.type==='assistant/message')reply.push(...(e.data.message.content||[]).filter(b=>b.type==='text').map(b=>b.text));

           if(e.type==='turn/end'){finished=true;break;}

         }

         res.setHeader('Content-Type','application/json');res.end(JSON.stringify({finished,visible_reply:reply}));return;

       }

       if(endpoint==='maintenance-model'){

         if(req.method!=='POST'){res.statusCode=405;res.end();return;}

         const manager=ctx.sessionController.agents;

         const found=await manager.resolveAgent('session-maintenance-creative-review');

         if(found.error)throw found.error;

         const a=found.agent;

         if(!a||identity(a).role!=='unknown')throw Error('Review room must be unbound');

         const selected={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'};

         await manager.serializeImageAdmission(a,async()=>{

           await ctx.llm.resolveCallConfig(selected);

           manager.selectForNextRequest(a,selected);

         });

         res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,defaultModelUnchanged:true}));return;

       }

       if(endpoint==='repair'){

         if(req.method!=='POST'){res.statusCode=405;res.end();return;}

         const agent=owner();if(!agent)throw Error('Owner session not mounted');

         const result=await ctx.commands.execute(agent,'/compact',[],AbortSignal.timeout(120000));

         res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result,state:await state()}));return;

       }

       res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await state()));

     }catch{res.statusCode=503;res.end(JSON.stringify({ok:false,reason:'health_or_compaction_unavailable'}));}

   }

 }));

 function projectOwnerRequest(messages,a){
    const historyEvents=a.session.snapshotEvents();
    const projected=projectProactiveHistory(messages,historyEvents,{owner:true});

    const instructions=projectOwnerInstructions(projected.messages,{owner:true});

    const reads=projectHistoricalReads(instructions.messages,historyEvents,{owner:true});

    // Agent-loop envelopes and their messages are frozen. Forward a detached

    // request through the normal adapter pipeline; the purpose prevents reentry

    // and duplicate audit/recovery while the outer call retains its lifecycle.

    const view=renderCheckpointMessages(projectCheckpointMessages(reads.messages,a.session.header.id,historyEvents,correctionRecords(a)),a.session.header.id);

    const focused=projectCurrentTurn(view.messages,historyEvents,{owner:true}).messages;
    const attention=projectTidal(focused,a);



    const historyProjection={at:Date.now(),...projected.stats,retiredInstructionClauses:instructions.removedClauses,historicalReads:reads.stats,checkpointView:view.stats};
    return {messages:attention.messages,attentionReceipt:attention.receipt,historyProjection};
 }

 ctx.on('llm/stream',(options,next)=>(async function*(){

  let request=options;

  if((!options.purpose||options.purpose==='agent')&&options.sessionId&&Array.isArray(options.messages)){

   const a=ctx.agents.get(options.sessionId),who=a&&identity(a);

   if(who?.role==='owner'&&!who.inherited&&!who.conflict){

    await prepareAppraisal(ctx,a,options,{home});
    const projected=projectOwnerRequest(options.messages,a);
    lastAttentionSelection=projected.attentionReceipt;
    lastHistoryProjection=projected.historyProjection;
    request={...options,messages:projected.messages,purpose:'paopao-context-projected'};

   }

  }

  const initial=request===options?auditState.observe(request,next):ctx.llm.stream(request);

  if(retries.has(options)||!eligible(options)){yield* initial;return;}

  const record=kind=>{

   try {fs.appendFileSync(path.join(dir,'reply-events.jsonl'),JSON.stringify({at:Date.now(),kind,sessionId:options.sessionId,model:options.model})+'\n');}

   catch {ctx.logger.warn('reply-health: could not persist diagnostic');}

  };

  yield* recoverEmpty(initial,()=>{

   options.signal?.throwIfAborted();

   const retry={...request,purpose:'paopao-empty-recovery',reasoningEffort:'off',maxTokens:Math.min(options.maxTokens||4096,4096),

     signal:options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000)};

   retries.add(retry);return ctx.llm.stream(retry);

  },record);

 })());

}

