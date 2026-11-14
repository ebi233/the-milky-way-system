import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {assessmentSystem,assessmentSystemForEvents,validateAssessment} from '../runtime/srv/dsh-qq-ext/dsh-feiyu-mood/lib/ordinary-assessment.mjs';
import {runEventFormatProbe} from '../runtime/srv/dsh-qq-ext/dsh-tidal/event-format-probe.mjs';
test('event assessment has exactly one complete output schema and legacy mode is preserved',()=>{
 const source=fs.readFileSync(new URL('../runtime/srv/dsh-qq-ext/dsh-feiyu-mood/lib/ordinary-assessment.mjs',import.meta.url),'utf8');
 assert.match(source,/assessmentSystem/);assert.ok(assessmentSystem.includes('非空项格式'));assert.ok(!assessmentSystemForEvents.includes('非空项格式'));
 const line=assessmentSystemForEvents.split('\n').find(s=>s.startsWith('{"scope"'));const obj=JSON.parse(line),v=Object.values(obj.emotions)[0];
 assert.equal(v.eventRef,obj.events[0].id);assert.equal(v.evidence.source,'reply');assert.equal(v.evidence.subject,'paopao');assert.equal(v.evidence.mode,'direct');assert.equal(v.evidence.time,'current');assert.equal(Object.keys(v.evidence).includes('eventRef'),false);
});
function fixtureContext(kind='valid'){
 return {calls:[],llm:{async *stream(options){
  assert.equal(options.model,'deepseek-flash');assert.equal(options.reasoningEffort,'off');assert.equal(options.system,assessmentSystemForEvents);assert.ok(!options.tools);
  const input=JSON.parse(options.messages[0].content[0].text);
  const raw={scope:'observable',events:[{id:'e1',quote:input.user,subject:'owner',mode:'direct',confidence:90}],emotions:{},activity:{}};
  if(input.reply.includes('开心'))raw.emotions.happy={value:40,confidence:90,newEvent:true,eventRef:'e1',evidence:{source:'reply',subject:'paopao',mode:'direct',time:'current',quote:'我现在很开心',trigger:input.user}};
  if(kind==='missing')delete raw.emotions.happy?.eventRef;
  yield {type:'text-delta',text:JSON.stringify(raw)};yield {type:'finish',reason:{kind:kind==='incomplete'?'length':'stop'}};
 }}};
}
test('explicit probe accepts sourced emotion, rejects missing links, and never writes or sends',async()=>{
 const result=await runEventFormatProbe(fixtureContext(),'expressed',AbortSignal.timeout(1000));assert.equal(result.passed,true);assert.equal(result.stateWrites,0);assert.equal(result.QQSends,0);assert.equal(result.modelRequests,1);
 const missing=await runEventFormatProbe(fixtureContext('missing'),'expressed',AbortSignal.timeout(1000));assert.equal(missing.passed,false);assert.equal(missing.rejections[0].reason,'missing_or_invalid_event_reference');
 const incomplete=await runEventFormatProbe(fixtureContext('incomplete'),'expressed',AbortSignal.timeout(1000));assert.equal(incomplete.passed,false);
 const quote=await runEventFormatProbe(fixtureContext(),'quoted',AbortSignal.timeout(1000));assert.equal(quote.passed,true);assert.deepEqual(quote.acceptedAxes,[]);
 for(const id of ['constructor','toString','custom'])await assert.rejects(()=>runEventFormatProbe(fixtureContext(),id));
});
test('event linkage, exact quote, role and confidence checks still reject unsupported state',()=>{
 const input={mode:'conversation',eventPolicy:'xinghe-events-v1',user:'今天能陪你聊天',reply:'我现在很开心',scope:'session-test',eventId:'a'.repeat(64)};
 const valid=()=>({scope:'observable',events:[{id:'e1',quote:input.user,subject:'owner',mode:'direct',confidence:90}],emotions:{happy:{value:40,confidence:90,newEvent:true,eventRef:'e1',evidence:{source:'reply',quote:input.reply,trigger:input.user,subject:'paopao',mode:'direct',time:'current'}}},activity:{}});
 assert.equal(validateAssessment(valid(),input).emotions.happy.value,40);
 for(const mutate of [r=>delete r.emotions.happy.eventRef,r=>r.emotions.happy.eventRef='e2',r=>r.emotions.happy.evidence.subject='owner',r=>r.emotions.happy.evidence.quote='虚构的开心',r=>r.emotions.happy.confidence=20]){
  const r=valid();mutate(r);assert.deepEqual(validateAssessment(r,input).emotions,{});
 }
});
