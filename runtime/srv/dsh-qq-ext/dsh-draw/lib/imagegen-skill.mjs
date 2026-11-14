// Portable workflow adapted from Codex imagegen SKILL.md and references/prompting.md.
// This is a prompt/workflow adapter, not access to the ChatGPT built-in service.
import {readFileSync,realpathSync} from 'node:fs';
import {join,sep} from 'node:path';
import {createHash} from 'node:crypto';
export const imagegenPolicy='portable-imagegen-workflow-v1';
const labels={use_case:'Use case',asset_type:'Asset type',scene:'Scene/backdrop',subject:'Subject',style:'Style/medium',composition:'Composition/framing',lighting:'Lighting/mood',palette:'Color palette',materials:'Materials/textures',text:'Text (verbatim)',preserve:'Must preserve',avoid:'Avoid'};
export const specSchema={type:'object',description:'可选创作规格；只填本次需要的内容，不擅自增加角色、道具或设定。',properties:Object.fromEntries(Object.keys(labels).map(k=>[k,{type:'string',description:labels[k]}])),additionalProperties:false};
export const capabilities={planning:true,generateWithAppearanceReference:true,automaticCandidateReview:true,targetedCandidateRevision:true,arbitraryImageEditing:false,transparentAlpha:false,chatgptBuiltinAccess:false,provider:'existing_bailian_qwen_image'};
function text(value,name,max=1600){
 if(typeof value!=='string')throw Error(name+' 必须是文字');
 if(value.length>max)throw Error(name+' 超过长度限制');
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))throw Error(name+' 含非法控制字符');
 return value.trim();
}
function checkIntent(args){
 if(args.intent!==undefined&&args.intent!=='generate')throw Error('当前通道仅支持外观参考生成及候选自动定向返工；不能把任意图片编辑请求当成新图重画。请保留编辑目标，另行接入编辑能力。');
 if(args.transparent_background!==undefined&&typeof args.transparent_background!=='boolean')throw Error('transparent_background 必须是布尔值');
 if(args.transparent_background===true)throw Error('当前通道未验证透明 alpha 输出，不能把白色或棋盘背景当作透明图交付。');
 for(const k of ['image','images','reference','reference_images','edit_target','source_image','mask'])if(args[k]!==undefined)throw Error('暂不接受自定义图片路径；当前只使用已确认的外观参考。');
}
export function compileImageSpec(args={}){
 checkIntent(args);
 const prompt=text(args.prompt,'prompt',12000);if(!prompt)throw Error('请先提供本次画面需求');
 const spec=args.spec??{};
 if(!spec||typeof spec!=='object'||Array.isArray(spec))throw Error('spec 必须是对象');
 const normalized={};
 for(const [k,v] of Object.entries(spec)){
  if(!Object.hasOwn(labels,k))throw Error('未知创作规格字段：'+k);
  const s=text(v,k);if(s)normalized[k]=k==='text'?v:s;
 }
 // No invented hairstyle, props, pose, setting or intimacy. The approved image is identity only.
 const lines=['Primary request: '+prompt,
  'Input images: Image 1 is an identity reference, not an edit target. Preserve character identity; do not copy its background, outfit or pose unless requested.'];
 for(const [k,label] of Object.entries(labels))if(normalized[k])lines.push(label+': '+(k==='text'?JSON.stringify(normalized[k]):normalized[k]));
 lines.push('Constraints: Follow the stated request. Do not invent extra characters, props, slogans or identity changes. Keep lighting and coherent detail; remove false textures without flattening the whole image.');
 const compiled=lines.join('\n');if(compiled.length>12000)throw Error('合并后的画面规格超过12000字符，请缩短描述');
 return {prompt:compiled,sourcePrompt:prompt,spec:normalized};
}
export function appearanceReference(home){
 const base=realpathSync(join(home,'appearance-assets'));
 const file=realpathSync(join(base,'paopao-window-v3-20261101.png'));
 if(!file.startsWith(base+sep))throw Error('外观参考超出受管目录');
 const data=readFileSync(file);
 if(data.length<24||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('外观参考不是有效PNG');
 return {role:'identity_reference',sha256:createHash('sha256').update(data).digest('hex'),customReferenceAllowed:false};
}
export function imagegenGuide(){return {policy:imagegenPolicy,capabilities,
 workflow:['先区分新图、外观参考和编辑目标；不要把编辑偷换成重画。','需求已具体时只整理；简略时自行选择必要构图，不额外改变身份设定。','可用 prepare 整理规格；也可直接 draw_image 提交 prompt 和可选 spec。','生成后的实际图片由已有 Flash 独立审图流程检查；路径存在不等于看过或通过。','返工只改明确的问题，重复保留项；最多两次自动返工，不满意或看不到则保留候选并如实报告。','批准后由原投递流程回传；只有匹配图片的QQ回执才能说已发送。'],
 reviewChecklist:['角色身份和参考一致','尾巴连接在骨盆后方、脊柱末端（入镜时）','四肢、手指及遮挡','姿势与构图','服装','背景透视和假纹理','材质与头发','光影','本次保留项与精确文字'],
 limits:['技能不含模型权限或订阅额度；生图仍使用已配置的百炼渠道。','prepare 不调用模型、不创建任务、不产生生图费用；真正调用 draw_image 仍按原渠道计费。','没有任意图片编辑或透明alpha支持，不能声称已实现。','每个任务一张图；多个构图分别提交，不拼成未要求的联系表。']};}
export function prepareImage(args,home){
 const built=compileImageSpec(args),reference=appearanceReference(home);
 return {policy:imagegenPolicy,prepared:true,submitted:false,reference,
  preview:built.prompt,draw_image_args:{prompt:built.sourcePrompt,spec:built.spec,intent:'generate',...Object.fromEntries(['width','height','seed'].filter(k=>args[k]!==undefined).map(k=>[k,args[k]]))},
  next:'需要出图时调用 draw_image，并使用 draw_image_args。这个结果只是创作规格，不是图片或已提交的任务。'};
}
