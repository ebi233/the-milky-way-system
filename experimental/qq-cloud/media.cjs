'use strict';
// Local image objects, addressed by content; never accepts arbitrary file paths or URLs.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const MAX_IMAGE=8*1024*1024,MAX_TOTAL=64*1024*1024;
function dimensions(b){
 let width,height,extension;
 if(b.length>=33&&b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&b.toString('ascii',12,16)==='IHDR'){
  width=b.readUInt32BE(16);height=b.readUInt32BE(20);extension='png';
 }else if(b.length>4&&b[0]===255&&b[1]===216){
  extension='jpg';let i=2,segments=0;
  while(i+4<=b.length&&segments++<512){
   if(b[i++]!==255)throw Error('INVALID_JPEG');while(b[i]===255)i++;
   const marker=b[i++];if(marker===217||marker===218)break;
   if(marker===1||(marker>=208&&marker<=215))continue;
   if(i+2>b.length)break;const size=b.readUInt16BE(i);if(size<2||i+size>b.length)throw Error('INVALID_JPEG');
   if([192,193,194].includes(marker)&&size>=8){height=b.readUInt16BE(i+3);width=b.readUInt16BE(i+5);break;}i+=size;
  }
 }else throw Error('ONLY_PNG_JPEG_SUPPORTED');
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>16000000)throw Error('IMAGE_DIMENSIONS_OUT_OF_BOUNDS');
 return {width,height,extension};
}
function createMediaStore(dir,{nativeRoot='/home/qq/.config/QQ'}={}){
 const root=path.join(dir,'media');fs.mkdirSync(root,{recursive:true,mode:0o700});
 const idPattern=/^[a-f0-9]{64}\.(png|jpg)$/;
 function describe(b){if(!Buffer.isBuffer(b)||b.length<16||b.length>MAX_IMAGE)throw Error('IMAGE_SIZE_OUT_OF_BOUNDS');return {...dimensions(b),size:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),md5:crypto.createHash('md5').update(b).digest('hex')};}
 function put(b){
  const d=describe(b),id=d.sha256+'.'+d.extension,p=path.join(root,id);
  if(!fs.existsSync(p)){
   const files=fs.readdirSync(root);if(files.length>=64)throw Error('MEDIA_CAPACITY');
   let size=0;for(const f of files)size+=fs.lstatSync(path.join(root,f)).size;
   if(size+b.length>MAX_TOTAL)throw Error('MEDIA_CAPACITY');
   const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}catch(e){fs.closeSync(fd);fs.unlinkSync(p);throw e;}fs.closeSync(fd);
  }
  return {id,...d};
 }
 function get(id){
  if(typeof id!=='string'||!idPattern.test(id))throw Error('INVALID_MEDIA_ID');
  const p=path.join(root,id),st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_IMAGE)throw Error('INVALID_MEDIA_FILE');
  const b=fs.readFileSync(p),d=describe(b);if(d.sha256+'.'+d.extension!==id)throw Error('MEDIA_HASH_MISMATCH');
  return {id,...d,path:p,bytes:b};
 }
 function importNative(p,expectedMd5){
  if(typeof p!=='string'||p.length>2048||!path.isAbsolute(p))throw Error('INVALID_NATIVE_MEDIA_PATH');
  const base=fs.realpathSync(nativeRoot),real=fs.realpathSync(p),rel=path.relative(base,real);
  if(rel.startsWith('..')||path.isAbsolute(rel)||!rel)throw Error('NATIVE_MEDIA_OUTSIDE_ACCOUNT');
  const st=fs.statSync(real);if(!st.isFile()||st.size>MAX_IMAGE)throw Error('IMAGE_SIZE_OUT_OF_BOUNDS');
  const b=fs.readFileSync(real),d=describe(b);if(!/^[a-fA-F0-9]{32}$/.test(expectedMd5||'')||d.md5!==expectedMd5.toLowerCase())throw Error('NATIVE_MEDIA_HASH_MISMATCH');
  return put(b);
 }
 function element(id){const m=get(id);return {elementType:2,elementId:'',picElement:{md5HexStr:m.md5,fileSize:String(m.size),picWidth:m.width,picHeight:m.height,fileName:m.id,sourcePath:m.path,original:true,picType:m.extension==='png'?1001:1000,picSubType:0,fileUuid:'',fileSubId:'',thumbFileSize:0,summary:'',isFlashPic:false}};}
 function stageNative(id,destination){
  const m=get(id),base=fs.realpathSync(nativeRoot);
  if(typeof destination!=='string'||destination.length>2048||!path.isAbsolute(destination))throw Error('INVALID_NATIVE_DESTINATION');
  const rel=path.relative(base,destination);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('NATIVE_MEDIA_OUTSIDE_ACCOUNT');
  let parent=path.dirname(destination);while(!fs.existsSync(parent))parent=path.dirname(parent);
  const realRel=path.relative(base,fs.realpathSync(parent));if(realRel.startsWith('..')||path.isAbsolute(realRel))throw Error('NATIVE_MEDIA_OUTSIDE_ACCOUNT');
  fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  if(fs.existsSync(destination)){if(fs.lstatSync(destination).isSymbolicLink())throw Error('INVALID_NATIVE_DESTINATION');const existing=fs.statSync(destination);if(existing.size!==m.size||crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')!==m.sha256)throw Error('NATIVE_DESTINATION_CONFLICT');}
  else fs.copyFileSync(m.path,destination,fs.constants.COPYFILE_EXCL);
  return destination;
 }
 const downloads=path.join(dir,'downloads');fs.mkdirSync(downloads,{recursive:true,mode:0o700});
 function downloadPath(key){if(!/^\d{1,24}:\d{1,24}$/.test(key))throw Error('INVALID_IMAGE_KEY');return path.join(downloads,key.replace(':','-')+'.image');}
 function finishDownload(key,md5){const p=downloadPath(key),st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_IMAGE)throw Error('INVALID_DOWNLOAD');const b=fs.readFileSync(p);if(describe(b).md5!==md5.toLowerCase())throw Error('NATIVE_MEDIA_HASH_MISMATCH');const item=put(b);fs.unlinkSync(p);return item;}
 return {put,get,importNative,element,downloadPath,finishDownload,stageNative};
}
module.exports={createMediaStore,dimensions,MAX_IMAGE};
