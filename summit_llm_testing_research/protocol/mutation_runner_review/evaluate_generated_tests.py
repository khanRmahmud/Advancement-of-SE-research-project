#!/usr/bin/env python3
"""Compile and execute an original, archived GPT-generated Summit test suite.

One method is evaluated per invocation. The original generated.test.ts is
never modified, copied into Summit src, or automatically repaired.

Usage:
  python evaluate_generated_tests.py --target loginService --arm baseline
  python evaluate_generated_tests.py --target loginService --arm guided

Outputs per method: evaluation/compile.log, compile_result.json, test_run.tap,
test_stderr.log, coverage.lcov, evaluation_result.json.

This evaluator does not run StrykerJS; that will be a separate stage after
we verify these first runs. Node coverage is reported at the module level
until source-mapped function-level coverage is independently validated.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "summit" / "app" / "server"
INVENTORY = ROOT / "protocol" / "selected_functions_v1.csv"
COMPILER = ROOT / "protocol" / "compile_archived_test.cjs"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_target(name: str) -> dict[str, str]:
    with INVENTORY.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    matches = [r for r in rows if r.get("function") == name]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one function named {name!r}; found {len(matches)}")
    return matches[0]


def tap_counts(tap_file: Path) -> dict[str, int | None]:
    text = tap_file.read_text(encoding="utf-8", errors="replace") if tap_file.exists() else ""
    values: dict[str, int | None] = {}
    for label in ("tests", "pass", "fail", "cancelled", "skipped", "todo"):
        matches = re.findall(rf"(?m)^# {label} (\d+)\s*$", text)
        values[label] = int(matches[-1]) if matches else None
    return values


def module_lcov(lcov_path: Path, source_file: str) -> dict | None:
    if not lcov_path.exists():
        return None
    expected_stem = Path(source_file).stem  # e.g., auth.services
    current: dict[str, str] = {}
    matches = []
    for line in lcov_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line == "end_of_record":
            if Path(current.get("SF", "")).stem == expected_stem:
                matches.append(current.copy())
            current.clear()
        elif ":" in line:
            key, value = line.split(":", 1)
            if key in {"SF", "LH", "LF", "BRH", "BRF"}:
                current[key] = value
    if len(matches) != 1:
        return {"status": "module_coverage_unavailable_or_ambiguous", "matching_records": len(matches)}
    record = matches[0]
    result = {"status": "module_level_only", "covered_file": record["SF"]}
    for key in ("LH", "LF", "BRH", "BRF"):
        result[key.lower()] = int(record[key]) if record.get(key, "").isdigit() else None
    if result.get("lf"):
        result["line_percent"] = round(100 * result["lh"] / result["lf"], 2)
    if result.get("brf"):
        result["branch_percent"] = round(100 * result["brh"] / result["brf"], 2)
    return result


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def evaluate(target: str, arm: str, timeout_seconds: int) -> None:
    info = load_target(target)
    function = info["function"]
    feature = info["feature"]
    source_relative = info["source_file"].replace("\\", "/")
    original_source = BACKEND / source_relative
    archive = ROOT / "experiments" / feature / function / arm
    original_test = archive / "generated.test.ts"
    snapshot = archive / "source_snapshot.ts"
    metadata_file = archive / "metadata.json"
    output = archive / "evaluation"
    compiled_workspace = BACKEND / ".research-evaluation" / function / arm

    for necessary in (original_source, original_test, snapshot, metadata_file, COMPILER):
        if not necessary.is_file():
            raise FileNotFoundError(necessary)
    if digest(original_source) != digest(snapshot):
        raise RuntimeError(
            f"Source changed since generation: {original_source}. "
            "Do not evaluate against a different source snapshot."
        )
    metadata = json.loads(metadata_file.read_text(encoding="utf-8-sig"))
    recorded_hash = metadata.get("generated_test_sha256")
    if recorded_hash and recorded_hash != digest(original_test):
        raise RuntimeError(f"Original GPT test differs from generation metadata: {original_test}")
    if output.exists() and any(output.iterdir()):
        raise RuntimeError(
            f"Evaluation folder already has data: {output}. "
            "Preserve it; do not overwrite research results."
        )
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "protocol": "main-study-evaluation-v1",
        "feature": feature,
        "target": function,
        "method": arm,
        "generated_test_sha256": digest(original_test),
        "source_sha256": digest(original_source),
        "started_utc": utc_now(),
        "compilation": "not_started",
        "execution": "not_started",
        "node_exit_code": None,
        "tests": None,
        "coverage": None,
        "mutations": "not_run_in_this_step",
        "original_test_edited": False,
    }

    def save() -> None:
        report["updated_utc"] = utc_now()
        (output / "evaluation_result.json").write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    compiler_command = [
        "node", str(COMPILER), str(BACKEND), str(original_test),
        source_relative, target, arm, str(compiled_workspace)
    ]
    print(f"\n=== {feature}/{target} | {arm.upper()} ===", flush=True)
    print("Compiling archived GPT test without modifying Summit src...", flush=True)
    try:
        compile_process = subprocess.run(
            compiler_command, cwd=BACKEND, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=180
        )
    except subprocess.TimeoutExpired:
        report["compilation"] = "compiler_timeout"
        save()
        print("Compilation timed out. Result preserved.", flush=True)
        return
    (output / "compile.log").write_text(
        compile_process.stdout + "\n" + compile_process.stderr, encoding="utf-8"
    )
    compile_metadata_path = compiled_workspace / "compile_result.json"
    if compile_metadata_path.exists():
        compile_result = json.loads(compile_metadata_path.read_text(encoding="utf-8"))
        (output / "compile_result.json").write_text(
            json.dumps(compile_result, indent=2) + "\n", encoding="utf-8"
        )
    else:
        compile_result = {}
    if compile_process.returncode != 0 or not compile_result.get("success"):
        report["compilation"] = "failed"
        report["compiler_exit_code"] = compile_process.returncode
        save()
        print("Compilation FAILED. See compile.log. No manual repairs applied.")
        return

    report["compilation"] = "passed"
    saved_js = Path(compile_result["compiled_test_js"])
    if not saved_js.is_file():
        report["compilation"] = "missing_compiled_output"
        save()
        return

    tap_path = output / "test_run.tap"
    lcov_path = output / "coverage.lcov"
    node_command = [
        "node", "--enable-source-maps", "--experimental-test-module-mocks",
        "--experimental-test-coverage", "--test",
        "--test-reporter=tap", f"--test-reporter-destination={tap_path}",
        "--test-reporter=lcov", f"--test-reporter-destination={lcov_path}",
        str(saved_js),
    ]
    (output / "test_command.json").write_text(
        json.dumps(node_command, indent=2) + "\n", encoding="utf-8"
    )
    print("Running one archived suite against the unmodified implementation...", flush=True)
    try:
        process = subprocess.run(
            node_command, cwd=BACKEND, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout_seconds
        )
    except subprocess.TimeoutExpired as err:
        report["execution"] = "timeout"
        report["timeout_seconds"] = timeout_seconds
        (output / "test_stderr.log").write_text(
            str(err) + "\n", encoding="utf-8"
        )
        report["tests"] = tap_counts(tap_path)
        report["coverage"] = module_lcov(lcov_path, source_relative)
        save()
        print("Tests TIMED OUT. Original generated suite retained.", flush=True)
        return
    (output / "test_stderr.log").write_text(process.stderr, encoding="utf-8")
    (output / "test_stdout.log").write_text(process.stdout, encoding="utf-8")
    report["node_exit_code"] = process.returncode
    report["tests"] = tap_counts(tap_path)
    report["coverage"] = module_lcov(lcov_path, source_relative)
    if (
        process.returncode == 0
        and report["tests"]["tests"] is not None
        and report["tests"]["fail"] == 0
        and report["tests"]["cancelled"] == 0
    ):
        report["execution"] = "passed"
    else:
        report["execution"] = "failed_or_unclassified"
    save()
    counts = report["tests"]
    print(f"Compilation: {report['compilation']}")
    print(f"Execution: {report['execution']} | tests={counts['tests']} pass={counts['pass']} fail={counts['fail']}")
    print(f"Module coverage: {report['coverage']}")
    print(f"Saved evidence: {output}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--arm", choices=("baseline", "guided"), required=True)
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()
    if args.timeout < 5 or args.timeout > 600:
        parser.error("--timeout must be between 5 and 600 seconds")
    evaluate(args.target, args.arm, args.timeout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
