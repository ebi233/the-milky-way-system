"""Read-only daily health checks. No LLM calls, message sends or auto persona edits."""
from pathlib import Path
import datetime,hashlib,json,os,shutil,time,urllib.request,subprocess
HOME=Path('/srv/dsh-cloud/home')
OUT=Path('/srv/dsh-health')
def read(path,default=None):
    try:return json.loads(Path(path).read_text())
    except (OSError,ValueError):return default
def evaluate(health,architecture,private,resources):
    issues=[]
    def flag(condition,code,message):
        if condition:issues.append({'code':code,'message':message})
    flag(not health.get('ok'),'health_offline','运行时体检接口不可用')
    flag(health.get('ok') and not health.get('ownerMounted'),'owner_unmounted','主聊天会话尚未挂载，无法核验实际人设')
    flag(health.get('ownerMounted') and not health.get('runtimePersonaMatches'),'persona_mismatch','实际加载的人设与当前人格文件不一致')
    flag(health.get('checkpointHasMaintenanceIdentity'),'summary_identity','摘要再次混入维护助手身份')
    flag(health.get('ownerRecallContamination',0)>0,'memory_contamination','日常回忆再次混入维护交流或错误助手身份')
    flag(health.get('emptyFailed24h',0)>0 or health.get('unexplainedEmptySinceRepair',0)>0,'empty_reply','检测到未恢复的空回复，需要排查')
    flag(health.get('publicPersonaLeaks',0)>0,'public_persona','群聊或访客加载了私人角色提示')
    flag(not (architecture.get('channel') or {}).get('ready'),'qq_unready','QQ连接未就绪')
    flag(not (architecture.get('integrity') or {}).get('ok'),'runtime_integrity','扩展文件校验未通过或校验状态不可用')
    flag(private.get('reason')=='disabled','proactive_disabled','私聊主动搭话被关闭')
    delivery=private.get('delivery') or {}
    flag(bool(delivery.get('storageError')),'schedule_storage','主动搭话记录存储异常')
    flag(resources['diskFreeGB']<1,'disk_low','磁盘可用空间不足 1 GB')
    flag(resources['availableMB']<150,'memory_low','可用内存不足 150 MB')
    flag(resources.get('memoryPressure10',0)>=5,'memory_pressure','内存等待压力升高，先暂停额外维护与重任务')
    flag(resources.get('ioPressure10',0)>=10,'io_pressure','磁盘等待压力升高')
    flag(bool(resources.get('unboundedServices')),'resource_limits_missing','服务资源上限缺失：'+','.join(resources.get('unboundedServices',[])))
    flag(bool(resources.get('serviceOomKills')),'service_oom','检测到服务内存上限触发，需要检查容量')
    flag(bool(resources.get('resourceProbeError')),'resource_probe_failed','资源保护检查未完成')
    flag(resources.get('containerMemoryMax',1)==0,'container_unbounded','QQ容器内存上限缺失')
    flag(resources.get('containerLogBytes',0)>256*1024*1024,'container_log_large','QQ容器日志超过256MB，需要安排日志轮转')
    return issues
def expression_observations(health):
    observation=(health.get('conversationAudit') or {}).get('repetitionObservation') or {}
    if not observation.get('available') or not observation.get('ready'):
        return []
    candidates=[c for c in observation.get('candidates',[]) if c.get('needsReview')]
    if not candidates:
        return []
    return [{'code':'expression_repetition','level':'observation',
      'message':'近期回复有跨话题重复措辞线索，需结合原话人工查看；不等于人格故障',
      'sampledTurns':observation.get('sampledTurns'),'candidateCount':len(candidates),
      'observedAt':observation.get('observedAt'),'traceId':observation.get('traceId'),
      'policy':observation.get('policy')}]

def check_source_sync(source,health):
    # Compare the user original to the runtime's user-original fingerprint.
    # sourceHash identifies the active self-edited persona, not that original.
    expected=health.get('baseSourceHash')
    if not expected:
        if health.get('personaMode')=='self_edited':
            return {'code':'source_sync_unverified','message':'运行时未提供原版人格校验值，无法核验源文件同步'}
        expected=health.get('sourceHash')
    if expected and hashlib.sha256(source.strip().encode()).hexdigest()!=expected:
        return {'code':'source_sync','message':'云端原版人格文件与当前聊天端的原版文件不一致'}
    return None

RESOURCE_UNITS=['dsh-cloud','dsh-keepalive','dsh-handoff','dsh-qwen-image','archive-session','daily-hot','paopao-daily-check','dsh-token-refresh']
def pressure10(path):
    for line in Path(path).read_text().splitlines():
        if line.startswith('some '):return float(dict(x.split('=',1) for x in line.split()[1:])['avg10'])
    raise ValueError('Missing PSI')

