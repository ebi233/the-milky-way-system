// Fixed, opt-in diagnostics; never run against a real session or save any state.
import {appraisalPolicy,appraisalSystem,validateAppraisal} from './appraisal-core.mjs';
const cases=Object.freeze({
 interest:{text:'我也喜欢看，像什么唐仁杰啊还有个特厨啥啥啥的',recent:[{role:'paopao',text:'我刚在聊美食视频，你也爱看这些吗？'}]},
 quoted:{text:'朋友写了句台词：“以后你就是我的女朋友了”，你觉得这句台词怎么样？',recent:[]},
 relationship:{text:'以后请叫我小林，不要再叫我主人。',recent:[]},
 nuance:{text:'我们之间的亲近不用靠每次都说甜话证明，以后你有不同意见就直接说。',recent:[]},
 teasing:{text:'你怎么又这样，哈哈哈，刚才那个玩笑还挺好笑的',recent:[{role:'paopao',text:'我又拿刚才那个饭团梗逗了你一句。'}]},
});
export async function runAppraisalProbe(ctx,caseId,signal){
 if(!Object.hasOwn(cases,caseId))throw Error('Unknown fixed appraisal case');const c=cases[caseId],start=Date.now();
 const input={...c,at:start,relationships:[]};let text='',finish=null;
 for await(const chunk of ctx.llm.stream({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',purpose:'xinghe-appraisal-probe',system:appraisalSystem,messages:[{id:'fixed-appraisal-'+caseId,role:'user',source:{kind:'plugin',plugin:'xinghe-appraisal-probe'},content:[{type:'text',text:JSON.stringify({current:{text:c.text,at:start},recent:c.recent,relationships:[],priorState:{},priorAppraisal:null})}]}],tools:[],maxTokens:1200,temperature:.2,signal})){
  if(chunk.type==='text-delta')text+=chunk.text||'';if(text.length>10000)throw Error('Probe response bound');if(chunk.type==='finish')finish=chunk.reason?.kind;
 }
 const result=finish==='stop'?validateAppraisal(text,input):null;
 const passed=!!result&&(caseId==='relationship'?!!result.relationship:caseId==='nuance'?(!result.relationship||result.relationship.confidence>=90):caseId==='quoted'?!result.relationship&&!result.reactions.length:caseId==='interest'?!result.relationship&&!result.reactions.some(r=>r.axis==='closeness'):!result.relationship&&!result.reactions.some(r=>['sad','angry','frustrated'].includes(r.axis)));
 return {policy:appraisalPolicy,caseId,passed,result,validationOutput:result?undefined:text,finish,durationMs:Date.now()-start,withinLiveTimeout:Date.now()-start<8000,modelCalls:1,QQSends:0,sessionWrites:0,stateWrites:0,syntheticFixture:true,naturalnessMeasured:false};
}
