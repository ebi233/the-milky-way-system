#!/usr/bin/env python3
"""Read-only runtime audit. Never prints chat, configuration secrets, or credentials."""
from pathlib import Path
import json,hashlib,subprocess,urllib.request,datetime
from zoneinfo import ZoneInfo
h=Path('/srv/dsh-cloud/home')
result={'service':subprocess.run(['systemctl','is-active','dsh-cloud'],capture_output=True,text=True).stdout.strip()}
def read_route(route):
 with urllib.request.urlopen('http://127.0.0.1:29908/'+route,timeout=8) as response:return json.load(response)
try:
 a=read_route('dsh-qq-bridge/architecture-state')
 result['architecture']=a
 result['guard']=read_route('dsh-long-memory/state').get('groupIsolation')
 s=read_route('dsh-speak-up/state').get('调度状态',{})
 result['private_proactive']=s
 if s.get('nextAt'):result['next_private_check_shanghai']=datetime.datetime.fromtimestamp(s['nextAt']/1000,ZoneInfo('Asia/Shanghai')).isoformat()
 groups=json.loads((h/'groups.json').read_text()) if (h/'groups.json').exists() else {}
 seals=json.loads((h/'group-session-seals.json').read_text()).get('sessions',{}) if (h/'group-session-seals.json').exists() else {}
 result['group_count']=len(groups)
 result['groups_sealed']=all(seals.get(g.get('session'),{}).get('group')==str(gid) for gid,g in groups.items())
 result['groups_unique']=len({g.get('session') for g in groups.values()})==len(groups)
 result['ok']=result['service']=='active' and a.get('version')=='architecture-v1' and a.get('integrity',{}).get('ok') is True and result['groups_sealed'] and result['groups_unique'] and not a.get('watermarks',{}).get('writeError') and s.get('persistent') is True
except Exception as e:result.update(ok=False,error=type(e).__name__)
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(0 if result['ok'] else 1)
