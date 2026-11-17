// Bind tools to the same live scheduler: one lock, one budget, no second reader.
const services=new Map();
export function bindTiebaService(home,service){
 if(services.has(home))throw Error('TIEBA_SERVICE_ALREADY_BOUND');
 services.set(home,service);
 return ()=>{if(services.get(home)===service)services.delete(home)};
}
export function tiebaReadingStatus(home){
 const service=services.get(home);
 return service?service.readingStatus():{serviceReady:false,outcome:'reader_not_ready',cachedMaterialCheck:'materials platform=tieba',freshRead:false};
}
export async function browseFollowedForum(home,forum,signal){
 signal?.throwIfAborted();const service=services.get(home);
 return service?service.readNow({forum},signal):tiebaReadingStatus(home);
}
