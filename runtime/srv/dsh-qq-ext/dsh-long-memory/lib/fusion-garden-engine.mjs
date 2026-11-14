// Adapter only. Combat, economy, projectiles, waves and win/loss are upstream MIT code.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const configSource=readFileSync(new URL('./garden-upstream/js/config.js',import.meta.url),'utf8');
const engineSource=readFileSync(new URL('./garden-upstream/js/game.js',import.meta.url),'utf8');
export const UPSTREAM={repo:'https://github.com/CyanCat22/plants-vs-zombies',commit:'b13a3808f45a0e784ab507fd388c1b876d9cfbe6',license:'MIT'};
export const VERSION=2;
export const ADAPTER_VERSION=3; // Compatible with existing v2 saved boards.
export const RECIPES=[
  ['peashooter','sunflower','solar_pea'],['peashooter','peashooter','repeater'],
  ['peashooter','wallnut','wall_pea'],['sunflower','sunflower','twin_sun'],
  ['wallnut','wallnut','giant_nut'],['peashooter','snowpea','frost_pea'],['wallnut','snowpea','frost_wall'],
  ['repeater','peashooter','gatling'],['solar_pea','peashooter','solar_repeater'],
  ['wall_pea','peashooter','wall_repeater'],['frost_pea','peashooter','ice_gatling'],
  ['twin_sun','sunflower','triple_sun'],['giant_nut','wallnut','fortress_nut'],
  ['frost_wall','peashooter','frost_wall_repeater'],['solar_pea','snowpea','frost_solar'],
];
function must(v,msg){if(!v)throw Error(msg);}
export function integer(n,min,max,label){must(Number.isInteger(n)&&n>=min&&n<=max,label+'超出范围');return n;}
function runtime(seed=1,difficulty='normal'){
  integer(seed,0,4294967295,'种子');must(['normal','training'].includes(difficulty),'难度应为 normal/training');
  let rng=seed;
  const math=Object.create(Math);math.random=()=>{rng=(Math.imul(1664525,rng)+1013904223)>>>0;return rng/4294967296;};
  // No browser, network, rendering, background timers, or npm dependencies.
  const env=vm.createContext({window:{},Math:math,performance:{now:()=>0}});
  vm.runInContext(configSource,env,{timeout:1000,filename:'upstream/config.js'});
  const cfg=env.window.PVZ_CONFIG,p=cfg.PLANTS;
  Object.assign(p,{
    solar_pea:{...p.peashooter,name:'向日葵射手',hp:450,extraSun:25,sunEvery:23},
    wall_pea:{...p.peashooter,name:'坚果射手',hp:4000},
    twin_sun:{...p.sunflower,name:'双生向日葵',hp:450,sunEvery:11.5},
    giant_nut:{...p.wallnut,name:'巨型坚果',hp:8000},
    frost_pea:{...p.repeater,name:'寒冰双发',hp:450,slow:3.2},
    frost_wall:{...p.snowpea,name:'寒冰坚果',hp:4000},
    gatling:{...p.repeater,name:'机枪射手',hp:450,interval:0.7},
    solar_repeater:{...p.repeater,name:'向日葵双发',hp:550,extraSun:25,sunEvery:23},
    wall_repeater:{...p.repeater,name:'坚果双发',hp:4400},
    ice_gatling:{...p.repeater,name:'寒冰机枪',hp:550,interval:0.7,slow:3.2},
    triple_sun:{...p.sunflower,name:'三生向日葵',hp:600,sunEvery:23/3},
    fortress_nut:{...p.wallnut,name:'堡垒坚果',hp:12000},
    frost_wall_repeater:{...p.repeater,name:'寒冰坚果双发',hp:4500,slow:3.2},
    frost_solar:{...p.snowpea,name:'寒冰向日葵射手',hp:550,extraSun:25,sunEvery:23},
  });
  if(difficulty==='training')cfg.WAVES.splice(3);
  vm.runInContext(engineSource,env,{timeout:1000,filename:'upstream/game.js'});
  const proto=env.window.PVZGame.prototype;
  const plants=proto.updatePlants,fire=proto.fireProjectile;
  proto.updatePlants=function(dt){
    plants.call(this,dt);
    for(const pl of this.plants){const def=p[pl.type];if(!def.extraSun)continue;
      pl.fusionSunTimer=(pl.fusionSunTimer??def.sunEvery)-dt;
      if(pl.fusionSunTimer<=0){pl.fusionSunTimer+=def.sunEvery;this.spawnSun(pl.x,pl.y-74,pl.y-24,def.extraSun);}
    }
  };
  proto.fireProjectile=function(pl){fire.call(this,pl);if(p[pl.type].slow)this.projectiles.at(-1).kind='snow';};
  const game=new env.window.PVZGame();
  return {game,cfg,rng:()=>rng};
}
function snapshot(rt,meta){
  const core=JSON.parse(JSON.stringify(rt.game));delete core.grid;
  return JSON.parse(JSON.stringify({...meta,version:VERSION,adapterVersion:ADAPTER_VERSION,rng:rt.rng(),core}));
}
export function restore(state){
  must(state?.version===VERSION,'存档版本不支持');
  const rt=runtime(state.rng,state.difficulty);
  Object.assign(rt.game,structuredClone(state.core));
  rt.game.grid=Array.from({length:5},()=>Array(9).fill(null));
  for(const p of rt.game.plants){integer(p.row,0,4,'存档行');integer(p.col,0,8,'存档列');must(Object.hasOwn(rt.cfg.PLANTS,p.type),'存档植物类型错误');rt.game.grid[p.row][p.col]=p;}
  return rt;
}
export function createGame({id,seed=1,difficulty='normal'}={}){
  must(typeof id==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(id),'无效局号');
  const rt=runtime(seed,difficulty);rt.game.start();
  return snapshot(rt,{id,revision:0,difficulty,initialSeed:seed,events:[],recentActions:[]});
}
function wait(rt,seconds){
  integer(seconds,1,30,'等待秒数');
  const g=rt.game;
  for(let i=0;i<seconds*20&&g.state==='playing';i++){
    // Auto-click actual sun objects; original collect animation/economy runs unchanged.
    for(const sun of g.suns)g.collectSun(sun);
    g.update(0.05);
  }
}
function move(rt,m,events){
  must(m&&typeof m==='object'&&!Array.isArray(m),'行动格式错误');
  const g=rt.game,p=rt.cfg.PLANTS;
  must(g.state==='playing','当前不在进行中，请status查看');
  if(m.action==='wait'){wait(rt,m.seconds??5);return;}
  must(['plant','fuse','shovel'].includes(m.action),'未知行动');
  const row=integer(m.row,1,5,'行')-1,col=integer(m.col,1,9,'列')-1;
  if(m.action==='shovel'){const pl=g.grid[row][col];must(pl,'这里没有植物');g.removePlant(pl,'shovel');events.push('已铲除，不返还阳光');return;}
  must(rt.cfg.CARD_ORDER.includes(m.kind),'只能购买基础卡片，help查种类');
  if(m.action==='plant'){
    const result=g.plantAt(col,row,m.kind);must(result.ok,'无法种植：'+({cooldown:'卡片冷却中',sun:'阳光不足',occupied:'格子已占用'}[result.reason]||result.reason));
    events.push(`在${row+1},${col+1}种下${p[m.kind].name}`);return;
  }
  const pl=g.grid[row][col];must(pl,'没有可融合植物');
  const recipe=RECIPES.find(([a,b])=>(a===pl.type&&b===m.kind)||(b===pl.type&&a===m.kind));must(recipe,'没有这种配方');
  must(g.sun>=p[m.kind].cost,'阳光不足');must((g.cardCd[m.kind]||0)<=0,'材料卡片冷却中');
  const damage=pl.maxHp-pl.hp;
  g.sun-=p[m.kind].cost;g.cardCd[m.kind]=p[m.kind].cooldown;
  pl.type=recipe[2];pl.maxHp=p[pl.type].hp;pl.hp=Math.max(1,pl.maxHp-damage);
  pl.pendingShots=[];pl.fireTimer=Math.max(pl.fireTimer,0.3);pl.fusionSunTimer=p[pl.type].sunEvery||0;
  events.push(`在${row+1},${col+1}融合成${p[pl.type].name}`);
}
export function transition(state,args){
  must(args.gameId===state.id,'局号已变化，请先status');
  must(args.revision===state.revision,'存档版本已变化，请先status，不要重复推进');
  const rt=restore(state),events=[],executed=[];
  if(args.action==='pause'){must(rt.game.state==='playing','只有进行中可暂停');rt.game.togglePause();}
  else if(args.action==='resume'){must(rt.game.state==='paused','只有暂停的局可继续');rt.game.togglePause();}
  else{
    const moves=args.action==='play'?args.moves:[args];
    must(Array.isArray(moves)&&moves.length>=1&&moves.length<=6,'每次1～6步');
    const seconds=moves.reduce((n,m)=>n+(m?.action==='wait'?integer(m.seconds??5,1,30,'等待秒数'):0),0);
    must(seconds<=60,'每次最多推进60秒游戏时间');
    for(const m of moves){if(['won','lost'].includes(rt.game.state))break;move(rt,m,events);executed.push({action:m.action,row:m.row,col:m.col,kind:m.kind,seconds:m.seconds});}
  }
  const log=[...(state.recentActions||[]),{at:round(rt.game.time),action:args.action,moves:executed}].slice(-20);
  return snapshot(rt,{id:state.id,revision:state.revision+1,difficulty:state.difficulty,initialSeed:state.initialSeed,events,recentActions:log});
}
const round=n=>Math.round(n*10)/10;
const catalog=()=>JSON.parse(JSON.stringify(runtime().cfg));
export function options(state){
  if(!state)return {game:null,hint:'new开局，建议training练习'};
  const g=state.core,cfg=catalog(),ready=g.state==='playing';
  const cards=cfg.CARD_ORDER.map(id=>({id,name:cfg.PLANTS[id].name,cost:cfg.PLANTS[id].cost,cooldown:round(g.cardCd[id]||0),ready:ready&&g.sun>=cfg.PLANTS[id].cost&&(g.cardCd[id]||0)<=0}));
  const fusions=[];
  for(const pl of g.plants)for(const [a,b,result] of RECIPES){
    const material=a===pl.type?b:b===pl.type?a:null;
    if(!material||!cfg.CARD_ORDER.includes(material))continue;
    const card=cards.find(c=>c.id===material);
    fusions.push({row:pl.row+1,col:pl.col+1,from:pl.type,material,result,name:cfg.PLANTS[result].name,cost:card.cost,ready:card.ready});
  }
  return {gameId:state.id,revision:state.revision,cards,fusions,emptyByRow:Array.from({length:5},(_,r)=>({row:r+1,cols:Array.from({length:9},(_,c)=>c+1).filter(c=>!g.plants.some(p=>p.row===r&&p.col===c-1))}))};
}
export function view(s){
  if(!s)return {available:true,game:null,hint:'help查规则，想玩时new开局；没有后台计时'};
  const g=s.core,cfg=catalog();
  const symbols={sunflower:'葵',peashooter:'豆',wallnut:'坚',snowpea:'冰',repeater:'双',cherrybomb:'炸',potatomine:'雷',solar_pea:'葵豆',wall_pea:'坚豆',twin_sun:'双葵',giant_nut:'巨坚',frost_pea:'冰双',frost_wall:'冰坚',gatling:'机枪',solar_repeater:'葵双',wall_repeater:'坚双',ice_gatling:'冰机',triple_sun:'三葵',fortress_nut:'堡垒',frost_wall_repeater:'冰坚双',frost_solar:'冰葵'};
  const board=Array.from({length:5},(_,r)=>`${r+1}路 `+Array.from({length:9},(_,c)=>{const p=g.plants.find(p=>p.row===r&&p.col===c);return p?symbols[p.type]:'·';}).join('|'));
  const threats=Array.from({length:5},(_,r)=>{const zs=g.zombies.filter(z=>z.row===r&&z.state!=='dying');return {row:r+1,zombies:zs.length,nearHouse:zs.some(z=>z.x<400),weakPlants:g.plants.filter(p=>p.row===r&&p.hp/p.maxHp<0.3).map(p=>p.col+1)};}).filter(x=>x.zombies||x.weakPlants.length);
  return {title:'开源草坪保卫战·融合扩展',gameId:s.id,revision:s.revision,status:g.state,difficulty:s.difficulty,
    gameSeconds:round(g.time),sun:g.sun,wave:g.waveIndex+1,totalWaves:s.difficulty==='training'?3:10,kills:g.killed,board,threats,
    mowers:g.mowers.map(m=>({row:m.row+1,ready:!m.used&&!m.active})),
    plants:g.plants.map(p=>({row:p.row+1,col:p.col+1,kind:p.type,hp:Math.ceil(p.hp),maxHp:p.maxHp,...(p.type==='potatomine'?{armed:p.armed}:{})})),
    zombies:g.zombies.filter(z=>z.state!=='dying').map(z=>({id:z.id,row:z.row+1,col:round((z.x-200)/100+0.5),kind:z.type,hp:Math.ceil(z.hp),state:z.state,slowSeconds:round(z.slow)})),
    cooldowns:Object.fromEntries(Object.entries(g.cardCd).filter(([,v])=>v>0).map(([k,v])=>[k,round(v)])),
    readyCards:cfg.CARD_ORDER.filter(id=>g.state==='playing'&&g.sun>=cfg.PLANTS[id].cost&&(g.cardCd[id]||0)<=0),
    events:s.events,hint:'1列靠房屋；变更带gameId+revision；options查种植/融合；wait.seconds推进1～30秒；play最多6步；不操作不推进'};
}
export function rules(){
  const cfg=catalog(),p=cfg.PLANTS;
  return {title:'开源草坪保卫战·融合扩展',upstream:UPSTREAM,
    note:'复用开源战斗引擎，另加15种融合配方（含多级路线）；非蓝飘飘融合版完整移植。自由选择玩或不玩，无后台模型循环。',
    rules:['5路9列，坐标从1起；僵尸从右向左；每路一台割草机','原版阳光经济与卡片冷却，自动收集实际掉落阳光；种植/融合不消耗游戏时间，用wait推进',
      'normal原有10波，training前3波；胜负由原引擎判断','融合在已有植物格子购买另一张基础材料卡，扣其阳光与冷却；支持多级融合，保留损伤，不移动别格植物',
      '每次变更需最新gameId+revision；play可合并1～6步，总推进不超过60秒；非法计划整批不保存',
      '不操作就不推进，自动存档，重启后可继续；想停就停，每次玩一小段',
      'options查合法卡片/融合；history查最近10局和本局最近20次操作；这些查询不推进时间'],
    cards:cfg.CARD_ORDER.map(id=>({id,...p[id]})),
    recipes:RECIPES.map(([base,material,result])=>({base,material,result,stats:p[result]})),
    example:{action:'play',gameId:'从status取',revision:0,moves:[{action:'plant',row:1,col:1,kind:'sunflower'},{action:'wait',seconds:6}]}};
}
