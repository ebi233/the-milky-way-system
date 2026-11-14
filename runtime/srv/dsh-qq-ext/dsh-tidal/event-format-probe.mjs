// Explicit maintenance probe only: no schedules, session writes, tools, or QQ sends.
import {createHash} from 'node:crypto';
import {assessmentSystemForEvents,assessmentInput,validateAssessment,policyVersion} from '../dsh-feiyu-mood/lib/ordinary-assessment.mjs';
const cases=Object.freeze({
 expressed:{user:'我真的很喜欢和你聊天。',reply:'听你这么说，我现在很开心，还想跟你再聊一会。',expectState:true},
 quoted:{user:'朋友说：“我很难过”，这是小说里的台词。',reply:'你说的“我很难过”是人物台词，我在讨论这段文字。',expectState:false},
});
export async function runEventFormatProbe(ctx,caseId,signal){
 if(!Object.hasOwn(cases,caseId))throw Error('Unknown fixed event-format case');const c=cases[caseId];
 const eventId=createHash('sha256').update(caseId).digest('hex');
 const input=JSON.parse(assessmentInput(c.user,c.reply,false,'session-event-format-probe',eventId,{kind:'maintenance_fixture',messageId:'fixture-'+caseId,at:Date.now()},true));
 let text='',finish=null;
 for await(const chunk of ctx.llm.stream({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',system:assessmentSystemForEvents,messages:[{id:'event-probe-'+caseId,role:'user',source:{kind:'plugin',plugin:'dsh-feiyu-mood'},content:[{type:'text',text:JSON.stringify(input)}]}],maxTokens:1600,temperature:.2,signal})){
  if(chunk.type==='text-delta')text+=chunk.text||'';
  if(chunk.type==='finish')finish=chunk.reason?.kind;
  if(text.length>12000)throw Error('Event probe response bound');
 }
 const observation=finish==='stop'?validateAssessment(text,input):null;
 const card=observation?.eventCard,axes=observation?[...Object.keys(observation.emotions),...Object.keys(observation.activity)]:[];
 return {caseId,validatorVersion:policyVersion,model:'deepseek-flash',effort:'off',finish,parsed:!!card,eventCount:card?.events.length||0,acceptedAxes:axes,rejections:card?.rejectionDetails||[],passed:!!card&&card.events.length>0&&(c.expectState?axes.length>0:axes.length===0),visibleOutputCharacters:text.length,modelRequests:1,QQSends:0,sessionWrites:0,stateWrites:0,syntheticFixture:true,naturalnessMeasured:false};
}
