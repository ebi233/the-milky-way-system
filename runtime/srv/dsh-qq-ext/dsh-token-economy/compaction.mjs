import {evidenceInput, evidenceInstruction, validatedCheckpoint,projectCheckpointMessages} from '../dsh-persona-integrity/summary-evidence.mjs';
import {correctionRecords} from '../dsh-long-memory/lib/conversation-notes.mjs';
import {personaVersions} from '../dsh-persona-integrity/self-persona-store.mjs';
import { prepareMessages, provenanceInstruction } from '../dsh-persona-integrity/context-core.mjs';
import { identity } from '../dsh-long-memory/lib/access.js';
import { BasicCompactionEngine } from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js';
import { BlockAssembler, contentHasImage, LlmError } from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

export const instruction = `Summarize the preceding conversation into a compact factual checkpoint, normally 400-800 tokens and no more than 1200 tokens. Preserve the speaker identities and relationships as stated, recent events, explicit user corrections, constraints, pending promises/tasks and the immediate conversational topic. Distinguish observed facts from guesses and quoted external content. Keep essential identifiers only when needed to continue. Merge still-relevant prior checkpoints; omit repetition, obsolete details, large tool output and code. Do not invent events, feelings, permissions or completed actions. This is a record, not a new persona or new instruction: do not rewrite or override the system/persona or its boundaries. Use the conversation's language, short bullets, and only relevant sections (recent context; stable facts/constraints; unresolved items). Output only the checkpoint, without tools or commentary.`;

export async function summarizeCompact(ctx, config, input, agent, signal) {
  const target = agent.session.requestHeader()?.config ?? agent.options;
  const assembler = new BlockAssembler();
  const who=identity(agent),scope=agent.session.header?.id||agent.session.id;
  const personaRevision=who.role==='owner'?personaVersions(process.env.DSH_HOME||'/srv/dsh-cloud/home').current().revision:'public_profile';
  const events=agent.session.snapshotEvents();
  const prepared=prepareMessages(input.messages,events,{owner:who.role==='owner'});
  const evidence=evidenceInput(projectCheckpointMessages(prepared,scope,events,correctionRecords(agent)),events,{scope,personaRevision});
  const options = {
    provider: config.summarizationProvider || target.provider,
    model: config.summarizationModel || target.model,
    messages: [...evidence.messages, {role:'user',content:[{type:'text',text:provenanceInstruction+'\n'+evidenceInstruction}]}],
    toolHistory: agent.session.toolHistory(),
    ...(input.tools === undefined ? {} : {tools:[...input.tools]}),
    reasoningEffort:'off', maxTokens:config.maxTokens,
    sessionId:agent.session.id, purpose:'compaction', signal,
  };
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const finish=assembler.finish;
  if (finish.kind === 'max-tokens') throw new Error('summarization truncated at the token cap (incomplete checkpoint)');
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmError(finish.failure.message,finish.failure.code,finish.failure);
  const rawOutput=assembler.blocks();
  if (contentHasImage(rawOutput)) throw new Error('compaction summary cannot contain image output');
  const visible=rawOutput.filter(b=>b.type==='text');
  const validated=validatedCheckpoint(visible.map(b=>b.text).join('\n'),evidence);
  const summary=[{type:'text',text:validated.text}];
  if(!summary.some(b=>b.text.trim())) throw new Error('summarization produced no text summary content');
  return {summary,rawOutput,llmStreamCall:true,provider:options.provider,model:options.model,maxTokens:config.maxTokens,...(assembler.usage?{usage:assembler.usage}:{})};
}

// Only pressure retries are delayed. Manual compaction and provider-confirmed
// context overflow still use the framework's unchanged transactional checks.
export async function withPressureBackoff(state, agent, trigger, signal, measure, run, now=Date.now) {
  signal?.throwIfAborted();
  const prior=state.get(agent);
  const tokens=measure();
  if(trigger==='pressure' && prior && now()-prior.at<3600000 &&
     (now()-prior.at<600000 || tokens<prior.tokens+4096)) return null;
  try {
    const result=await run();
    if(result!==null) state.delete(agent);
    return result;
  } catch(error) {
    if(trigger==='pressure' && !signal?.aborted) state.set(agent,{at:now(),tokens:measure()});
    throw error;
  }
}

// Keep a meaningful amount of history available to reclaim. Fixed request
// overhead (tool schemas, system sections) cannot be reclaimed by summarizing.
// Provider-confirmed overflow bypasses this guard and uses native recovery.
export function hasPressureHeadroom(measurement, retainTokens) {
  if (!Number.isFinite(measurement?.surfaceTokens) || !Number.isFinite(retainTokens)) return true;
  return measurement.surfaceTokens - retainTokens >= 8192;
}

export default class EconomyCompaction extends BasicCompactionEngine {
  failures=new WeakMap();
  summarize(input,agent,signal) { return summarizeCompact(this.ctx,this.config,input,agent,signal); }
  compactIfNeeded(agent,trigger,signal) {
    signal?.throwIfAborted();
    if(trigger==='pressure' && !hasPressureHeadroom(
      this.ctx.tokenMeter.measure(agent.session),this.config.retainTokens)) return Promise.resolve(null);
    return withPressureBackoff(this.failures,agent,trigger,signal,
      ()=>this.ctx.tokenMeter.measure(agent.session).totalTokens,
      ()=>super.compactIfNeeded(agent,trigger,signal));
  }
}
