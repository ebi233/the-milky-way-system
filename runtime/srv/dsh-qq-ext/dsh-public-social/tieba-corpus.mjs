// Durable, reviewed source material. This is not an adopted expression or persona store.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {projectCard} from './browse-history.mjs';
const sourceId=(id,i,text)=>'pub-'+createHash('sha256').update(JSON.stringify([id,i,text])).digest('hex').slice(0,24);
function connect(home,write=false){
 const dir=join(home,'public-social'),file=join(dir,'tieba-corpus.sqlite');
 for(const p of [dir,file,file+'-journal',file+'-wal',file+'-shm']){
  try{const s=lstatSync(p);if(s.isSymbolicLink()||(p===dir?!s.isDirectory():!s.isFile()))throw Error('CORPUS_PATH_UNSAFE')}catch(e){if(e.code!=='ENOENT')throw e}
 }
 if(!write&&!existsSync(file))return null;
 if(write)mkdirSync(dir,{recursive:true,mode:0o700});
 const db=new DatabaseSync(file,{readOnly:!write,timeout:500,allowExtension:false});
 try{
  db.exec('PRAGMA cache_size=-1024; PRAGMA mmap_size=0;');
  if(write){
   chmodSync(file,0o600);
   db.exec(`CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,at INTEGER NOT NULL,json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS excerpts(id TEXT PRIMARY KEY,card_id TEXT NOT NULL,at INTEGER NOT NULL,json TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS excerpts_page ON excerpts(at DESC,id DESC);`);
  }
  return db;
 }catch(e){db.close();throw e}
}
export function archiveCard(home,value){
 const card=projectCard(value);if(!card||card.platform!=='tieba'||!card.id.startsWith('tieba:'))return false;
 const db=connect(home,true);
 try{
  db.exec('BEGIN IMMEDIATE');
  const inserted=db.prepare('INSERT OR IGNORE INTO cards VALUES(?,?,?)').run(card.id,Math.trunc(card.at),JSON.stringify(card)).changes;
  if(inserted)for(const [i,text] of card.excerpts.entries()){
   const item={id:sourceId(card.id,i,text),kind:'public_excerpt',turn:null,at:card.at,url:card.url,title:card.title,platform:'tieba',forum:card.forum,resolvedForum:card.resolvedForum,evidence:card.evidence,records:[{role:'public',text,messageId:card.id+':'+i,at:card.at,origin:'fetched_public_excerpt'}]};
   db.prepare('INSERT INTO excerpts VALUES(?,?,?,?)').run(item.id,card.id,Math.trunc(item.at),JSON.stringify(item));
  }
  db.exec('COMMIT');return !!inserted;
 }catch(e){try{db.exec('ROLLBACK')}catch{}throw e}finally{db.close()}
}
export function corpusMaterials(home,{beforeAt,beforeId,sourceId,limit=120,now=Date.now()}={}){
 const db=connect(home);if(!db)return [];
 try{
  let rows;
  if(sourceId)rows=db.prepare('SELECT json FROM excerpts WHERE id=? AND at<=?').all(sourceId,now);
  else{
   const time=Number.isFinite(beforeAt)?beforeAt:now+1;
   rows=db.prepare('SELECT json FROM excerpts WHERE at<=? AND (at<? OR (at=? AND id<?)) ORDER BY at DESC,id DESC LIMIT ?').all(now,time,time,beforeId||'',Math.max(1,Math.min(120,Math.trunc(limit)||120)));
  }
  return rows.map(x=>JSON.parse(x.json));
 }finally{db.close()}
}
export function corpusStats(home){
 const db=connect(home);if(!db)return {threads:0,excerpts:0};
 try{return {threads:db.prepare('SELECT count(*) AS n FROM cards').get().n,excerpts:db.prepare('SELECT count(*) AS n FROM excerpts').get().n};}finally{db.close()}
}
export function corpusHasCard(home,id){
 const db=connect(home);if(!db)return false;
 try{return !!db.prepare('SELECT 1 FROM cards WHERE id=?').get(id)}finally{db.close()}
}
