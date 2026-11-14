import json
import subprocess
import urllib.request


def get(path):
    with urllib.request.urlopen("http://127.0.0.1:29908" + path, timeout=15) as r:
        return json.loads(r.read())


print("== 服务 ==")
print(subprocess.run(["systemctl", "is-active", "dsh-cloud"], capture_output=True, text=True).stdout.strip())

try:
    b = get("/dsh-qq-bridge/state")
    print("== QQ 桥 ==")
    print("  目标:", b["配置"].get("目标会话"))
    for x in b["配置"].get("绑定") or []:
        print(f"  {x.get('类型')} {x.get('号码')} → {str(x.get('会话'))[-12:]}")
    print("  群里听所有人:", b["配置"].get("群里听所有人"), "| 自动接群:", b["配置"].get("自动接群"))
    print("  活着的会话:", [x["id"][-12:] for x in b.get("活着的会话", [])])
except Exception as e:
    print("桥状态读不到:", e)

try:
    s = get("/dsh-speak-up/state")
    print("== speak-up 目标 ==", [x[-12:] for x in s["配置"]["目标会话"]])
except Exception as e:
    print("speak-up 读不到:", e)

try:
    print("== groups.json ==", open("/srv/dsh-cloud/home/groups.json", encoding="utf-8").read()[:200])
except Exception:
    print("== groups.json 无 ==")
