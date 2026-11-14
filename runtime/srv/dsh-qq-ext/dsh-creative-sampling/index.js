import {identity} from '../dsh-long-memory/lib/access.js';
import {loadRouting,routeRequest,applyReasoningTrial,reasoningTrialState} from './routing.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, renameSync } from 'node:fs';
import { loadSettings, tuneRequest } from './sampling.mjs';

export const name = 'dsh-creative-sampling';

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const envPath = join(home, '.env');
  const statusPath = join(home, 'creative-sampling-status.json');
  let settings = loadSettings(envPath);
  const routingPath=join(home,'model-routing.json');
  let routing=loadRouting(routingPath),routedRequests=0,lastRoute=null,routingError=false;
  let requests = 0;
  let observed = 0;
  let lastDecision = null;
  let disposed = false;
  const status = (active) => {
    const temporary = statusPath + `.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({
        active, pid: process.pid, loadedAt: new Date().toISOString(), requests, observed, lastDecision,
        temperature: settings.reasoningEffort==='off'?settings.temperature:null, maxTokens: settings.reasoningEffort==='off'?settings.maxTokens:null,
        reasoningEffort: settings.reasoningEffort,
        modelRouting:{...routing,routedRequests,lastRoute,routingError},
        chatReasoningTrial:reasoningTrialState(routing),
        requestedPresencePenalty: settings.requestedPresencePenalty,
        presencePenaltyApplied: false,
      }, null, 2) + '\n', { mode: 0o600 });
      renameSync(temporary, statusPath);
    } catch {
      console.warn('[dsh-creative-sampling] Could not write status file');
    }
  };
  ctx.on('agent/request', async ({ agent }, next) => {
    const previous = await next();
    if (disposed) return previous;
    // Read only our five whitelisted keys. Nothing is copied into process.env.
    try { settings = loadSettings(envPath); }
    catch { console.warn('[dsh-creative-sampling] Invalid config; retaining last valid settings'); }
    const sessionId = String(agent?.session?.header?.id ?? agent?.session?.id ?? '');
    try{routing=loadRouting(routingPath);routingError=false}catch{routingError=true}
    const routed=routeRequest(previous,identity(agent),routing);
    if(routed.request!==previous)routedRequests++;
    lastRoute={kind:routed.route,model:routed.request.model};
    const result = applyReasoningTrial(tuneRequest(routed.request, sessionId, settings),identity(agent),routing);
    lastRoute.reasoningEffort=result.reasoningEffort;
    observed += 1;
    lastDecision = {
      targetSession: settings.sessionIds.includes(sessionId),
      officialProvider: previous.provider === 'deepseek-official',
      supportedModel: ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-v4-flash'].includes(previous.model),
      applied: result !== previous,
    };
    if (result !== routed.request) {
      requests += 1;
    }
    status(true);
    return result;
  });
  ctx.on('dispose', () => { disposed = true; status(false); });
  status(true);
  console.log('[dsh-creative-sampling] Chat sampling hook loaded; presence_penalty is unsupported and omitted');
}
