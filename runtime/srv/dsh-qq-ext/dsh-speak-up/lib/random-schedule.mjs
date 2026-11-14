export function randomWindow(config, date = new Date()) {
  let hour;
  try {hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:config.峰谷时区||'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(date));}
  catch {hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(date));}
  const night=config.分时随机===true && hour>=1 && hour<8;
  const min=Math.max(1,Math.min(1440,Number(night?config.凌晨最短分钟:config.随机最短分钟)||10));
  const max=Math.max(min,Math.min(1440,Number(night?config.凌晨最长分钟:config.随机最长分钟)||120));
  return {period:night?'night':'day',min,max,timeZone:config.峰谷时区||'Asia/Shanghai'};
}
export function randomMinutes(config, random = Math.random, date = new Date()) {
  const {min,max}=randomWindow(config,date);
  return min + Math.max(0, Math.min(1, random())) * (max - min)
}
