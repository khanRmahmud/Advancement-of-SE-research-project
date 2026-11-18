
"""
Create a visual mutation-testing report for Summit Trial 02.

Reads:
    baseline-trial02/mutation.json
    guided-trial02/mutation.json

Creates:
    trial02_results.html
    trial02_mutants.csv
    trial02_summary.csv

No GPT API calls.
No mutation tests are rerun.
Original generated tests are not modified.
"""

from __future__ import annotations

import csv
import html
import json
from collections import Counter
from pathlib import Path


# ============================================================
# 1. Paths and experiment settings
# ============================================================

ROOT = Path(__file__).resolve().parent

TRIAL = 2
TRIAL_NAME = f"trial{TRIAL:02d}"

REPORT_ROOT = (
    ROOT / "summit" / "app" / "server"
    / "reports" / "mutation"
)

OUTPUT_DIR = (
    ROOT / "local-logs" / "posts.service" / TRIAL_NAME
)


# ============================================================
# 2. Human-readable descriptions of observed mutations
#
# These descriptions correspond to our Trial 02 mutants.
# The program checks the mutation type and replacement.
# If they differ, it uses a generic description instead.
# ============================================================

KNOWN_MUTATIONS = {
    "0": (
        "BlockStatement",
        "{}",
        "Remove the function body (replace it with {})"
    ),
    "1": (
        "ConditionalExpression",
        "true",
        "Replace ownership condition with true"
    ),
    "2": (
        "ConditionalExpression",
        "false",
        "Replace ownership condition with false"
    ),
    "3": (
        "EqualityOperator",
        "existingPost.authorId === userId",
        "Change ownership comparison from !== to ==="
    ),
    "4": (
        "BlockStatement",
        "{}",
        "Remove the unauthorized-access error block"
    ),
    "6": (
        "StringLiteral",
        '""',
        "Replace forbidden-error message with an empty string"
    ),
    "7": (
        "ObjectLiteral",
        "{}",
        "Replace the success response object with {}"
    ),
    "8": (
        "BooleanLiteral",
        "false",
        "Replace success: true with success: false"
    ),
}


# ============================================================
# 3. Read StrykerJS JSON report
# ============================================================

def read_report(arm: str) -> dict:

    path = (
        REPORT_ROOT
        / f"{arm}-{TRIAL_NAME}"
        / "mutation.json"
    )

    if not path.is_file():
        raise FileNotFoundError(
            f"Missing StrykerJS report: {path}"
        )

    return json.loads(
        path.read_text(encoding="utf-8-sig")
    )


# ============================================================
# 4. Extract individual mutations
# ============================================================

def extract_mutants(report: dict) -> dict:

    result = {}

    for filename, info in report.get("files", {}).items():

        for mutant in info.get("mutants", []):

            mutant_id = str(mutant.get("id"))
            key = (filename, mutant_id)

            if key in result:
                raise ValueError(
                    f"Duplicate mutant: {key}"
                )

            location = mutant.get("location") or {}
            start = location.get("start") or {}

            result[key] = {
                "filename": filename,
                "id": mutant_id,
                "line": start.get("line"),
                "mutator": mutant.get("mutatorName", ""),
                "replacement": mutant.get("replacement", ""),
                "status": mutant.get("status", "Unknown"),
            }

    if not result:
        raise ValueError(
            "No mutants found in StrykerJS report"
        )

    return result


# ============================================================
# 5. Describe what StrykerJS changed
# ============================================================

def description(item: dict) -> str:

    known = KNOWN_MUTATIONS.get(item["id"])

    if known:
        expected_type = known[0]
        expected_replacement = known[1]

        if (
            item["mutator"] == expected_type
            and item["replacement"] == expected_replacement
        ):
            return known[2]

    return (
        f"{item['mutator']}: "
        f"replace with {item['replacement']!r}"
    )


# ============================================================
# 6. Sort mutation IDs
# ============================================================

def sort_key(key):

    try:
        number = int(key[1])
    except ValueError:
        number = 10**9

    return key[0], number, key[1]


# ============================================================
# 7. Save CSV files
# ============================================================

def write_csv(path: Path, rows: list[dict]) -> None:

    if not rows:
        return

    with path.open(
        "w",
        newline="",
        encoding="utf-8-sig"
    ) as output:

        writer = csv.DictWriter(
            output,
            fieldnames=list(rows[0])
        )

        writer.writeheader()
        writer.writerows(rows)


# ============================================================
# 8. Calculate mutation statistics
# ============================================================

