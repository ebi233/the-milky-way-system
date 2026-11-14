// Transport selection is server configuration, never an incoming message field.
export const transportPolicy = 'paopao-channel-transport-v1';
export function createTransportRegistry() {
  const drivers = new Map();
  return {
    register(name, driver) {
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(name) || drivers.has(name) || typeof driver.request !== 'function') throw Error('INVALID_TRANSPORT');
      drivers.set(name, driver);
    },
    async request(config, action, options = {}) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(action)) throw Error('INVALID_ACTION');
      const name = config.transport || 'onebot-http', driver = drivers.get(name);
      if (!driver) throw Error('TRANSPORT_UNAVAILABLE');
      return driver.request(config, action, options);
    },
    capabilities() { return [...drivers].map(([name, d]) => ({name, ...d.capabilities})); },
  };
}
export const channels = createTransportRegistry();
channels.register('onebot-http', {
  capabilities: {requiresExternalQQRuntime: true, independentQQ: false},
  async request(config, action, options) {
    const base = new URL(config.NapCat);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('INVALID_TRANSPORT_URL');
    const response = await fetch(base.href.replace(/\/$/, '') + '/' + action, {
      ...options, method: 'POST', redirect: 'error', signal: options.signal || AbortSignal.timeout(8000),
    });
    // Bound responses before existing consumers call json(); no whole-history download.
    const chunks = []; let bytes = 0;
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) { await response.body?.cancel(); throw Error('TRANSPORT_RESPONSE_BOUND'); }
    if(response.body) {
      const reader = response.body.getReader();
      try { while(true) { const {done,value}=await reader.read(); if(done)break; bytes+=value.byteLength; if(bytes>2*1024*1024)throw Error('TRANSPORT_RESPONSE_BOUND'); chunks.push(value); } }
      catch(e) { await reader.cancel().catch(()=>{}); throw e; }
      finally { reader.releaseLock(); }
    }
    return new Response(bytes ? Buffer.concat(chunks) : null, {status:response.status,headers:{'content-type':'application/json'}});
  },
});
export const requestChannel = (config, action, options) => channels.request(config, action, options);
