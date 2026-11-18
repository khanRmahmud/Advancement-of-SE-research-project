#!/usr/bin/env python3
"""Controlled StrykerJS mutation testing for Summit main-study suites.

Prerequisites:
  - Step 11 evaluate_generated_tests.py finished for the chosen target/method.
  - The original generated.test.ts, metadata.json and source_snapshot.ts exist.
  - This runner is in the research root, alongside evaluate_generated_tests.py.

Modes (run in order):
  --check    stage an unmodified *copy* of the archived test; check Stryker config
  --dry-run  run Stryker's initial test WITHOUT testing mutants; archive the log
  --run      mutation-test the selected suite; archive per-mutant JSON + HTML

Only one generated suite is selected per run. No OpenAI API call is made.
The old stryker.config.mjs and the old Trial 02 reports are never modified.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / 'summit' / 'app' / 'server'
INVENTORY = ROOT / 'protocol' / 'selected_functions_v1.csv'
COMPILER = ROOT / 'protocol' / 'compile_archived_test.cjs'
RESEARCH_CONFIG = BACKEND / 'stryker.research.config.mjs'
ARMS = ('baseline', 'guided')


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def target_info(name: str) -> dict:
    with INVENTORY.open(encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    matches = [row for row in rows if row.get('function') == name]
    if len(matches) != 1:
        raise RuntimeError(f'Expected exactly one selected function {name!r}; found {len(matches)}')
    return matches[0]


def immutable_copy(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if sha256(dest) != sha256(source):
            raise RuntimeError(f'Staged file differs; refusing overwrite: {dest}')
    else:
        shutil.copyfile(source, dest)
    if sha256(dest) != sha256(source):
        raise RuntimeError(f'Staging failed SHA-256 check: {source}')


def execute_live(command: list[str], cwd: Path, env: dict, log_file: Path) -> int:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    print('COMMAND:', ' '.join(command), flush=True)
    with log_file.open('w', encoding='utf-8') as log:
        log.write('COMMAND: ' + ' '.join(command) + '\n')
        log.flush()
        process = subprocess.Popen(
            command, cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
        )
        assert process.stdout is not None
        try:
            for line in process.stdout:
                print(line, end='', flush=True)
                log.write(line)
                log.flush()
        except KeyboardInterrupt:
            process.terminate()
            raise
        return process.wait()


def status_counts(report: dict) -> dict:
    count = Counter(
        mutant.get('status', 'Unknown')
        for file in report.get('files', {}).values()
        for mutant in file.get('mutants', [])
    )
    return {'mutants_total': sum(count.values()), **dict(sorted(count.items()))}


def prepare(name: str, arm: str) -> tuple[dict, Path, dict, dict]:
    item = target_info(name)
    feature = item['feature']
    source_rel = item['source_file'].replace('\\', '/')
    source_path = BACKEND / source_rel
    archive = ROOT / 'experiments' / feature / name / arm
    generated = archive / 'generated.test.ts'
    snapshot = archive / 'source_snapshot.ts'
    metadata_path = archive / 'metadata.json'
    evaluation_path = archive / 'evaluation' / 'evaluation_result.json'

    for f in (INVENTORY, COMPILER, RESEARCH_CONFIG, generated, source_path,
              snapshot, metadata_path, evaluation_path):
        if not f.is_file():
            raise FileNotFoundError(f)
    if sha256(source_path) != sha256(snapshot):
        raise RuntimeError('Production source differs from archived source snapshot; stop.')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8-sig'))
    recorded = metadata.get('generated_test_sha256')
    if recorded and recorded != sha256(generated):
        raise RuntimeError('Original generated test changed since generation; stop.')
    evaluation = json.loads(evaluation_path.read_text(encoding='utf-8-sig'))
    if evaluation.get('compilation') != 'passed' or evaluation.get('execution') != 'passed':
        raise RuntimeError('Step 11 compile and original-code execution must pass for mutation run.')
    if evaluation.get('generated_test_sha256') != sha256(generated):
        raise RuntimeError('Generated test does not match evaluation record.')
    if evaluation.get('source_sha256') != sha256(source_path):
        raise RuntimeError('Source does not match Step 11 evaluation record.')

    stage = BACKEND / '.research-mutation-input' / feature / name / arm
    immutable_copy(generated, stage / 'generated.test.ts')
    immutable_copy(COMPILER, stage / 'compile_archived_test.cjs')
    env = dict(os.environ)
    env.update({
        'SUMMIT_RESEARCH_FEATURE': feature,
        'SUMMIT_RESEARCH_TARGET': name,
        'SUMMIT_RESEARCH_ARM': arm,
        'SUMMIT_RESEARCH_SOURCE': source_rel,
    })
    evidence = {
        'protocol': 'summit-main-study-mutation-v1',
        'feature': feature, 'target': name, 'arm': arm,
        'source_file': source_rel,
        'source_sha256': sha256(source_path),
        'original_generated_test_sha256': sha256(generated),
        'staged_generated_test_sha256': sha256(stage / 'generated.test.ts'),
        'compiler_sha256': sha256(COMPILER),
        'config_sha256': sha256(RESEARCH_CONFIG),
        'mutation_scope': 'exported_function_only',
        'shared_helpers_in_mutation_scope': False,
        'stryker_coverageAnalysis': 'off',
        'timestamp_utc': now(),
        'original_generated_test_modified': False,
    }
    return item, archive, env, evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', required=True, help='Selected function, e.g. loginService')
    parser.add_argument('--arm', required=True, choices=ARMS)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--check', action='store_true', help='Check target and Stryker config; no mutation run')
    action.add_argument('--dry-run', action='store_true', help='Stryker initial test only (no mutant runs)')
    action.add_argument('--run', action='store_true', help='Execute mutation testing once')
    args = parser.parse_args()

    item, archive, env, evidence = prepare(args.target, args.arm)
    # Verify that the exact Stryker config selects the expected target and suite.
    config_probe = [
        'node', '--input-type=module', '-e',
        "import('./stryker.research.config.mjs').then(m=>console.log('CONFIG_OK',JSON.stringify({mutate:m.default.mutate,build:m.default.buildCommand,test:m.default.commandRunner.command})))",
    ]
    result = subprocess.run(config_probe, cwd=BACKEND, env=env, capture_output=True,
                            text=True, encoding='utf-8', errors='replace')
    if result.returncode != 0 or 'CONFIG_OK' not in result.stdout:
        raise RuntimeError('Stryker research configuration failed validation:\n' +
                           result.stdout + '\n' + result.stderr)
    print(result.stdout, flush=True)

    if args.check:
        check_file = archive / 'mutation_preflight' / 'check.json'
        if check_file.exists():
            existing = json.loads(check_file.read_text(encoding='utf-8'))
            for field in ('source_sha256', 'original_generated_test_sha256', 'compiler_sha256', 'config_sha256'):
                if existing.get(field) != evidence.get(field):
                    raise RuntimeError(f'Input changed since earlier --check: {field}')
        else:
            write_json(check_file, evidence)
        print('CHECK PASSED. No mutants tested. Archived test unchanged.', flush=True)
        return

    # npx.cmd is needed by Windows PowerShell and Windows subprocess.
    npx = shutil.which('npx.cmd' if os.name == 'nt' else 'npx')
    if not npx:
        raise RuntimeError('npx not found on PATH')
    cmd = [npx, 'stryker', 'run', 'stryker.research.config.mjs']
    if args.dry_run:
        out = archive / 'mutation_preflight'
        result_path = out / 'dry_run_result.json'
        if result_path.exists():
            raise RuntimeError(f'Dry-run record already exists; will not overwrite: {result_path}')
        out.mkdir(parents=True, exist_ok=True)
        cmd.append('--dryRunOnly')
        exit_code = execute_live(cmd, BACKEND, env, out / 'stryker_dry_run.log')
        write_json(result_path, {**evidence, 'exit_code': exit_code,
                                 'status': 'passed' if exit_code == 0 else 'failed',
                                 'finished_utc': now()})
        if exit_code:
            raise RuntimeError('Stryker dry run FAILED; inspect mutation_preflight/stryker_dry_run.log')
        print('DRY RUN PASSED. No mutants evaluated.', flush=True)
        return

    out = archive / 'mutation'
    if out.exists() and any(out.iterdir()):
        raise RuntimeError(f'Mutation output already exists, not overwriting: {out}')
    preflight_file = archive / 'mutation_preflight' / 'dry_run_result.json'
    if not preflight_file.exists():
        raise RuntimeError('Run --dry-run successfully before --run.')
    preflight = json.loads(preflight_file.read_text(encoding='utf-8'))
    if preflight.get('status') != 'passed':
        raise RuntimeError('Prior Stryker dry run did not pass.')
    for field in ('source_sha256', 'original_generated_test_sha256', 'compiler_sha256', 'config_sha256'):
        if preflight.get(field) != evidence.get(field):
            raise RuntimeError(f'Input changed since successful dry run: {field}')
    original_report = BACKEND / 'reports' / 'research-mutation' / item['feature'] / args.target / args.arm
    if (original_report / 'mutation.json').exists():
        raise RuntimeError(
            'A Stryker report already exists at ' + str(original_report) +
            '. Do not risk reading an old report; preserve/archive it first.'
        )
    out.mkdir(parents=True, exist_ok=True)
    exit_code = execute_live(cmd, BACKEND, env, out / 'stryker_run.log')
    for filename in ('mutation.json', 'mutation.html'):
        path = original_report / filename
        if path.exists():
            shutil.copyfile(path, out / filename)
    result_record = {**evidence, 'exit_code': exit_code,
                     'status': 'passed' if exit_code == 0 else 'failed',
                     'finished_utc': now()}
    source_after = BACKEND / item['source_file'].replace('\\', '/')
    generated_after = archive / 'generated.test.ts'
    result_record['source_sha256_after_mutation_run'] = sha256(source_after)
    result_record['generated_test_sha256_after_mutation_run'] = sha256(generated_after)
    result_record['inputs_unchanged_after_run'] = (
        result_record['source_sha256_after_mutation_run'] == evidence['source_sha256'] and
        result_record['generated_test_sha256_after_mutation_run'] == evidence['original_generated_test_sha256']
    )
    if not result_record['inputs_unchanged_after_run']:
        result_record['status'] = 'input_changed_unexpectedly'
    json_file = out / 'mutation.json'
    if json_file.exists():
        report = json.loads(json_file.read_text(encoding='utf-8-sig'))
        result_record['outcomes'] = status_counts(report)
        if result_record['outcomes']['mutants_total'] == 0:
            result_record['status'] = 'no_mutants'
    else:
        result_record['status'] = 'no_report'
    write_json(out / 'mutation_result.json', result_record)
    print('ARCHIVED:', out, flush=True)
    print('RESULT:', json.dumps({'status': result_record['status'],
                                'outcomes': result_record.get('outcomes')}, indent=2), flush=True)
    if exit_code or result_record['status'] in ('no_report', 'no_mutants', 'input_changed_unexpectedly'):
        raise RuntimeError('Stryker mutation evaluation incomplete: ' + result_record['status'])


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        sys.exit(1)
