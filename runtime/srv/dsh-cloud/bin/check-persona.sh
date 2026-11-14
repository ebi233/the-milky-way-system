#!/bin/bash
# 人设/服务健康检查：输出三行，给远端脚本解析
svc=$(systemctl is-active dsh-cloud 2>/dev/null)
echo "service=$svc"
alive=$(curl -s -m 8 http://127.0.0.1:29908/dsh-speak-up/state 2>/dev/null | tr -d ' ' | grep -c '"目标活着":true')
echo "alive=$alive"
persona=$(sudo wc -l < /srv/dsh-cloud/home/persona.md 2>/dev/null | tr -d ' ')
echo "persona_lines=$persona"