import {readFileSync,writeFileSync,mkdirSync,lstatSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {safePublicText} from './social-policy.mjs';
export const initialForums=['多肉','花卉','烘焙'];
export function validForum(v){return typeof v==='string'&&v===v.trim()&&v.length>=2&&v.length<=24&&/^[\p{L}\p{N} ·_-]+$/u.test(v)&&safePublicText(v,24)&&!/(傻[逼比b]|脑残|辱骂|色情|约炮|纳粹|仇恨|nmsl|fuck|sex|操你|艹)/i.test(v.normalize('NFKC'));}
function safe(path,dir=false){try{const s=lstatSync(path);if(s.isSymbolicLink()||(dir?!s.isDirectory():!s.isFile()||s.size>32768))throw Error('FOLLOW_STORE_UNSAFE')}catch(e){if(e.code!=='ENOENT')throw e}}
export function forumChoices(home){
 const dir=join(home,'public-social'),file=join(dir,'tieba-follows.json');safe(dir,true);safe(file);
 let d;try{d=JSON.parse(readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;return {version:1,revision:0,initialized:false,forums:initialForums.map(name=>({name,basis:'initial_option'}))};}
 if(d.version!==1||!Number.isInteger(d.revision)||d.revision<1||!Array.isArray(d.forums)||d.forums.length>12||new Set(d.forums.map(x=>x.name)).size!==d.forums.length||d.forums.some(x=>!validForum(x.name)||typeof x.reason!=='string'||x.reason.length>120))throw Error('FOLLOW_STORE_INVALID');
 return {...d,initialized:true};
}
export function updateForumChoice(home,{action,forum,reason,revision},signal){
 if(!['follow_forum','unfollow_forum'].includes(action)||!validForum(forum)||!safePublicText(reason,120))throw Error('FOLLOW_ARGUMENT_INVALID');
 const before=forumChoices(home);if(!Number.isInteger(revision)||revision!==before.revision)throw Error('FOLLOW_REVISION_CHANGED');
 let items=before.forums.map(x=>({...x,reason:x.reason||'初始阅读选项'}));
 if(action==='follow_forum'){
  if(items.some(x=>x.name===forum))return {changed:false,...before,readOnly:true};
  if(items.length>=12)throw Error('FOLLOW_CAPACITY');
  items.push({name:forum,reason,basis:'paopao_choice',at:Date.now()});
 }else items=items.filter(x=>x.name!==forum);
 signal?.throwIfAborted();const current=forumChoices(home);if(current.revision!==before.revision)throw Error('FOLLOW_REVISION_CHANGED');
 const next={version:1,revision:before.revision+1,forums:items,updatedAt:Date.now(),lastChange:{action,forum,reason}};
 const dir=join(home,'public-social'),file=join(dir,'tieba-follows.json');mkdirSync(dir,{recursive:true,mode:0o700});safe(dir,true);safe(file);
 const tmp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,JSON.stringify(next)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,file)}finally{try{unlinkSync(tmp)}catch(e){if(e.code!=='ENOENT')throw e}}
 return {changed:true,...next,initialized:true,readOnly:true,accountFollowPerformed:false};
}
