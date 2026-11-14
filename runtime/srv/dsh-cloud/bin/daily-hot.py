#!/usr/bin/env python3
"""每天抓一份热榜摘要，落到 ~/daily-hot.md，给泡泡聊天时用。"""
import json, pathlib, urllib.request, datetime

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
OUT = pathlib.Path("/srv/dsh-cloud/home/daily-hot.md")

def get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw=response.read(1024*1024+1)
        if len(raw)>1024*1024:raise ValueError('RESPONSE_TOO_LARGE')
        return raw.decode("utf-8", "ignore")

lines = [f"# 今日热榜 · {datetime.date.today().isoformat()}", ""]

# 百度热搜
try:
    d = json.loads(get("https://top.baidu.com/api/board?platform=wise&tab=realtime"))
    items = []
    for card in d.get("data", {}).get("cards", []):
        for c in card.get("content", []):
            for x in c.get("content", []):
                t = x.get("word") or x.get("query") or x.get("title")
                if t: items.append(t)
    if items:
        lines += ["## 百度热搜"] + [f"- {t}" for t in items[:15]] + [""]
except Exception as e:
    lines += [f"（百度热搜抓取失败：{e}）", ""]

# 今日头条热榜
try:
    d = json.loads(get("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc"))
    items = [x.get("Title") for x in d.get("data", []) if x.get("Title")]
    if items:
        lines += ["## 头条热榜"] + [f"- {t}" for t in items[:15]] + [""]
except Exception as e:
    lines += [f"（头条热榜抓取失败：{e}）", ""]

# 知乎日报
try:
    d = json.loads(get("https://news-at.zhihu.com/api/4/news/latest"))
    items = [s.get("title") for s in d.get("stories", []) if s.get("title")]
    if items:
        lines += ["## 知乎日报"] + [f"- {t}" for t in items[:12]] + [""]
except Exception as e:
    lines += [f"（知乎日报抓取失败：{e}）", ""]

lines.append(f"_更新时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}_")
temp=OUT.with_suffix(".tmp")
temp.write_text("\n".join(lines), encoding="utf-8")
temp.replace(OUT)
print("WROTE", len(lines), "lines ->", OUT)