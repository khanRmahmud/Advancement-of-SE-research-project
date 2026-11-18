#!/usr/bin/env python3
"""Compare baseline and guided results for one Summit study function.

Reads the existing archived Stryker JSON and original-code evaluation results.
Does not modify the application, archived tests, prompts, or mutation reports.

Usage (from research root):
    python compare_research_results.py --target loginService

Creates:
    analysis/<feature>/<target>/mutant_comparison.csv
    analysis/<feature>/<target>/suite_summary.csv
    analysis/<feature>/<target>/comparison.html
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INVENTORY = ROOT / 'protocol' / 'selected_functions_v1.csv'
ARMS = ('baseline', 'guided')


def load_json(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f'Required result is missing: {path}')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def get_target(name: str) -> dict:
    with INVENTORY.open(newline='', encoding='utf-8-sig') as f:
        records = list(csv.DictReader(f))
    found = [r for r in records if r.get('function') == name]
    if len(found) != 1:
        raise ValueError(f'Expected exactly one selected function {name!r}; got {len(found)}')
    return found[0]


def normalized_mutants(report: dict) -> dict:
    result = {}
    for filename, details in report.get('files', {}).items():
        for mutant in details.get('mutants', []):
            key = (filename.replace('\\', '/'), str(mutant['id']))
            if key in result:
                raise ValueError(f'Duplicate mutant key: {key}')
            loc = mutant.get('location') or {}
            result[key] = {
                'file': key[0], 'id': key[1],
                'mutator': mutant.get('mutatorName', ''),
                'replacement': mutant.get('replacement', ''),
                'start_line': (loc.get('start') or {}).get('line'),
                'start_column': (loc.get('start') or {}).get('column'),
                'end_line': (loc.get('end') or {}).get('line'),
                'end_column': (loc.get('end') or {}).get('column'),
                'status': mutant.get('status', 'Unknown'),
            }
    if not result:
        raise ValueError('Stryker report did not contain any mutants')
    return result


def sort_key(key):
    try:
        return (key[0], 0, int(key[1]))
    except ValueError:
        return (key[0], 1, key[1])


def summarize(target: str, feature: str, arm: str, mutants: dict, evaluation: dict) -> dict:
    counts = Counter(item['status'] for item in mutants.values())
    killed = counts['Killed']
    timeout = counts['Timeout']
    survived = counts['Survived']
    no_coverage = counts['NoCoverage']
    total = len(mutants)
    scored = killed + timeout + survived + no_coverage
    cov = evaluation.get('coverage') or {}
    tests = evaluation.get('tests') or {}
    return {
        'feature': feature, 'function': target, 'method': arm,
        'compilation': evaluation.get('compilation', 'unknown'),
        'execution': evaluation.get('execution', 'unknown'),
        'tests': tests.get('tests'), 'test_pass': tests.get('pass'), 'test_fail': tests.get('fail'),
        'module_line_coverage_percent': cov.get('line_percent'),
        'module_branch_coverage_percent': cov.get('branch_percent'),
        'coverage_scope': cov.get('status', 'unknown'),
        'mutants_total': total, 'killed': killed, 'timeout': timeout,
        'survived': survived, 'no_coverage': no_coverage,
        'other_mutant_statuses': total - scored,
        'stryker_mutation_score_percent': round(100 * (killed + timeout) / scored, 2) if scored else None,
        'strict_kill_percent': round(100 * killed / scored, 2) if scored else None,
    }


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        raise ValueError('Cannot write empty CSV')
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def make_html(target: str, rows: list[dict], summaries: list[dict]) -> str:
    def status(s: str) -> str:
        cls = {'Killed': 'kill', 'Timeout': 'timeout', 'Survived': 'survive'}.get(s, 'other')
        return f'<span class="status {cls}">{html.escape(str(s))}</span>'

    def esc(x):
        return html.escape(str(x))

    table_rows = '\n'.join(
        '<tr>'
        f'<td>{esc(r["mutant_id"])}</td>'
        f'<td><strong>{esc(r["mutator"])}</strong><small>Line {esc(r["start_line"])} · replacement: <code>{esc(r["replacement"])}</code></small></td>'
        f'<td>{status(r["baseline_status"])}</td><td>{status(r["guided_status"])}</td>'
        '</tr>'
        for r in rows
    )
    cards = []
    for s in summaries:
        total = s['mutants_total'] or 1
        k = 100 * s['killed'] / total
        t = 100 * s['timeout'] / total
        sv = 100 * s['survived'] / total
        name = 'Baseline' if s['method'] == 'baseline' else 'Specification-guided'
        cards.append(f'''<section class="card"><h3>{name}</h3>
        <div class="big">{s['killed']} / {s['mutants_total']}</div>
        <div class="sub">Explicitly killed by failing tests</div>
        <div class="bar"><div class="k" style="width:{k:.2f}%"></div><div class="t" style="width:{t:.2f}%"></div><div class="s" style="width:{sv:.2f}%"></div></div>
        <p>{s['timeout']} timed out · {s['survived']} survived · {s['no_coverage']} no coverage</p>
        <p><strong>Official mutation score: {s['stryker_mutation_score_percent']}%</strong></p>
        <p>Original tests passed: {s['test_pass']}/{s['tests']}</p>
        <p>Module line coverage: {s['module_line_coverage_percent']}%</p></section>''')
    return f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Summit – {esc(target)} mutation comparison</title>
    <style>
    body{{max-width:1120px;margin:35px auto;padding:0 20px;font:16px/1.5 system-ui,sans-serif;color:#202328}}
    table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #e2e5e8;text-align:left;padding:12px 10px;vertical-align:top}}th{{background:#f5f6f8}}
    small{{color:#656a70;display:block;font-size:12px}}code{{overflow-wrap:anywhere}}.status{{padding:4px 8px;border-radius:5px;font-weight:650;font-size:13px}}
    .kill{{color:#14632e;background:#e5f5e8}}.timeout{{color:#9a6200;background:#fff2d8}}.survive{{color:#a12222;background:#ffe5e5}}.other{{color:#555;background:#eee}}
    .cards{{display:grid;grid-template-columns:1fr 1fr;gap:25px;margin:28px 0}}.card{{border:1px solid #d9dfe4;border-radius:12px;padding:20px}}.card h3{{margin-top:0}}
    .big{{font-size:36px;font-weight:bold}}.sub{{color:#656a70}}.bar{{height:13px;border-radius:10px;display:flex;overflow:hidden;background:#edf0f2;margin-top:12px}}.k{{background:#16a34a}}.t{{background:#e4ac38}}.s{{background:#d04e4e}}
    .note{{color:#595e65;font-size:14px}}@media(max-width:700px){{.cards{{grid-template-columns:1fr}}}}@media print{{.card{{break-inside:avoid}}}}
    </style></head><body>
    <h1>{esc(target)} — LLM unit-test comparison</h1>
    <p class="note">Main study; one generated suite per arm. Exactly matching mutant definitions verified before this report was generated.</p>
    <div class="cards">{''.join(cards)}</div>
    <h2>Individual mutant outcomes</h2>
    <table><thead><tr><th>Mutant ID</th><th>Mutation</th><th>Baseline</th><th>Guided</th></tr></thead><tbody>{table_rows}</tbody></table>
    <p class="note">A killed mutant caused a failing test; a timeout exceeded the execution limit; a survived mutant passed. Stryker counts killed and timed-out mutants in its official mutation score. Coverage values are for the entire source module, not the individual target function. These outcomes do not establish general superiority from one function.</p>
    </body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True)
    args = parser.parse_args()

    target = get_target(args.target)
    feature = target['feature']
    base = ROOT / 'experiments' / feature / args.target

    mutants_by_arm = {}
    evaluations = {}
    for arm in ARMS:
        folder = base / arm
        mutants_by_arm[arm] = normalized_mutants(load_json(folder / 'mutation' / 'mutation.json'))
        evaluations[arm] = load_json(folder / 'evaluation' / 'evaluation_result.json')
        mutation_run = load_json(folder / 'mutation' / 'mutation_result.json')
        if mutation_run.get('status') != 'passed' or mutation_run.get('inputs_unchanged_after_run') is not True:
            raise RuntimeError(f'{arm} mutation run status/input-integrity check failed')

    b = mutants_by_arm['baseline']
    g = mutants_by_arm['guided']
    if set(b) != set(g):
        raise RuntimeError('Baseline and guided mutant IDs/files differ: cannot make a matched comparison')

    rows = []
    fields = ('mutator', 'replacement', 'start_line', 'start_column', 'end_line', 'end_column')
    for key in sorted(b, key=sort_key):
        x = b[key]
        y = g[key]
        if any(x[field] != y[field] for field in fields):
            raise RuntimeError(f'Mutation definition mismatch for {key}: cannot compare fairly')
        rows.append({
            'feature': feature, 'function': args.target, 'file': x['file'],
            'mutant_id': x['id'], 'mutator': x['mutator'],
            'start_line': x['start_line'], 'start_column': x['start_column'],
            'end_line': x['end_line'], 'end_column': x['end_column'],
            'replacement': x['replacement'],
            'baseline_status': x['status'], 'guided_status': y['status'],
        })

    summaries = [summarize(args.target, feature, arm, mutants_by_arm[arm], evaluations[arm]) for arm in ARMS]
    output = ROOT / 'analysis' / feature / args.target
    output.mkdir(parents=True, exist_ok=True)
    write_csv(output / 'mutant_comparison.csv', rows)
    write_csv(output / 'suite_summary.csv', summaries)
    (output / 'comparison.html').write_text(make_html(args.target, rows, summaries), encoding='utf-8')

    print(f'VERIFIED: {len(rows)} identical mutant definitions, both methods.')
    for item in summaries:
        print(f"{item['method']}: {item['killed']} killed, {item['timeout']} timeout, "
              f"{item['survived']} survived; official score {item['stryker_mutation_score_percent']}%")
    print('SAVED:', output)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('ERROR:', exc, file=sys.stderr)
        sys.exit(1)
