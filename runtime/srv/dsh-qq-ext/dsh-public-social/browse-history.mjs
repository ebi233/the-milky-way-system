import {mkdirSync,writeFileSync,renameSync,accessSync,constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {read,safePublicText,canonicalSource} from './social-policy.mjs';
import {gentleText,tiebaPolicy} from './tieba-source.mjs';
const outcomes=new Set(['read','picked','skipped','decision_failed','budget_skipped']);
const deliveries=new Set(['publishing','published','unconfirmed']);
const depthCodes=new Set(['read','empty','no_subtitle','login_required','platform_restricted','timeout','read_failed','result_limit','unavailable','filtered','legacy']);
export function projectCard(v){
  const url=canonicalSource(v?.id);
  if(!url||!safePublicText(v?.title,300)||!Number.isFinite(v?.at))return null;
  if(v.id.startsWith('tieba:')&&(v.learningReview!==tiebaPolicy||!gentleText(v.title,300)||!Array.isArray(v.excerpts)||!v.excerpts.length||v.excerpts.length>3||v.excerpts.some(x=>!gentleText(x,160))))return null;
  return {id:v.id,url,title:v.title,at:v.at,platform:String(v.platform||'').slice(0,30),
    outcome:outcomes.has(v.outcome)?v.outcome:'read',
    reason:['interesting','not_selected','model_or_budget_failed','insufficient_content'].includes(v.reason)?v.reason:'',
    evidence:['public_subtitle_excerpt','public_description_and_comments','public_title_description_only','rendered_public_page','public_thread_excerpt'].includes(v.evidence)?v.evidence:'public_title_description_only',
    subtitle:depthCodes.has(v.subtitle)?v.subtitle:'legacy',comments:depthCodes.has(v.comments)?v.comments:'legacy',
    excerpts:Array.isArray(v.excerpts)?v.excerpts.slice(0,4).filter(x=>typeof x==='string'&&safePublicText(x,600)):[],
    learningReview:v.id.startsWith('tieba:')?tiebaPolicy:null,truncated:!!v.truncated,observation:safePublicText(v.observation,450)?v.observation:'',
    delivery:deliveries.has(v.delivery)?v.delivery:null,deliveryAt:Number.isFinite(v.deliveryAt)?v.deliveryAt:null};
}
export function history(home){
  const v=read(join(home,'public-social/browse-history.json'),{items:[]});
  return {version:1,items:(Array.isArray(v.items)?v.items:[]).slice(0,80).map(projectCard).filter(Boolean)};
}
export function recordCard(home,source,patch={},at=Date.now()){
  const h=history(home),old=h.items.find(v=>v.id===source.id);
  const item=projectCard({...old,id:source.id,title:source.title,platform:source.platform||old?.platform||'bilibili',at:old?.at||at,
    learningReview:source.learningReview||old?.learningReview,evidence:source.evidence||old?.evidence,subtitle:source.subtitle?.status||old?.subtitle,comments:source.comments?.status||old?.comments,
    excerpts:source.excerpts||(source.subtitle||source.comments?[...(source.subtitle?.status==='read'?[source.subtitle.text?.slice(0,600)]:[]),...(source.comments?.status==='read'?source.comments.snippets||[]:[])].filter(Boolean):old?.excerpts||[]),
    truncated:source.subtitle?.truncated??old?.truncated,...patch});
  if(!item)return;
  h.items=[item,...h.items.filter(v=>v.id!==item.id)].slice(0,80);
  const file=join(home,'public-social/browse-history.json');mkdirSync(join(file,'..'),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(h)+'\n',{mode:0o600});renameSync(tmp,file);
}
export function depthDiagnostics(home){
  const can=(p,mode)=>{try{accessSync(p,mode);return true}catch{return false}};
  const old=read(join(home,'bili-duty/config.json'),{});
  return {version:'bili-depth-v1',pythonReady:can(join(home,'bili-duty/.venv/bin/python'),constants.X_OK),
    credentialFileReadable:can(join(home,'bili-duty/bili_credential.json'),constants.R_OK),
    legacyAutoDisabled:old.autoMode==='manual',model:'deepseek-flash',reasoning:'off',
    subtitleCharacterLimit:1800,commentLimit:3,readerTimeoutSeconds:22,historyLimit:80,
    loginVerified:false,notes:'Credential file presence is not a successful login check; see last subtitle/comment result.'};
}
