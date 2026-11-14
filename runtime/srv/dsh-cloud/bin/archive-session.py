#!/usr/bin/env python3
"""全量存档：把会话日志里每一句人话按天切片存下来（append-only，永不删除）。

和「会淡忘的记忆」互补：
    - fish-memory：抽事实、按话题检索、会淡忘
    - 全量存档：原话全留，只在她主动 recall 时才被翻出来

只存「真正说出口的话」：assistant 的 reasoning / tool-call 一律丢弃。

由 systemd timer 每 30 分钟跑一次（增量，不重复）。

输出：/srv/dsh-cloud/home/archive/YYYY-MM-DD.jsonl
    {"t":"22:31:05","role":"老哥","text":"..."}
"""
import datetime as dt
import hashlib
import json
import pathlib
import subprocess
import sys
sys.path.insert(0,"/srv/dsh-health")
from maintenance_memory import classified,archive_lock

HOME = pathlib.Path("/srv/dsh-cloud/home")
# 当前主会话从 .main-session 读（换会话只改那个文件）
def 当前会话文件():
    sid = ""
    try:
        sid = (HOME / ".main-session").read_text(encoding="utf-8").strip()
    except Exception:
        sid = ""
    if sid:
        p = HOME / "sessions/--home-dshcloud--" / sid
        if p.is_dir():
            files = sorted(p.glob("session.v*.jsonl.zstd"))
            if files:
                return files[-1]
    raise SystemExit("主会话未绑定；停止归档，不猜测其他会话")


SESSION = 当前会话文件()
ARCHIVE = HOME / "archive"
STATE = HOME / ".archive-state.json"

# 这些来源的消息不要（不是两个人的对话）
SKIP_SOURCE = {"qq-notice", "system", "developer"}


def read_events():
    """Stream one bounded JSON event at a time; never materialize full history."""
    import tempfile
    max_line = 2 * 1024 * 1024
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(["zstd", "-dc", "--", str(SESSION)],
                                stdout=subprocess.PIPE, stderr=errors)
        try:
            while True:
                line = proc.stdout.readline(max_line + 1)
                if not line:
                    break
                if len(line) > max_line:
                    raise RuntimeError("Session event exceeds 2 MiB; archive aborted")
                if not line.strip():
                    continue
                yield json.loads(line)
            if proc.wait(timeout=10) != 0:
                raise RuntimeError("Session decompression failed; watermark not advanced")
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


def spoken_text(ev: dict) -> str:
    """只取真正说出口的 text 块。"""
    d = ev.get("data") or {}
    msg = d.get("message") or {}
    content = msg.get("content")
    if content is None:
        content = d.get("content")      # user/message 的形状
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = (block.get("text") or "").strip()
                if t:
                    parts.append(t)
        return "\n".join(parts)
    return ""


def role_of(ev: dict) -> str | None:
    d = ev.get("data") or {}
    src = d.get("source") or {}
    if isinstance(src, dict) and src.get("kind") in SKIP_SOURCE:
        return None
    msg = d.get("message") or {}
    who = msg.get("role") or d.get("role")
    if who == "assistant":
        return "泡泡"
    if who == "user":
        return "老哥"
    return None


def main() -> None:
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    last_ms = 0.0
    seen = set()
    if STATE.exists():
        try:
            st = json.loads(STATE.read_text(encoding="utf-8"))
            last_ms = float(st.get("lastMs", 0))
            seen = set(st.get("seen", [])[-8000:])
        except Exception:
            pass

    added = 0
    latest = last_ms
    for ev, category in classified(read_events()):
        if category != "chat":continue
        t = ev.get("time") or ev.get("createdAt") or 0
        if not t or t <= last_ms:
            continue
        role = role_of(ev)
        if not role:
            continue
        body = spoken_text(ev)
        if not body:
            continue
        when = dt.datetime.fromtimestamp(t / 1000)
        h = hashlib.sha1((str(int(t)) + role + body).encode()).hexdigest()[:16]
        latest = max(latest, float(t))
        if h in seen:
            continue
        seen.add(h)
        rec = {"t": when.strftime("%H:%M:%S"), "role": role, "text": body[:4000], "sourceSession": SESSION.parent.name, "sourceSeq": ev.get("seq")}
        with (ARCHIVE / f"{when.date().isoformat()}.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        added += 1

    STATE.write_text(json.dumps({
        "lastMs": latest,
        "lastRun": dt.datetime.now().isoformat(timespec="seconds"),
        "seen": sorted(seen)[-8000:],
    }, ensure_ascii=False), encoding="utf-8")

    files = sorted(ARCHIVE.glob("*.jsonl"))
    total = 0
    for archive_file in files:
        with archive_file.open("rb") as stream:
            total += sum(1 for line in stream if line.strip())
    print(f"新增 {added} 条，归档累计 {total} 条，{len(files)} 天")


if __name__ == "__main__":
    with archive_lock(HOME):main()
