import {controlStore} from './store.mjs';
import {updateAxes,kernelVersion} from './state-kernel.mjs';
let last=null;
export const transitionStatus=()=>last?structuredClone(last):null;
export function transitionForAssessment(home,state,delta,now=Date.now()){
 let c;try{c=controlStore(home).read()}catch{return null}
 if(!c.enabled)return null;
 const points=[...Object.values(delta.emotions||{}),...Object.values(delta.activity||{})];
 const scopes=new Set(points.map(v=>v.scope));
 if(scopes.size!==1||typeof points[0]?.scope!=='string'||!points[0].scope||points[0].scope.length>160)throw Error('星河状态更新来源不一致');
 const result=updateAxes(state,delta,{now,session:points[0].scope,params:c.params});
 last={...result.receipt,version:kernelVersion,parameterRevision:c.revision};
 return result;
}
