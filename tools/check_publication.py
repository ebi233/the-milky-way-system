"""Offline syntax, links and publication-boundary checks; never load runtime code."""
from pathlib import Path
import ast, json, os, re, shutil, subprocess, sys

ROOT = Path(__file__).resolve().parents[1]
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js 22+ is required on PATH')
errors = []
counts = {'javascript':0, 'python':0, 'json':0, 'files':0}
excluded = {'.git', 'node_modules', '__pycache__'}
secret = re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{32,}')
for directory, dirs, names in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in excluded]
    for name in names:
        p = Path(directory)/name
        rel = p.relative_to(ROOT).as_posix()
        counts['files'] += 1
        if p.is_symlink() or '.private' in rel or name in {'.env','.web-token','transport-config.json','persona.md'} or p.suffix in {'.db','.sqlite','.sqlite3','.pem','.key','.log'}:
            errors.append(f'Private/runtime file in publication: {rel}')
        try: text = p.read_text(encoding='utf8')
        except UnicodeError:
            errors.append(f'Unexpected binary: {rel}')
            continue
        # Detection regex source and explanatory examples are not credentials.
        for i, line in enumerate(text.splitlines(), 1):
            if secret.search(line) and not any(x in line for x in ['re.compile','/-----BEGIN','-----BEGIN [A-Z ]*PRIVATE KEY-----','secret = re.compile']):
                errors.append(f'Credential pattern: {rel}:{i}')
        try:
            if p.suffix in {'.js','.mjs','.cjs'}:
                result = subprocess.run([node,'--check',str(p)],capture_output=True,text=True,encoding='utf8',timeout=20)
                if result.returncode: errors.append(f'JavaScript syntax: {rel}\n{result.stderr[-800:]}')
                counts['javascript'] += 1
            elif p.suffix == '.py':
                ast.parse(text, filename=rel); counts['python'] += 1
            elif p.suffix == '.json':
                json.loads(text); counts['json'] += 1
            elif p.suffix == '.md':
                for link in re.findall(r'\]\(([^)]+)\)',text):
                    if '://' in link or link.startswith('#') or '<' in link: continue
                    target=link.split('#')[0]
                    if target and not (p.parent/target).exists(): errors.append(f'Broken local link: {rel}: {target}')
        except (SyntaxError,ValueError,subprocess.TimeoutExpired) as error:
            errors.append(f'{rel}: {error}')
print(json.dumps({'checked':counts,'errors':errors},ensure_ascii=True,indent=2))
sys.exit(1 if errors else 0)
