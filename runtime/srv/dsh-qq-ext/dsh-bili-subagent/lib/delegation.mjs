export function startScan(runtime,{parent,prompt,provider,model,signal,label}){
  const request={parent,prompt:[{type:'text',text:prompt}],signal,
    ...(provider&&model?{agentOptions:{provider,model}}:{})};
  if(typeof runtime?.start==='function')return runtime.start('spawn',{...request,label});
  if(typeof runtime?.startActivation==='function')return runtime.startActivation({provider:'spawn',label,
    request:{parent,prompt:request.prompt,...(request.agentOptions?{agentOptions:request.agentOptions}:{})},signal,delivery:'caller'});
  throw new Error('当前宿主缺少兼容的子代理启动接口');
}
export function mayShareAutoScan(why,box){
  return String(why).startsWith('window:') && (!Array.isArray(box)||!box.some(item=>item?.kind==='dm'));
}
export function ownerTarget(config,target){
  const key=s=>String(s??'').trim().replace(/^session-/,'');
  return /^\d+$/.test(String(config.主人号码||''))&&key(target)!==''&&key(target)===key(config.私聊会话);
}
