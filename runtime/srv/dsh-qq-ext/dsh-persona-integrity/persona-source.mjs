import {personaVersions} from './self-persona-store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-persona/lib/index.js';

export const name = 'paopao-persona-source';
export const inject = ['systemPrompt'];
export function readPersona(home = process.env.DSH_HOME || '/srv/dsh-cloud/home') {
  return personaVersions(home).current().text;
}
export function apply(ctx) {
  readPersona(); // fail closed at startup, never fall back to a stale copy
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: () => readPersona(), complete: true, interpolate: false,
  }), 'persona-source.section');
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SUFFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: '', interpolate: false,
  }), 'persona-source.suffix');
  ctx.systemPrompt.suppressRuntimeContext();
}
