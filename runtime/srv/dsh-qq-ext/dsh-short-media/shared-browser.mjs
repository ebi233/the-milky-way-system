// Compatibility names delegate to the live browser plugin, never a second backend.
let active;
export function registerBrowser(handler) {
  if (active) throw Error('浏览服务已注册');
  active = handler;
  return () => { if (active === handler) active = undefined; };
}
export async function browseShared(args, exec) {
  if (!active) throw Error('服务器浏览服务尚未就绪，请稍后再试');
  return active(args, exec);
}
export function legacyRequest(name, args = {}) {
  if (name === 'xhs_search' || name === 'dy_search') {
    const keyword = String(args.keyword || '').trim();
    if (!keyword || keyword.length > 100) throw Error('搜索关键词需为 1～100 字');
    return {platform: name === 'xhs_search' ? 'xiaohongshu' : 'douyin', action:'search', keyword};
  }
  if (name !== 'xhs_page') throw Error('未知浏览入口');
  let url;
  try { url = new URL(String(args.url || '').trim()); } catch { throw Error('请输入完整的平台内容链接'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('仅支持平台 HTTPS 内容链接');
  let platform, id;
  if (['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname)) {
    platform = 'xiaohongshu';
    id = url.pathname.match(/^\/(?:explore|search_result|discovery\/item)\/([a-zA-Z0-9]{1,40})\/?$/)?.[1];
  } else if (['douyin.com', 'www.douyin.com'].includes(url.hostname)) {
    platform = 'douyin';
    id = url.pathname.match(/^\/video\/(\d{1,40})\/?$/)?.[1];
    if (!id && url.pathname === '/') id = url.searchParams.get('modal_id');
    if (id && !/^\d{1,40}$/.test(id)) id = undefined;
  }
  if (!platform || !id) throw Error('请提供小红书笔记或抖音视频完整链接；短链接请先用平台搜索定位');
  const token = platform === 'xiaohongshu' ? (url.searchParams.get('xsec_token') || '') : '';
  if (token.length > 1500) throw Error('链接校验参数过长');
  return {platform, action:'detail', id, token};
}
export async function browseLegacy(name, args, exec) {
  const request = legacyRequest(name, args);
  const result = await browseShared(request, exec);
  // Keep the canonical status/error envelope; login failure must not become success.
  return {...result, source:'server-browser', operation:request.action};
}
