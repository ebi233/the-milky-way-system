"""Disable only this sampling plugin; preserve current persona and all backups."""
from pathlib import Path
import hashlib
import os
import subprocess
import time

profile = Path('/srv/dsh-cloud/home/profiles/cloud/cordis.patch.yml')
persona = Path('/srv/dsh-cloud/home/persona.md')
before_persona = hashlib.sha256(persona.read_bytes()).hexdigest()
text = profile.read_text()
block = '''# BEGIN dsh-creative-sampling (managed)
- insert:
    - id: creative-sampling
      name: /srv/dsh-qq-ext/dsh-creative-sampling/index.js
# END dsh-creative-sampling (managed)
'''
if text.count(block) != 1:
    raise SystemExit('Expected one exact registration block; stop without changes')
stat = profile.stat()
backup = profile.with_name('cordis.patch.yml.sampling-rollback-' + str(time.time_ns()))
with backup.open('xb') as handle:
    handle.write(text.encode())
os.chmod(backup, 0o600)
temporary = profile.with_name('cordis.patch.yml.sampling-rollback-new')
with temporary.open('xb') as handle:
    handle.write(text.replace(block, '', 1).encode())
    handle.flush()
    os.fsync(handle.fileno())
os.chown(temporary, stat.st_uid, stat.st_gid)
os.chmod(temporary, stat.st_mode & 0o777)
assert profile.read_text() == text, 'Concurrent profile edit; stop'
os.replace(temporary, profile)
subprocess.run(['systemctl', 'restart', 'dsh-cloud'], check=True)
for attempt in range(12):
    result = subprocess.run(['/srv/dsh-cloud/bin/check-persona.sh'], capture_output=True, text=True)
    if 'service=active' in result.stdout and 'alive=1' in result.stdout:
        assert hashlib.sha256(persona.read_bytes()).hexdigest() == before_persona, 'Persona changed concurrently'
        for line in result.stdout.splitlines():
            if line.startswith(('service=', 'alive=', 'persona_lines=')):
                print(line)
        print('SAMPLING_DISABLED; persona unchanged; .env and plugin files retained but inactive')
        break
    time.sleep(2)
else:
    raise SystemExit('Health check failed; stop and inspect')
