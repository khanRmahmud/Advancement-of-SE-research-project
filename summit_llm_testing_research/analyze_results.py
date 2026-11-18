#!/usr/bin/env python3
"""Compare mutation reports from the SAME target module in two StrykerJS arms."""
import argparse
from collections import Counter
import csv
import json
from pathlib import Path

ELIGIBLE = {"Killed", "Survived", "NoCoverage", "Timeout"}
DETECTED = {"Killed", "Timeout"}  # Stryker's standard detected convention


def parse_report(path):
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    mutants = {}
    for file, data in report.get("files", {}).items():
        for m in data.get("mutants", []):
            # Distinguishes two mutants even if locations match.
            key = (file.replace("\\", "/"), str(m.get("id")), str(m.get("replacement")))
            mutants[key] = m.get("status", "Unknown")
    return mutants


def stats(data):
    counts = Counter(data.values())
    eligible = sum(counts[k] for k in ELIGIBLE)
    detected = sum(counts[k] for k in DETECTED)
    return counts, eligible, 100 * detected / eligible if eligible else None


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--baseline", required=True)
    p.add_argument("--guided", required=True)
    p.add_argument("--csv", default="mutation-comparison.csv")
    args = p.parse_args()
    baseline = parse_report(args.baseline)
    guided = parse_report(args.guided)
    if not baseline or not guided:
        p.error("A report has no mutants; check your Stryker config/target module")
    rows = []
    for arm, mutants in [("baseline", baseline), ("guided", guided)]:
        counts, denominator, score = stats(mutants)
        row = {"arm": arm, "killed": counts["Killed"], "timeout": counts["Timeout"],
               "survived": counts["Survived"], "no_coverage": counts["NoCoverage"],
               "eligible": denominator, "mutation_score_pct": "" if score is None else f"{score:.2f}",
               "excluded_other": sum(n for status, n in counts.items() if status not in ELIGIBLE)}
        rows.append(row)
        print(row)
    Path(args.csv).parent.mkdir(parents=True, exist_ok=True)
    with Path(args.csv).open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    eligible_b = {k for k, v in baseline.items() if v in ELIGIBLE}
    eligible_g = {k for k, v in guided.items() if v in ELIGIBLE}
    if eligible_b != eligible_g:
        print("WARNING: Eligible mutation IDs differ across arms; inspect target/config before drawing conclusions.")
        print("Only baseline:", len(eligible_b - eligible_g), "Only guided:", len(eligible_g - eligible_b))
    else:
        print("Same eligible mutant identities detected across arms:", len(eligible_b))
    print("Comparison saved to", args.csv)
    print("CAUTION: Mutation score is not real-bug detection accuracy.")


if __name__ == "__main__":
    main()
