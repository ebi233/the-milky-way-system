import {readFileSync,writeFileSync,mkdirSync,lstatSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const digest=t=>createHash('sha256').update(t).digest('hex');
const validId=id=>/^v-[a-f0-9-]{36}$/.test(id);
function safe(p,dir=false){try{const s=lstatSync(p);if(s.isSymbolicLink()||(dir?!s.isDirectory():!s.isFile())||(!dir&&s.size>262144))throw Error('人格版本路径或大小异常');}catch(e){if(e.code!=='ENOENT')throw e;}}
function content(t){if(typeof t!=='string'||t.trim().length<40||t.length>32000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t))throw Error('人格正文须为40～32000字的有效文本');return t;}
export function personaVersions(home){
  const parent=join(home,'conversation-notes'),dir=join(parent,'self-persona'),versions=join(dir,'versions'),stateFile=join(dir,'state.json');
  function policy(){
    try{const p=JSON.parse(readFileSync(join(home,'self-persona-policy.json'),'utf8'));return p.enabled===true&&p.allowBoundaryEdit===true&&p.version===1;}catch{return false;}
  }
  function paths(){safe(parent,true);safe(dir,true);safe(versions,true);safe(stateFile);}
  function state(){
    paths();
    try{const s=JSON.parse(readFileSync(stateFile,'utf8'));if(s.version!==1||!Array.isArray(s.history)||s.history.length>128||!/^v-[a-f0-9-]{36}$/.test(s.active)||!/^[a-f0-9]{64}$/.test(s.baseHash))throw Error('人格版本索引异常');return s;}
    catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  function version(id){
    if(!validId(id))throw Error('无效版本编号');const s=state(),entry=s?.history.find(v=>v.id===id);if(!entry)throw Error('没有此历史版本');
    const file=join(versions,id+'.md');safe(file);const text=content(readFileSync(file,'utf8'));if(digest(text)!==entry.sha256)throw Error('人格版本校验失败');return {text,entry,file};
  }
  function current(){
    const base=content(readFileSync(join(home,'persona.md'),'utf8')),baseHash=digest(base);
    if(!policy())return {text:base,revision:'base:'+baseHash,baseHash,mode:'user_original',editingEnabled:false};
    const s=state();
    // A user's new source file takes precedence; old self edits never override it.
    if(!s||s.baseHash!==baseHash)return {text:base,revision:'base:'+baseHash,baseHash,mode:'user_original',editingEnabled:true,userSourceChanged:Boolean(s)};
    const v=version(s.active);return {text:v.text,revision:s.active,baseHash,mode:'self_edited',editingEnabled:true,file:v.file};
  }
  function commit(args,make){
    if(!policy())throw Error('自主编辑授权未开启');paths();mkdirSync(versions,{recursive:true,mode:0o700});
    const lock=join(dir,'write.lock');safe(lock);let fd;
    try{fd=openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('人格版本正在写入或旧锁待检查，未覆盖');throw e;}
    try{
      const old=current();if(args.expected_revision!==old.revision||args.expected_base_hash!==old.baseHash)throw Error('人格已变化，请重新 read，不能覆盖新版本');
      if(typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>240)throw Error('请用240字以内说明本次修改原因');
      const next=content(make(old.text)),s=state()||{version:1,history:[]};
      if(next===old.text)return {ok:true,unchanged:true,revision:old.revision};
      if(s.history.length>=128)throw Error('已保存128个人格版本，停止新增；请老哥检查归档，不自动删除备份');
      // Preserve each encountered manual baseline too, before any activation.
      const original=join(versions,'user-'+old.baseHash+'.md');safe(original);
      const baseline=readFileSync(join(home,'persona.md'));if(digest(baseline)!==old.baseHash)throw Error('用户原版同时发生修改，请重新读取');
      try{writeFileSync(original,baseline,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(digest(readFileSync(original))!==old.baseHash)throw Error('用户原版备份校验失败');}
      const id='v-'+randomUUID(),file=join(versions,id+'.md');writeFileSync(file,next,{flag:'wx',mode:0o600});
      s.history.push({id,sha256:digest(next),createdAt:Date.now(),actor:'paopao',reason:args.reason.trim(),previous:old.revision,baseHash:old.baseHash,action:args.action});
      s.baseHash=old.baseHash;s.active=id;
      const tmp=stateFile+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(s),{mode:0o600});renameSync(tmp,stateFile);
      return {ok:true,revision:id,sha256:digest(next),file,effective:'next_prompt_assembly',restartRequired:false};
    }finally{closeSync(fd);unlinkSync(lock);}
  }
  return {
    current,
    history(){const c=current();return {revision:c.revision,baseHash:c.baseHash,editingEnabled:c.editingEnabled,history:state()?.history||[]};},
    replace(args){return commit(args,()=>args.text);},
    edit(args){return commit(args,old=>{if(typeof args.old_text!=='string'||!args.old_text||typeof args.new_text!=='string')throw Error('需要精确的旧片段与新片段');const first=old.indexOf(args.old_text);if(first<0||old.indexOf(args.old_text,first+args.old_text.length)>=0)throw Error('旧片段未找到或不唯一，请重新 read');return old.slice(0,first)+args.new_text+old.slice(first+args.old_text.length);});},
    rollback(args){return commit(args,()=>args.version_id==='user_original'?readFileSync(join(home,'persona.md'),'utf8'):version(args.version_id).text);},
  };
}
