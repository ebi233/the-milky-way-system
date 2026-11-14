import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export function readObject(path,fallback={}) {
  try {const value=JSON.parse(readFileSync(path,'utf8'));if(!value || Array.isArray(value) || typeof value!=='object')throw new Error('Invalid state object');return value;}
  catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
export function writeObject(path,value) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const tmp=path+'.'+randomUUID()+'.tmp';
  writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,path);
}
export function singleFlight(fn) {
  let active=null;
  return (...args)=>{
    if(active)return active;
    active=Promise.resolve().then(()=>fn(...args)).finally(()=>{active=null;});
    return active;
  };
}
export function verifyManaged(path) {
  try {
    const manifest=readObject(path);if(manifest.version!==1 || !manifest.files)return {ok:false,reason:'manifest_unavailable'};
    const changed=[];
    for(const [file,expected] of Object.entries(manifest.files)){
      try{if(createHash('sha256').update(readFileSync(file)).digest('hex')!==expected)changed.push(file);}
      catch{changed.push(file);}
    }
    return {ok:changed.length===0,checked:Object.keys(manifest.files).length,changed};
  }catch{return {ok:false,reason:'manifest_unreadable'};}
}
