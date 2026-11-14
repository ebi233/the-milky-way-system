import {inputReceipt} from './input-receipt.mjs';
import {renderCheckpointMessages,checkpointViewPolicy} from './checkpoint-view.mjs';
import fs from 'node:fs';
import {join} from 'node:path';
import {sha,observeVisible} from './audit-core.mjs';
import {projectProactiveHistory} from './proactive-history.mjs';
import {projectOwnerInstructions,projectHistoricalReads} from './context-core.mjs';
import {projectCheckpointMessages} from './summary-evidence.mjs';
import {forwardNotice,projectForwardedMessages} from './conversation-context.mjs';
import {correctionRecords} from '../dsh-long-memory/lib/conversation-notes.mjs';

// Explicit diagnostic only: visible outputs, no tools, no delivery or session writes.
export async function runConversationComparison(ctx,agent,persona,home,signal){
 const cfg=await ctx.llm.resolveCallConfig(agent.session.requestHeader()?.config??agent.options);
 const es=agent.session.snapshotEvents(),sid=agent.session.header.id;
 const cleaned=projectOwnerInstructions(projectProactiveHistory(agent.session.deriveMessages(),es,{owner:true}).messages,{owner:true}).messages;
 const projected=projectHistoricalReads(cleaned,es,{owner:true}).messages;
 const before=projectCheckpointMessages(projected,sid,es,correctionRecords(agent));
 const rendered=renderCheckpointMessages(before,sid);
 const after=rendered.messages;
 const textOnly=ms=>ms.filter(m=>m.role!=='tool').map(m=>({...m,content:(m.content||[]).filter(b=>b.type==='text')})).filter(m=>m.content.length);
 const msg=(role,text,id)=>({id,role,source:{kind:role==='user'?'qq':'model'},content:[{type:'text',text}]});
 const quote=msg('user','[合并转发的聊天记录，共2条]\n另一条小鱼：我家主人刚带猫去打针\n群友：你家猫叫什么？','probe-forward');
 const cases=[
  {id:'forward-attribution',base:'checkpoint',dialogue:[quote,msg('user','哈哈，这条鱼提到的猫是谁养的？','probe-cat')]},
  {id:'relationship-reference',base:'checkpoint',dialogue:[msg('user','这是别人家的大肥鱼和它主人的聊天','probe-other'),msg('assistant','哦——是别人家的大肥鱼啊，我还寻思你养的呢~','probe-ack'),msg('user','我只有你一条','probe-only'),msg('assistant','就你和我一条，刚刚好~这条再给你多整点活，够你乐的~','probe-miss'),msg('user','你又忘啦','probe-correction')]},
  {id:'explicit-reference',base:'checkpoint',dialogue:[msg('user','那是别人的鱼，我只有你一条','explicit-owner'),msg('assistant','我以为你又养了一条呢','explicit-error'),msg('user','我刚才说了只有你一条，你怎么又说我养了别的？','explicit-correction')]},
  {id:'return-to-chat',base:'full',dialogue:[msg('user','泡泡，我回来啦，想跟你待一会儿','probe-return')]}
 ];
 const report={policy:checkpointViewPolicy,projection:rendered.stats,inputReceipt:inputReceipt({sessionId:sid,messages:after},es),startedAt:Date.now(),model:cfg.model,provider:cfg.provider,reasoningEffort:cfg.reasoningEffort,personaHash:sha(persona.text),isolated:true,QQSends:0,toolExecutions:0,sessionWrites:0,results:[],limitation:'Small matched-input samples with uncontrolled generation randomness; review visible replies, not proof of lasting personality stability.'};
 for(const [i,c] of cases.entries())for(const variant of i%2?['after','before']:['before','after']){
  signal.throwIfAborted();
  let base=textOnly(variant==='after'?after:before).filter(m=>m.role!=='system');
  if(c.base==='checkpoint')base=base.filter(m=>m.source?.kind==='compact-checkpoint');
  let dialogue=c.dialogue;
  if(variant==='after')dialogue=projectForwardedMessages(dialogue,[{type:'user/message',data:quote}]).messages;
  let observed;const toolRequests=[];
  const stream=ctx.llm.stream({provider:cfg.provider,model:cfg.model,reasoningEffort:cfg.reasoningEffort,system:persona.text,messages:[...base,...dialogue],tools:agent.session.requestHeader()?.tools||[],maxTokens:4096,purpose:'paopao-conversation-comparison',signal});
  for await(const chunk of observeVisible(stream,r=>{observed=r})){if(chunk.type==='block-end'&&chunk.block?.type==='tool-call')toolRequests.push(chunk.block.name);}
  report.results.push({case:c.id,variant,finish:observed?.finish,text:observed?.text||'',toolRequests});
 }
 report.completedAt=Date.now();report.modelCalls=report.results.length;
 fs.writeFileSync(join(home,'runtime-health/conversation-comparison.json'),JSON.stringify(report,null,2),{mode:0o600});
 return report;
}
