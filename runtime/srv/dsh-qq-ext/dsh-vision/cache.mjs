import {createHash} from 'node:crypto';
const VERSION='vision-observer-20261029-group-v3';
export function cacheKey(scope,images,question,provider,model){
 if(typeof scope!=='string'||!/^(owner|group):\d+:session-[A-Za-z0-9-]+$/.test(scope))return null;
 return createHash('sha256').update(JSON.stringify({scope,version:VERSION,provider,model,question,images:images.map(b=>({id:b.attachment.attachmentId,mediaType:b.attachment.mediaType,width:b.attachment.width,height:b.attachment.height,timing:String(b.attachment.name||'').match(/frame-\d+-t\d+ms/)?.[0]||''}))})).digest('hex');
}
export class VisionCache{
 constructor({ttl=10*60*1000,maxEntries=64,maxBytes=1024*1024,now=Date.now}={}){if(!(ttl>0)||!Number.isInteger(maxEntries)||maxEntries<1||!(maxBytes>0))throw new RangeError('Invalid cache limits');Object.assign(this,{ttl,maxEntries,maxBytes,now});this.items=new Map();this.bytes=0;}
 drop(key){const v=this.items.get(key);if(v){this.bytes-=v.bytes;this.items.delete(key);}}
 get(key){if(!key)return null;const v=this.items.get(key);if(!v)return null;if(v.until<=this.now()){this.drop(key);return null;}this.items.delete(key);this.items.set(key,v);return structuredClone(v.value);}
 set(key,value){if(!key||value?.ok!==true)return;const copy=structuredClone(value),bytes=Buffer.byteLength(JSON.stringify(copy));if(bytes>this.maxBytes)return;this.drop(key);for(const [k,v]of this.items)if(v.until<=this.now())this.drop(k);while(this.items.size>=this.maxEntries||this.bytes+bytes>this.maxBytes)this.drop(this.items.keys().next().value);this.items.set(key,{value:copy,bytes,until:this.now()+this.ttl});this.bytes+=bytes;}
 stats(){return {entries:this.items.size,bytes:this.bytes,ttlSeconds:this.ttl/1000,maxEntries:this.maxEntries};}
 clear(){this.items.clear();this.bytes=0;}
}
