"""Relay observations to an isolated maintenance room; return a choice for review."""
import json,pathlib,subprocess,sys

def server_main(reports, custom_message=None):
    sys.path.insert(0,'/srv/dsh-qq-ext/dsh-persona-integrity')
    from maintenance_room import review
    message=custom_message or ('这是音色试听维护沟通。以下为外部音频模型对样音的评价，不代表你亲耳听过；'
        '用户只审查是否自然，你可以表达自己喜欢的音色、要求更多样音或暂不选择。'
        '只返回选择和理由，本次不改生产音色、不发QQ消息。\n'+json.dumps(reports,ensure_ascii=False))
    result=review(message)
    dest=pathlib.Path('/tmp/paopao-audio-review-'+result['request_id']+'.json')
    dest.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False))

if __name__ == '__main__':
    root = pathlib.Path(__file__).resolve().parent
    reports = []
    for label in ('A', 'B', 'C'):
        report = json.loads((root / (label + '-analysis.json')).read_text(encoding='utf-8'))
        if not report.get('content') or not report.get('usage', {}).get('prompt_tokens_details', {}).get('audio_tokens'):
            raise SystemExit('Missing successful audio analysis: ' + label)
        reports.append({'label': label, 'analysis': report['content']})
    source = pathlib.Path(__file__).read_text(encoding='utf-8').split("if __name__ == '__main__':")[0]
    source += '\nserver_main(' + repr(reports) + ')\n'
    result = subprocess.run([
        r'C:\Windows\System32\OpenSSH\ssh.exe', '-T', '-i',
        r'D:\dsh-plugins\ssh\dsh_cloud_ed25519', '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10', 'admin@192.0.2.10', 'sudo -n python3 -'
    ], input=source.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=280)
    stdout = result.stdout.decode('utf-8', errors='replace')
    (root / 'paopao-audio-review.log').write_text(stdout, encoding='utf-8')
    print(stdout)
    if result.returncode:
        raise SystemExit('Remote maintenance failed; exit code ' + str(result.returncode))
