#!/usr/bin/env python3
"""Read-only operational report; no chat text or credentials."""
import json,urllib.request,subprocess
from pathlib import Path
def get(route):
 with urllib.request.urlopen('http://127.0.0.1:29908/'+route,timeout=8) as r:return json.load(r)
try:
 a=get('dsh-qq-bridge/architecture-state');m=get('dsh-long-memory/state');p=get('dsh-speak-up/diagnostics')
 s=json.loads(Path('/srv/dsh-cloud/home/creative-sampling-status.json').read_text())
 result={'service':subprocess.run(['systemctl','is-active','dsh-cloud'],capture_output=True,text=True).stdout.strip(),
 'conversationQuality':a.get('conversationQuality'),'notes':m.get('conversationNotes'),
 'groupProactive':a.get('groupProactive'),'privateProactive':p,'thinking':s.get('reasoningEffort'),
 'integrity':a.get('integrity')}
 result['ok']=result['service']=='active' and result['conversationQuality']=='v1' and bool(result['notes']) and p.get('persistent') is True and result['thinking']=='high' and a.get('integrity',{}).get('ok') is True
except Exception as e:result={'ok':False,'error':type(e).__name__}
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(0 if result['ok'] else 1)
