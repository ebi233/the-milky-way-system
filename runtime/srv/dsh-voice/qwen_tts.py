"""Private Bailian TTS adapter. WAV on stdout; bounded, redacted errors on stderr."""
import argparse
import io
import json
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import wave

CONFIG = pathlib.Path('/srv/dsh-cloud/home/bailian-tts-config.json')
VOICES = {'longanlingxin_v3.1', 'longanhuan_v3.1'}
MOODS = {
    'normal': '像和熟悉的人日常聊天，语气放松自然，按照句意停顿和变化，不用播音或舞台表演腔，不刻意撒娇。',
    'happy': '日常聊天中自然的开心，轻快但不夸张，不用播音腔。',
    'gentle': '日常聊天中温柔轻声，放松自然，不刻意嗲声，不用舞台表演腔。',
    'sad': '日常聊天中轻微低落，克制自然，不夸张哭腔。',
    'cold': '日常聊天中平静淡然，自然清楚，不用机械朗读腔。',
    'angry': '日常聊天中有点生气，表达清楚，自然克制，不大喊。',
    'tease': '日常聊天中轻松俏皮，像跟熟悉的人开玩笑，不刻意嗲声。',
}


def endpoint(config):
    base = config['base_url'].rstrip('/')
    u = urllib.parse.urlsplit(base)
    if (u.scheme != 'https' or not re.fullmatch(r'ws-[a-z0-9]+\.cn-beijing\.maas\.aliyuncs\.com', u.hostname or '')
            or u.path != '/api/v1' or u.query or u.fragment or u.username or u.port):
        raise ValueError('Invalid configured endpoint')
    return base + '/services/audio/tts/SpeechSynthesizer'


def synth(config, text, speaker, speed, emotion):
    if speaker not in VOICES or not .7 <= speed <= 1.3 or emotion not in MOODS:
        raise ValueError('Invalid synthesis option')
    if not text.strip() or len(text) > 500:
        raise ValueError('Voice text must contain 1-500 characters')
    body = {'model': 'qwen-audio-3.1-tts-plus', 'input': {
        'text': text.strip(), 'voice': speaker, 'format': 'wav', 'sample_rate': 24000,
        'rate': speed, 'pitch': 1.0, 'language_hints': ['zh'], 'instruction': MOODS[emotion],
    }}
    request = urllib.request.Request(endpoint(config), data=json.dumps(body).encode(), headers={
        'Authorization': 'Bearer ' + config['api_key'].strip(), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=40) as response:
        result = json.load(response)
    audio_url = result.get('output', {}).get('audio', {}).get('url', '')
    u = urllib.parse.urlsplit(audio_url)
    if u.scheme not in ('https', 'http') or not (u.hostname or '').endswith('.aliyuncs.com') or u.username:
        raise ValueError('No trusted audio result')
    with urllib.request.urlopen(audio_url, timeout=15) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('Audio result too large')
    with wave.open(io.BytesIO(raw)) as reader:
        channels, width, rate = reader.getnchannels(), reader.getsampwidth(), reader.getframerate()
        pcm = reader.readframes(reader.getnframes())
    if channels != 1 or width != 2 or rate != 24000 or len(pcm) < 1024 or len(pcm) % 2:
        raise ValueError('Unexpected PCM audio format')
    out = io.BytesIO()
    with wave.open(out, 'wb') as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(width)
        writer.setframerate(rate)
        writer.writeframes(pcm)
    return out.getvalue()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--text', required=True)
    parser.add_argument('--speaker', default='longanlingxin_v3.1')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--emotion', default='normal')
    args = parser.parse_args()
    try:
        config = json.loads(CONFIG.read_text())
        audio = synth(config, args.text, args.speaker, args.speed, args.emotion)
        sys.stdout.buffer.write(audio)
    except urllib.error.HTTPError as error:
        print('Bailian TTS HTTP ' + str(error.code), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Bailian TTS failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