def resource_status():
    result={}
    try:
        result['memoryPressure10']=pressure10('/proc/pressure/memory')
        result['ioPressure10']=pressure10('/proc/pressure/io')
        result['swappiness']=int(Path('/proc/sys/vm/swappiness').read_text())
        r=subprocess.run(['systemctl','show',*RESOURCE_UNITS,'--property=Id,MemoryMax,NRestarts,ControlGroup'],capture_output=True,text=True,timeout=8,check=True)
        units={};kills={}
        for block in r.stdout.strip().split('\n\n'):
            d=dict(line.split('=',1) for line in block.splitlines() if '=' in line)
            if not d.get('Id'):continue
            name=d['Id'];units[name]={'memoryMax':d.get('MemoryMax'),'restarts':int(d.get('NRestarts',0))}
            if d.get('ControlGroup'):
                p=Path('/sys/fs/cgroup'+d['ControlGroup'])/'memory.events'
                if p.exists():
                    v=dict(line.split() for line in p.read_text().splitlines());n=int(v.get('oom_kill',0))
                    if n:kills[name]=n
        result.update(serviceLimits=units,serviceOomKills=kills,
          unboundedServices=[u for u in RESOURCE_UNITS if units.get(u+'.service',{}).get('memoryMax') in (None,'infinity')])
        d=subprocess.run(['docker','inspect','--format','{{.HostConfig.Memory}} {{.LogPath}}','napcat'],capture_output=True,text=True,timeout=5,check=True).stdout.strip().split(maxsplit=1)
        result['containerMemoryMax']=int(d[0])
        if len(d)==2 and Path(d[1]).is_file():result['containerLogBytes']=Path(d[1]).stat().st_size
    except (OSError,ValueError,subprocess.SubprocessError):result['resourceProbeError']=True
    return result

def main():
    OUT.mkdir(mode=0o700,exist_ok=True)
    state=read('/srv/dsh-handoff/state.json',{})
    local=state.get('owner')=='local' and time.time()<state.get('expiresAt',0)
    base='http://127.0.0.1:'+('29938' if local else '29908')
    def get(path):
        try:
            with urllib.request.urlopen(base+path,timeout=12) as r:
                raw=r.read(2*1024*1024+1)
                if len(raw)>2*1024*1024:raise ValueError('Health response too large')
                return json.loads(raw)
        except (OSError,ValueError):return {}
    health=get('/dsh-persona-integrity/state')
    architecture=get('/dsh-qq-bridge/architecture-state')
    private=get('/dsh-speak-up/diagnostics')
    mem={k:int(v.split()[0]) for k,v in (l.split(':',1) for l in Path('/proc/meminfo').read_text().splitlines())}
    resources={'diskFreeGB':round(shutil.disk_usage('/').free/1024**3,1),'availableMB':mem.get('MemAvailable',0)//1024}
    resources.update(resource_status())
    issues=evaluate(health,architecture,private,resources)
    source=(HOME/'persona.md').read_text().strip()
    source_issue=check_source_sync(source,health)
    if source_issue:issues.append(source_issue)
    cfg=read(HOME/'qq-bridge-config.json',{})
    routes={}
    for r in cfg.get('绑定',[]):routes.setdefault(r.get('会话'),set()).add((r.get('类型'),str(r.get('号码'))))
    if any(len(v)>1 for v in routes.values()):issues.append({'code':'binding_collision','message':'不同用户或群共用同一聊天会话'})
    report={'version':1,'checkedAt':int(time.time()*1000),'ok':not issues,'activeEngine':'local' if local else 'cloud',
      'schedule':'每天 09:15（北京时间）','modelCalls':0,'issues':issues,'observations':expression_observations(health),'runtime':health,'resources':resources,
      'checks':['实际人设与源文件','摘要身份污染','日常与维护记忆隔离','空回复与恢复','公开会话隔离','QQ连接','扩展文件完整性','主动搭话存储','会话绑定冲突','磁盘与内存','内存与磁盘等待压力','服务资源上限和内存终止记录','本地云端源文件同步','中文重复表达（仅观察）']}
    previous=read(OUT/'latest.json',{})
    prior=set(i['code'] for i in previous.get('issues',[]));current=set(i['code'] for i in issues)
    report['newIssues']=sorted(current-prior);report['resolvedIssues']=sorted(prior-current)
    temp=OUT/'latest.tmp';temp.write_text(json.dumps(report,ensure_ascii=False,indent=2));temp.chmod(0o600);temp.replace(OUT/'latest.json')
    day=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d')
    (OUT/(day+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2))
    # Small bounded health reports only; never touch persona backups or chat logs.
    for p in OUT.glob('????-??-??.json'):
        if p.stat().st_mtime<time.time()-30*86400:p.unlink()
    if report['newIssues'] or report['resolvedIssues']:
        with (OUT/'changes.jsonl').open('a') as f:f.write(json.dumps({k:report[k] for k in ['checkedAt','newIssues','resolvedIssues']})+'\n')
    print(json.dumps({'ok':report['ok'],'checkedAt':report['checkedAt'],'issues':issues,'modelCalls':0},ensure_ascii=False))
if __name__=='__main__':main()
