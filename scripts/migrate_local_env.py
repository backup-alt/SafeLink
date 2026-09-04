"""One-time, opt-in local migration. Never prints credential values."""
from io import StringIO
from pathlib import Path
import os
import re
import subprocess
from dotenv import dotenv_values
from dotenv.parser import parse_stream


def migrate(root: Path):
    source, target = root / '.env.test', root / '.env'
    if not source.exists():
        raise ValueError('Source missing')
    for name in ('.env', '.env.test', '.env.migration.local'):
        if subprocess.run(['git', 'check-ignore', '-q', name], cwd=root).returncode != 0:
            raise ValueError('Secret files must be ignored before migration')
        if subprocess.run(['git', 'ls-files', '--error-unmatch', name], cwd=root,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            raise ValueError('Secret file is tracked; stop for remediation')
    raw = source.read_text(encoding='utf-8-sig')
    bindings = list(parse_stream(StringIO(raw)))
    if any(binding.error for binding in bindings):
        match = re.fullmatch(r'\s*([A-Za-z_ ]+)\s*[:=]\s*[\"\']?(sk-[A-Za-z0-9_-]{20,})[\"\']?\s*', raw)
        if not match or re.sub('[^a-z]', '', match[1].lower()) not in {'openaiapikey', 'openaiapi', 'openaikey', 'apikey'}:
            raise ValueError('Unrecognized credential format; migration stopped without deleting source')
        incoming = {'OPENAI_API_KEY': match[2]}
    else:
        incoming = dict(dotenv_values(stream=StringIO(raw), interpolate=False))
    if not incoming.get('OPENAI_API_KEY') or any(value is None for value in incoming.values()):
        raise ValueError('Incomplete credentials')
    previous_text = target.read_text(encoding='utf-8-sig') if target.exists() else ''
    previous = dict(dotenv_values(stream=StringIO(previous_text), interpolate=False))
    for key, value in incoming.items():
        if key in previous and previous[key] != value:
            raise ValueError('Existing credential conflict; source retained')
    merged = {**previous, **incoming}
    defaults = {'OPENAI_MODEL': 'gpt-5.5', 'OPENAI_REASONING_EFFORT': 'medium'}
    additions = {**{k: v for k, v in incoming.items() if k not in previous},
                 **{k: v for k, v in defaults.items() if k not in merged}}
    def quoted(value):
        return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"
    content = previous_text.rstrip() + '\n' + '\n'.join(f'{k}={quoted(v)}' for k, v in additions.items()) + '\n'
    temp = root / '.env.migration.local'
    try:
        with temp.open('x', encoding='utf-8') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        check = dotenv_values(temp, interpolate=False)
        if any(check.get(k) != v for k, v in merged.items()):
            raise ValueError('Verification failed; source retained')
        os.replace(temp, target)
        verified = dotenv_values(target, interpolate=False)
        if any(verified.get(k) != v for k, v in merged.items()):
            raise ValueError('Final verification failed; source retained')
        source.unlink()
    finally:
        if temp.exists():
            temp.unlink()
    print('Migration verified. All credentials preserved in ignored .env; .env.test removed.')


if __name__ == '__main__':
    try:
        migrate(Path(__file__).resolve().parents[1])
    except Exception:
        raise SystemExit('Migration stopped safely. No secret values printed; inspect configuration locally.')