def summarize(arm: str, mutants: dict) -> dict:

    counts = Counter(
        item["status"]
        for item in mutants.values()
    )

    killed = counts["Killed"]
    timeout = counts["Timeout"]
    survived = counts["Survived"]
    no_coverage = counts["NoCoverage"]

    total = len(mutants)

    denominator = (
        killed
        + timeout
        + survived
        + no_coverage
    )

    if denominator == 0:
        raise ValueError(
            f"No scored mutants found for {arm}"
        )

    official_score = (
        100 * (killed + timeout) / denominator
    )

    killed_only = (
        100 * killed / total
    )

    return {
        "trial": TRIAL,
        "method": arm,
        "model": "gpt-6.1-sol",
        "generated_test_cases": 8,
        "original_tests_passed": 8,
        "mutants_total": total,
        "killed": killed,
        "timeout": timeout,
        "survived": survived,
        "no_coverage": no_coverage,
        "other_statuses": total - denominator,
        "stryker_mutation_score_percent": round(
            official_score, 2
        ),
        "killed_only_percent": round(
            killed_only, 2
        ),
    }


# ============================================================
# 9. HTML status formatting
# ============================================================

def status_html(status: str) -> str:

    classes = {
        "Killed": "killed",
        "Timeout": "timeout",
        "Survived": "survived",
        "NoCoverage": "nocov",
    }

    css = classes.get(status, "other")

    return (
        f'<span class="status {css}">'
        f'{html.escape(status)}'
        f'</span>'
    )


# ============================================================
# 10. Create summary cards and progress bars
# ============================================================

def summary_card(summary: dict) -> str:

    total = summary["mutants_total"]
    killed = summary["killed"]
    timeout = summary["timeout"]
    survived = summary["survived"]

    killed_width = 100 * killed / total
    timeout_width = 100 * timeout / total
    survived_width = 100 * survived / total

    name = (
        "Baseline"
        if summary["method"] == "baseline"
        else "Specification-guided"
    )

    return f"""
    <section class="summary">

      <h3>{name}</h3>

      <div class="big">
        {killed} / {total}
      </div>

      <div class="sub">
        Killed by failing tests
      </div>

      <div class="bar">

        <span class="bar-killed"
              style="width:{killed_width:.2f}%">
        </span>

        <span class="bar-timeout"
              style="width:{timeout_width:.2f}%">
        </span>

        <span class="bar-survived"
              style="width:{survived_width:.2f}%">
        </span>

      </div>

      <div class="detail">
        {timeout} timeouts · {survived} survived
      </div>

      <div class="detail">
        <strong>
          Stryker mutation score:
          {summary['stryker_mutation_score_percent']:.2f}%
        </strong>
      </div>

      <div class="detail">
        Killed-only:
        {summary['killed_only_percent']:.2f}%
      </div>

    </section>
    """


# ============================================================
# 11. Generate screenshot-style HTML report
# ============================================================

def create_html(
    comparison: list[dict],
    summaries: list[dict]
) -> str:

    entries = []

    for row in comparison:

        entries.append(
            "<tr>"
            f"<td>{html.escape(row['mutant_id'])}</td>"
            f"<td>{html.escape(row['mutation_description'])}"
            f"<div class='mutant-detail'>"
            f"{html.escape(row['mutator'])} "
            f"· line {row['line']}"
            f"</div></td>"
            f"<td>{status_html(row['baseline_status'])}</td>"
            f"<td>{status_html(row['guided_status'])}</td>"
            "</tr>"
        )

    return f"""<!doctype html>
<html lang="en">
<head>

<meta charset="utf-8" />
<meta name="viewport"
      content="width=device-width, initial-scale=1" />

<title>Summit Trial 02 Mutation Results</title>

<style>

* {{
  box-sizing: border-box;
}}

body {{
  font: 16px/1.5 system-ui, sans-serif;
  max-width: 1120px;
  margin: 34px auto;
  padding: 0 22px;
  color: #202124;
  background: #ffffff;
}}

h1 {{
  font-size: 26px;
}}

h2 {{
  font-size: 21px;
  margin-top: 30px;
}}

h3 {{
  font-size: 19px;
  margin: 0 0 14px;
}}

.note, .mutant-detail {{
  color: #65696e;
}}

.note {{
  font-size: 14px;
}}

.mutant-detail {{
  font-size: 12px;
  padding-top: 3px;
}}

table {{
  width: 100%;
  border-collapse: collapse;
  margin-top: 18px;
}}

th {{
  text-align: left;
  font-weight: 650;
  color: #444;
  border-bottom: 2px solid #e5e7eb;
}}

td, th {{
  padding: 12px 10px;
  border-bottom: 1px solid #e5e7eb;
  vertical-align: top;
}}

td:first-child {{
  width: 80px;
}}

td:nth-child(3), td:nth-child(4) {{
  width: 150px;
}}

.status {{
  font-size: 14px;
  font-weight: 600;
  padding: 4px 8px;
  border-radius: 5px;
}}

.killed {{
  background: #e4f4e9;
  color: #136a32;
}}

.timeout {{
  background: #fff1db;
  color: #975a00;
}}

.survived {{
  background: #ffe4e4;
  color: #a32121;
}}

.nocov, .other {{
  background: #eef0f2;
  color: #4b5563;
}}

.panel {{
  border: 1px solid #dedfe1;
  border-radius: 14px;
  padding: 22px;
  margin-top: 28px;
}}

.panel-title {{
  color: #666;
  font-size: 14px;
  margin-bottom: 16px;
}}

.summaries {{
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 28px;
}}

.big {{
  font-size: 34px;
  font-weight: 650;
}}

.sub {{
  margin: 5px 0 11px;
  color: #666;
}}

.bar {{
  height: 14px;
  width: 100%;
  display: flex;
  overflow: hidden;
  border-radius: 9px;
  background: #edf0f1;
}}

.bar-killed {{
  background: #16a34a;
}}

.bar-timeout {{
  background: #ecae37;
}}

.bar-survived {{
  background: #c95151;
}}

.detail {{
  margin-top: 6px;
  font-size: 14px;
  color: #555;
}}

@media (max-width: 700px) {{
  .summaries {{
    grid-template-columns: 1fr;
  }}
}}

@media print {{
  .panel {{
    break-inside: avoid;
  }}
}}

</style>

</head>
<body>

<h1>Trial 02 — Actual mutation-testing results</h1>

<p class="note">
GPT-6.1 Sol · Summit removePostService() ·
8 generated tests per method · Same 8 mutations
</p>

<table>

<thead>
<tr>
  <th>Mutant ID</th>
  <th>What StrykerJS changed</th>
  <th>Baseline</th>
  <th>Guided</th>
</tr>
</thead>

<tbody>
{''.join(entries)}
</tbody>

</table>

<div class="panel">

  <div class="panel-title">
    Confirmed comparison — GPT-6.1 Sol, Trial 02
  </div>

  <div class="summaries">
    {''.join(summary_card(s) for s in summaries)}
  </div>

</div>

<h2>How to interpret the results</h2>

<ul>
  <li>
    <strong>Killed:</strong>
    The tests failed against the mutated code.
  </li>

  <li>
    <strong>Timeout:</strong>
    The test command did not finish in time.
    StrykerJS counts this as detected.
  </li>

  <li>
    <strong>Survived:</strong>
    The tests passed despite the mutation.
  </li>

  <li>
    <strong>NoCoverage:</strong>
    The mutation was not covered by the tests,
    when coverage information is available.
  </li>
</ul>

<p class="note">
The official StrykerJS score includes killed and timed-out
mutants. The killed-only percentage is a supplementary
descriptive measure, not the official mutation score.

These are pilot results, not final evidence of a general
improvement from specification-guided prompting.
</p>

</body>
</html>
"""


