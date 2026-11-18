#!/usr/bin/env python3
"""Orchestrate the frozen Summit single-generation study without changing archived tests.

Start with:
    python run_main_study.py --plan
    python run_main_study.py --target getMe --phase all

After a second function succeeds, process remaining functions:
    python run_main_study.py --remaining --phase all

`--phase all` makes PAID GPT calls for still-ungenerated baseline/guided suites.
It reuses every already archived result and never repairs generated tests.
Failed or invalid test suites remain part of the experimental record.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INVENTORY = ROOT / 'protocol' / 'selected_functions_v1.csv'
FREEZE = ROOT / 'environment' / 'frozen_input_hashes.csv'
ARMS = ('baseline', 'guided')
PHASES = ('generate', 'evaluate', 'mutate', 'compare', 'all')


def read_csv(p: Path) -> list[dict]:
    with p.open('r', encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def read_json(p: Path) -> dict | None:
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding='utf-8-sig'))


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def inventory() -> list[dict]:
    entries = read_csv(INVENTORY)
    if len(entries) != 12 or len({x['function'] for x in entries}) != 12:
        raise RuntimeError('Frozen inventory must have exactly 12 unique functions.')
    return entries


def verify_frozen_inputs() -> int:
    if not FREEZE.is_file():
        raise RuntimeError('Missing environment/frozen_input_hashes.csv; complete Step 9D.')
    records = read_csv(FREEZE)
    if len(records) != 81:
        raise RuntimeError(f'Expected 81 frozen hashes; found {len(records)}.')
    mismatched = []
    for r in records:
        p = (ROOT / r['path']).resolve()
        if not p.is_file() or sha(p).lower() != r['sha256'].lower():
            mismatched.append(r['path'])
    if mismatched:
        raise RuntimeError('Frozen inputs changed or missing:\n  ' + '\n  '.join(mismatched))
    return len(records)


def folder(item: dict, arm: str) -> Path:
    return ROOT / 'experiments' / item['feature'] / item['function'] / arm


def state(item: dict, arm: str) -> dict:
    d = folder(item, arm)
    generated = d / 'generated.test.ts'
    metadata = read_json(d / 'metadata.json')
    evaluation = read_json(d / 'evaluation' / 'evaluation_result.json')
    mutation = read_json(d / 'mutation' / 'mutation_result.json')
    return {
        'generated': generated.is_file() and bool(metadata) and
            bool((d / 'raw_response.json').is_file()),
        'generation_archived_partial': any((d / x).exists() for x in (
            'generated.test.ts', 'metadata.json', 'raw_response.json',
            'raw_model_output.txt', 'generation_attempts.jsonl')),
        'evaluation': evaluation,
        'mutation': mutation,
        'mutation_json': (d / 'mutation' / 'mutation.json').is_file(),
    }


def run_command(item: dict, arm: str | None, step: str, cmd: list[str]) -> bool:
    label = item['function'] + ('/' + arm if arm else '')
    log_dir = ROOT / 'analysis' / 'automation_logs' / item['feature'] / item['function']
    if arm:
        log_dir /= arm
    log_dir.mkdir(parents=True, exist_ok=True)
    log = log_dir / f'{step}.log'
    if log.exists():
        raise RuntimeError(f'Existing coordinator log; cannot overwrite: {log}')
    print(f'\n[{label}] {step}: ' + ' '.join(cmd), flush=True)
    with log.open('x', encoding='utf-8') as f:
        f.write('Command: ' + ' '.join(cmd) + '\n')
        f.write('Started UTC: ' + datetime.now(timezone.utc).isoformat() + '\n\n')
        f.flush()
        try:
            p = subprocess.run(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT,
                               encoding='utf-8', errors='replace', check=False)
            code = p.returncode
        except Exception as exc:
            f.write(f'\nInvocation error: {type(exc).__name__}: {exc}\n')
            code = -1
        f.write(f'\nExit code: {code}\n')
    print(f'[{label}] {step} exit={code} | log: {log.relative_to(ROOT)}', flush=True)
    if code:
        print(f'[{label}] See the saved log before deciding how to proceed.', flush=True)
    return code == 0


def generate(item: dict, arm: str) -> bool:
    s = state(item, arm)
    if s['generated']:
        print(f"[{item['function']}/{arm}] Existing GPT output: REUSED (no API call).")
        return True
    if s['generation_archived_partial']:
        print(f"[{item['function']}/{arm}] Generation attempt/output already archived but incomplete: NOT regenerated.")
        return False
    script = f'generate_{arm}_tests.py'
    return run_command(item, arm, 'generate', [sys.executable, script, '--target', item['function'], '--send']) and state(item, arm)['generated']


def evaluate(item: dict, arm: str) -> bool:
    s = state(item, arm)
    if not s['generated']:
        print(f"[{item['function']}/{arm}] No complete generated suite: evaluation unavailable.")
        return False
    if s['evaluation'] is not None:
        e = s['evaluation']
        ok = e.get('compilation') == 'passed' and e.get('execution') == 'passed'
        print(f"[{item['function']}/{arm}] Existing evaluation: compile={e.get('compilation')}, execution={e.get('execution')}; reused.")
        return ok
    eval_dir = folder(item, arm) / 'evaluation'
    if eval_dir.exists() and any(eval_dir.iterdir()):
        print(f"[{item['function']}/{arm}] Incomplete evaluation directory; not overwriting: {eval_dir}")
        return False
    ok = run_command(item, arm, 'evaluate', [sys.executable, 'evaluate_generated_tests.py',
                                            '--target', item['function'], '--arm', arm])
    e = state(item, arm)['evaluation'] or {}
    valid = ok and e.get('compilation') == 'passed' and e.get('execution') == 'passed'
    if not valid:
        print(f"[{item['function']}/{arm}] Invalid/unexecutable suite retained as a study outcome; mutation not applicable.")
    return valid


def mutate(item: dict, arm: str) -> bool:
    s = state(item, arm)
    if not s['evaluation'] or not (s['evaluation'].get('compilation') == 'passed' and s['evaluation'].get('execution') == 'passed'):
        print(f"[{item['function']}/{arm}] Original-code tests not valid: Stryker skipped.")
        return False
    m = s['mutation']
    if m is not None:
        ok = m.get('status') == 'passed' and m.get('inputs_unchanged_after_run') is True and s['mutation_json']
        print(f"[{item['function']}/{arm}] Existing mutation result: {m.get('status')} — {'reused' if ok else 'needs diagnosis'}.")
        return ok
    mutation_dir = folder(item, arm) / 'mutation'
    if mutation_dir.exists() and any(mutation_dir.iterdir()):
        print(f"[{item['function']}/{arm}] Incomplete mutation directory; not overwriting.")
        return False
    preflight = folder(item, arm) / 'mutation_preflight'
    checks = [
        ('check', '--check', 'check.json'),
        ('dry_run', '--dry-run', 'dry_run_result.json'),
    ]
    for step, flag, result_name in checks:
        record = read_json(preflight / result_name)
        if record:
            if step == 'dry_run' and record.get('status') != 'passed':
                print(f'Existing failed mutation preflight for {item["function"]}/{arm}; not rerunning.')
                return False
            print(f"[{item['function']}/{arm}] Existing {step}: reused.")
            continue
        if not run_command(item, arm, 'mutation_' + step,
                           [sys.executable, 'run_research_mutation.py', '--target', item['function'], '--arm', arm, flag]):
            return False
    if not run_command(item, arm, 'mutation_run', [sys.executable, 'run_research_mutation.py',
                                                 '--target', item['function'], '--arm', arm, '--run']):
        return False
    s = state(item, arm)
    m = s['mutation'] or {}
    return m.get('status') == 'passed' and m.get('inputs_unchanged_after_run') is True and s['mutation_json']


def compare(item: dict) -> bool:
    target = item['function']
    path = ROOT / 'analysis' / item['feature'] / target / 'comparison.html'
    if path.is_file():
        print(f'[{target}] Existing comparison report: reused.')
        return True
    if not all(state(item, arm)['mutation_json'] and (state(item, arm)['mutation'] or {}).get('status') == 'passed' for arm in ARMS):
        print(f'[{target}] Comparison unavailable (one or more mutation runs incomplete).')
        return False
    return run_command(item, None, 'compare', [sys.executable, 'compare_research_results.py', '--target', target]) and path.is_file()


def status_table(items: list[dict]) -> None:
    for item in items:
        for arm in ARMS:
            s = state(item, arm)
            e = s['evaluation'] or {}
            m = s['mutation'] or {}
            print(f"{item['feature']:12} {item['function']:32} {arm:8} "
                  f"generated={'Y' if s['generated'] else 'N'} "
                  f"compile={e.get('compilation','-'):16} "
                  f"execute={e.get('execution','-'):24} "
                  f"mutation={m.get('status','-')}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sel = ap.add_mutually_exclusive_group(required=True)
    sel.add_argument('--plan', action='store_true', help='Read-only status and freeze verification')
    sel.add_argument('--target', help='Run one of the 12 selected functions')
    sel.add_argument('--remaining', action='store_true', help='Run all functions except completed loginService')
    ap.add_argument('--phase', choices=PHASES, default='all',
                    help='For --target/--remaining only. all can make paid API calls.')
    args = ap.parse_args()
    items = inventory()
    print(f'FROZEN INPUTS VERIFIED: {verify_frozen_inputs()} matching hashes.')
    if args.plan:
        status_table(items)
        print('\nPLAN ONLY: no API requests, evaluations or Stryker runs.')
        return
    if args.target:
        chosen = [i for i in items if i['function'] == args.target]
        if not chosen:
            ap.error(f'Function is not in frozen inventory: {args.target}')
    else:
        chosen = [i for i in items if i['function'] != 'loginService']
    print(f'\nSelected {len(chosen)} function(s), phase={args.phase}.')
    if args.phase in ('generate', 'all'):
        print('GENERATION PHASE: missing outputs trigger one PAID API request per method.')

    for item in chosen:
        t = item['function']
        print(f'\n========== {item["feature"]}/{t} ==========', flush=True)
        if args.phase == 'all':
            # Complete both methods independently; one invalid suite does not erase the other.
            for arm in ARMS:
                if generate(item, arm) and evaluate(item, arm):
                    mutate(item, arm)
            compare(item)
        elif args.phase == 'generate':
            for arm in ARMS: generate(item, arm)
        elif args.phase == 'evaluate':
            for arm in ARMS: evaluate(item, arm)
        elif args.phase == 'mutate':
            for arm in ARMS: mutate(item, arm)
        elif args.phase == 'compare':
            compare(item)
    print('\nCURRENT STUDY STATUS')
    status_table(items)
    print('\nNo archived GPT output was regenerated or modified. Inspect any non-passed outcomes in experiments/.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nInterrupted; existing raw artifacts are preserved.', file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        sys.exit(1)
