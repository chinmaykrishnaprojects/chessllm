"""Allowlisted source staging and redacted secret/private-path checks.

This tool never initializes Git, creates commits, uploads, or deploys anything.
Reports contain relative file names and finding categories, never matched values.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_POLICY = Path(__file__).with_name('release_allowlist.json')
PRIVATE_DIRS = {
    '.git', '.vercel', '.codex', '.claude', '.agents', '.aws', 'node_modules',
    'dist', 'backend', 'docs', 'outputs', 'logs', 'private_audit', 'venv',
    '__pycache__', '.pytest_cache', '.playwright-mcp', 'test-results', 'playwright-report',
    'gpt_inputs', 'gpt_outputs', 'llm_games', 'generated_data', 'training',
}
PATTERNS = {
    'private_local_path': rb'(?i)(?:\b[a-z]:[\\/]+(?:users|documents and settings)[\\/]+|/(?:Users|home)/[A-Za-z0-9_.-]+/)',
    'github_token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})',
    'openai_token': rb'\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}',
    'google_api_key': rb'\bAIza[A-Za-z0-9_-]{30,}',
    'aws_access_key': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'private_key': rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
    'credential_in_url': rb'https?://[^\s/\x00:@]+:[^\s/\x00@]+@',
    'jwt_credential': rb'\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}',
    'literal_credential_assignment': rb'''(?i)\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{16,}["']''',
}
COMPILED = {name: re.compile(pattern) for name, pattern in PATTERNS.items()}
GENERATED = 'RELEASE_MANIFEST.json'


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def files(root: Path):
    for directory, names, names_files in os.walk(root, followlinks=False):
        base = Path(directory)
        names[:] = [name for name in names if name not in PRIVATE_DIRS and not (base / name).is_symlink()]
        for name in names_files:
            yield base / name


def select(source: Path, overlay: Path | None, policy: dict):
    allowed = set(policy['files'])
    selected = {}
    excluded = 0
    errors = []
    for root, is_overlay in [(source, False)] + ([(overlay, True)] if overlay else []):
        for path in files(root):
            relative = path.relative_to(root).as_posix()
            if relative not in allowed:
                excluded += 1
                if is_overlay:
                    errors.append({'file': relative, 'category': 'unallowlisted_overlay_file'})
                continue
            if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                errors.append({'file': relative, 'category': 'symlink_or_path_escape'})
                continue
            selected[relative] = path
    return selected, excluded, errors


def inspect(selected: dict[str, Path], policy: dict):
    errors = []
    inventory = []
    pinned = policy.get('binary_sha256', {})
    for relative, path in sorted(selected.items()):
        if path.is_symlink():
            errors.append({'file': relative, 'category': 'symlink_or_path_escape'})
            continue
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        inventory.append({'file': relative, 'bytes': len(data), 'sha256': sha})
        if relative in pinned and sha != pinned[relative]:
            errors.append({'file': relative, 'category': 'binary_integrity_mismatch'})
        if len(data) >= 100 * 1024 * 1024:
            errors.append({'file': relative, 'category': 'github_file_size_limit'})
        if relative.endswith('.tar.gz'):
            # Only the exact reviewed corresponding-source archive is admitted.
            if relative not in pinned:
                errors.append({'file': relative, 'category': 'unreviewed_archive'})
            continue
        for category, pattern in COMPILED.items():
            match = pattern.search(data)
            if match:
                errors.append({'file': relative, 'category': category,
                               'line': None if relative.endswith(('.onnx', '.wasm')) else data[:match.start()].count(b'\n') + 1})
        # Legal notices must preserve genuine third-party copyright email addresses.
        # Outside those notices, accidental personal contact data is flagged.
        if '/licenses/' not in '/' + relative and not relative.startswith('licenses/') and relative not in policy.get('copyright_email_files', []):
            if re.search(rb'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', data):
                errors.append({'file': relative, 'category': 'email_outside_license_notice'})
    for required in policy['required']:
        if required not in selected:
            errors.append({'file': required, 'category': 'required_file_missing'})
    # All four model binaries are pinned individually. Check the runtime manifest
    # cannot silently point at a different name, size, hash, or outside path.
    manifest_path = selected.get('public/models/manifest.json')
    if manifest_path:
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
            for item in manifest.values():
                name = item['file']
                if '/' in name or '\\' in name or '..' in name:
                    raise ValueError('Invalid model asset name')
                relative = 'public/models/' + name
                asset = selected.get(relative)
                if not asset or asset.stat().st_size != item['bytes'] or digest(asset) != item['sha256']:
                    errors.append({'file': relative, 'category': 'model_manifest_mismatch'})
        except (ValueError, KeyError, TypeError):
            errors.append({'file': 'public/models/manifest.json', 'category': 'invalid_model_manifest'})
    return errors, inventory


def check_git(root: Path, allowed: set[str]):
    errors = []
    def git(*args):
        return subprocess.check_output(['git', '--no-optional-locks', '-C', str(root), *args], stderr=subprocess.DEVNULL).decode()
    try:
        count = int(git('rev-list', '--all', '--count').strip())
        if count > 1:
            errors.append({'file': '.git', 'category': 'nonfresh_history'})
        for name in git('ls-files', '-z').split('\x00'):
            if name and name not in allowed and name != GENERATED:
                errors.append({'file': name, 'category': 'unallowlisted_tracked_file'})
        if git('status', '--porcelain').strip():
            errors.append({'file': '.git', 'category': 'uncommitted_changes'})
        for pattern in COMPILED.values():
            if pattern.search(git('remote', '-v').encode()):
                errors.append({'file': '.git/config', 'category': 'unsafe_remote_metadata'})
                break
    except (subprocess.CalledProcessError, ValueError):
        errors.append({'file': '.git', 'category': 'git_check_failed'})
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--overlay', type=Path)
    parser.add_argument('--policy', type=Path, default=DEFAULT_POLICY)
    parser.add_argument('--stage', type=Path, help='Create a new allowlisted snapshot directory; never overwrite one.')
    parser.add_argument('--strict', action='store_true', help='Fail on any unallowlisted file in an existing release candidate.')
    parser.add_argument('--git-check', action='store_true', help='Require one real clean publication commit, with no imported history.')
    parser.add_argument('--report', type=Path, help='Optional private JSON report; no matched secret values are included.')
    args = parser.parse_args()
    source = args.source.resolve()
    overlay = args.overlay.resolve() if args.overlay else None
    policy = json.loads(args.policy.read_text(encoding='utf-8-sig'))
    selected, excluded, errors = select(source, overlay, policy)
    if args.strict:
        for path in files(source):
            name = path.relative_to(source).as_posix()
            if name not in selected and name != GENERATED:
                errors.append({'file': name, 'category': 'unallowlisted_release_file'})
        # Pruned private directories are forbidden even when empty in a candidate.
        for path in source.iterdir():
            if path.name in PRIVATE_DIRS - {'.git'}:
                errors.append({'file': path.name, 'category': 'private_directory_in_release'})
    findings, inventory = inspect(selected, policy)
    errors.extend(findings)
    if args.git_check:
        errors.extend(check_git(source, set(policy['files'])))
    report = {'passed': not errors, 'selected_files': len(inventory), 'bytes': sum(item['bytes'] for item in inventory),
              'excluded_files': excluded, 'findings': errors}
    if not errors and args.stage:
        target = args.stage.resolve()
        if target.exists() or target.is_relative_to(source) or source.is_relative_to(target):
            parser.error('Stage target must be a new directory separate from the source.')
        if overlay and (target.is_relative_to(overlay) or overlay.is_relative_to(target)):
            parser.error('Stage target must be separate from the overlay.')
        target.mkdir(parents=True)
        for relative, path in selected.items():
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
        (target / GENERATED).write_text(json.dumps({'schema': 1, 'files': inventory}, indent=2) + '\n', encoding='utf-8')
        # Inspect the actual copied bytes, so concurrent edits to the source are
        # caught before a candidate can be used for publication.
        for item in inventory:
            if digest(target / item['file']) != item['sha256']:
                report['findings'].append({'file': item['file'], 'category': 'source_changed_during_stage'})
        report['passed'] = not report['findings']
        report['staged'] = True
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