# ============================================================
# 12. Main analysis
# ============================================================

def main() -> None:

    baseline = extract_mutants(
        read_report("baseline")
    )

    guided = extract_mutants(
        read_report("guided")
    )

    # Verify that the same mutations were used.

    if set(baseline) != set(guided):
        raise ValueError(
            "Mutant IDs differ between baseline and guided"
        )

    for key in baseline:

        for field in (
            "line",
            "mutator",
            "replacement"
        ):

            if baseline[key][field] != guided[key][field]:
                raise ValueError(
                    f"Different mutation definition: {key}"
                )

    # Build a comparison row for each mutant.

    comparison = []

    for key in sorted(baseline, key=sort_key):

        item = baseline[key]

        comparison.append({
            "mutant_id": item["id"],
            "source_file": item["filename"],
            "line": item["line"],
            "mutator": item["mutator"],
            "replacement": item["replacement"],
            "mutation_description": description(item),
            "baseline_status": item["status"],
            "guided_status": guided[key]["status"],
        })

    # Calculate summary statistics.

    summaries = [
        summarize("baseline", baseline),
        summarize("guided", guided),
    ]

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    # Save detailed mutant results.

    write_csv(
        OUTPUT_DIR / "trial02_mutants.csv",
        comparison
    )

    # Save summary results.

    write_csv(
        OUTPUT_DIR / "trial02_summary.csv",
        summaries
    )

    # Save the visual HTML report.

    html_report = create_html(
        comparison,
        summaries
    )

    html_path = OUTPUT_DIR / "trial02_results.html"

    html_path.write_text(
        html_report,
        encoding="utf-8"
    )

    # Show results in the terminal.

    print(
        "Verified: both methods used identical mutations."
    )

    print("\nTRIAL 02 MUTATION COMPARISON\n")

    print(
        f"{'ID':<4} "
        f"{'Mutation':<54} "
        f"{'Baseline':<10} "
        f"{'Guided'}"
    )

    print("-" * 88)

    for row in comparison:

        print(
            f"{row['mutant_id']:<4} "
            f"{row['mutation_description'][:53]:<54} "
            f"{row['baseline_status']:<10} "
            f"{row['guided_status']}"
        )

    print("\nTRIAL 02 SUMMARY\n")

    for result in summaries:

        print(
            f"{result['method']}: "
            f"{result['killed']} killed, "
            f"{result['timeout']} timeout, "
            f"{result['survived']} survived, "
            f"mutation score "
            f"{result['stryker_mutation_score_percent']:.2f}%, "
            f"killed-only "
            f"{result['killed_only_percent']:.2f}%"
        )

    print("\nVisual report saved:")
    print(html_path)

    print("\nCSV results saved in:")
    print(OUTPUT_DIR)


if __name__ == "__main__":
    main()
