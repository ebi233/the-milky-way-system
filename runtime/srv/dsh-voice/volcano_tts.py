#!/usr/bin/env python3
"""火山 豆包语音合成 2.0（seed-tts-2.0）：原生情绪 + 可变语速。
情绪走 req_params.emotion（2.0 支持），不再用 ffmpeg 变调。
"""
import argparse, base64, json, urllib.request, urllib.error

CONF = "/srv/dsh-cloud/home/tts-config.json"
URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
DEFAULT_RES = "seed-tts-2.0"
DEFAULT_SPK = "zh_female_qingchezizi_uranus_bigtts"

# 我们说的情绪 -> (火山 2.0 的 emotion, 语速倍率, emotion_scale)
EMOTION_MAP = {
    "normal": ("neutral",  1.00, None),
    "happy":  ("happy",    1.06, 3),
    "gentle": ("gentle",   0.96, 3),
    "sad":    ("sad",      0.90, 3),
    "cold":   ("coldness", 0.96, 3),
    "angry":  ("angry",    1.04, 4),
    "tease":  ("shy",      1.02, 3),
}


def load_conf():
    try:
        with open(CONF, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def synth(text, speaker=None, emotion="normal", speed=None, fmt="mp3", sample_rate=24000):
    conf = load_conf()
    key = conf.get("apikey") or ""
    if not key:
        raise RuntimeError("tts-config.json 里没有 apikey")
    speaker = speaker or conf.get("speaker") or DEFAULT_SPK
    resource = conf.get("resource") or DEFAULT_RES
    emo, rate, scale = EMOTION_MAP.get((emotion or "normal").lower(), EMOTION_MAP["normal"])
    if speed:
        try:
            rate = float(rate) * float(speed)
        except Exception:
            pass
    rp = {
        "text": text,
        "speaker": speaker,
        "audio_params": {
            "format": fmt,
            "sample_rate": sample_rate,
            "speech_rate": int(round((rate - 1.0) * 100)),
        },
    }
    if emo and emo != "neutral":
        rp["emotion"] = emo
        if scale:
            rp["emotion_scale"] = scale
    payload = {"user": {"uid": "dsh-voice"}, "req_params": rp}
    req = urllib.request.Request(URL, data=json.dumps(payload).encode("utf-8"), headers={
        "Content-Type": "application/json",
        "X-Api-Key": key,
        "X-Api-Resource-Id": resource,
    })
    chunks = []
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                code = obj.get("code", 0)
                if obj.get("data"):
                    chunks.append(base64.b64decode(obj["data"]))
                if code == 20000000:
                    break
                if code not in (0,):
                    raise RuntimeError(f"code={code} message={obj.get('message')}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read()[:200]!r}")
    if not chunks:
        raise RuntimeError("没有拿到音频数据")
    return b"".join(chunks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--speaker", default=None)
    ap.add_argument("--emotion", default="normal")
    ap.add_argument("--speed", type=float, default=None)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    audio = synth(a.text, a.speaker, a.emotion, a.speed)
    open(a.out, "wb").write(audio)
    print(f"OK {len(audio)} bytes -> {a.out} ({a.emotion})")


if __name__ == "__main__":
    main()