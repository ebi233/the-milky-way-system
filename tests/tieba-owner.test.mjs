import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const home=fs.mkdtempSync(join(tmpdir(),'xinghe-tieba-owner-'));process.env.DSH_HOME=home;
globalThis.fetch=()=>{throw Error('NO_NETWORK')};
fs.writeFileSync(join(home,'qq-bridge-config.json'),JSON.stringify({主人号码:'10001',绑定:[{类型:'私聊',号码:'10001',会话:'session-owner'},{类型:'群',号码:'10002',会话:'session-group'}]}));
fs.writeFileSync(join(home,'guests.json'),'{}');
const {expressionLibrary,selectExpressions}=await import('../runtime/srv/dsh-qq-ext/dsh-long-memory/lib/expression-library.mjs');
const {recordCard}=await import('../runtime/srv/dsh-qq-ext/dsh-public-social/browse-history.mjs');
const {tiebaPolicy}=await import('../runtime/srv/dsh-qq-ext/dsh-public-social/tieba-source.mjs');
const agent={id:'session-owner',session:{header:{id:'session-owner'}}};
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('owner tool exposes independent forum selection; visitors and groups cannot change it',async()=>{
 const before=await expressionLibrary(agent,{action:'forums'});assert.equal(before.initialized,false);
 const result=await expressionLibrary(agent,{action:'follow_forum',forum:'园艺',reason:'我想看看养花的人怎么聊天',revision:before.revision});assert.equal(result.changed,true);assert.equal(result.accountFollowPerformed,false);
 for(const id of ['session-visitor','session-group'])await assert.rejects(expressionLibrary({id,session:{header:{id}}},{action:'follow_forum',forum:'烹饪',reason:'想看看',revision:result.revision}));
 const after=await expressionLibrary(agent,{action:'forums'});assert.equal(after.forums.at(-1).name,'园艺');assert.equal(after.revision,result.revision);
});
test('reviewed Tieba evidence reaches real expression tool with exact quotes, without automatic imitation',async()=>{
 const text='我那盆花还没动静，明早再去看看。';recordCard(home,{id:'tieba:123456789',platform:'tieba',title:'阳台上的花',learningReview:tiebaPolicy,evidence:'public_thread_excerpt',excerpts:[text]});
 const materials=await expressionLibrary(agent,{action:'materials',sourceKind:'public_excerpt'});assert.equal(materials.items.length,1);assert.equal(materials.items[0].records[0].text,text);
 const learned=await expressionLibrary(agent,{action:'learn',sourceKind:'public_excerpt',sourceId:materials.items[0].id,quote:text,scene:'daily',lesson:'顺着眼前的小事接着说'});assert.equal(learned.entry.status,'candidate');
 const adopted=await expressionLibrary(agent,{action:'activate',id:learned.entry.id,revision:learned.entry.revision,reason:'这句接得很轻松'});assert.equal(adopted.entry.status,'active');
 const saved=await expressionLibrary(agent,{action:'read',id:adopted.entry.id});const selected=selectExpressions([saved.entry],'我那盆花还没动静，明早再去看看。','session-owner');assert.ok(!JSON.stringify(selected).includes(text));
});
