# Specification-Guided LLM Unit Test Generation

**Study:** Evaluating Specification-Guided LLM Unit Test Generation Using Mutation Testing

## Overview

This project examines whether adding software specifications to an LLM prompt improves the quality of generated unit tests. The study uses 12 functions from the Summit TypeScript backend and compares two conditions:

- **Code-only (baseline):** source code and common test-generation instructions.
- **Specification-guided:** the same inputs plus requirements derived from Summit user stories, the Product Backlog, and implementation clarifications.

Both conditions use **GPT-6.1 Sol** and request **eight tests per function**. Tests are evaluated for compilation, execution against the original implementation, and fault detection with **StrykerJS**. The test framework is Node.js `node:test`.

## Main files

- `generate_baseline_tests.py`, `generate_guided_tests.py`, `llm_common.py` — prompt construction and test generation.
- `run_main_study.py`, `run_research_mutation.py` — study coordination and mutation evaluation.
- `summit/app/server/` — backend source and StrykerJS configuration.
- `specifications/` — project-derived requirements in JSON format.
- `experiments/` — archived prompts, generated tests, and execution records.
- `analysis/` — comparisons and saved evaluation reports.
- `requirements.txt` — Python dependencies.

## Safe checks

Run from the research project root:

```powershell
python -m pip install -r requirements.txt
python generate_baseline_tests.py --target registerService
python generate_guided_tests.py --target registerService
python run_research_mutation.py --target registerService --arm baseline --check
python run_research_mutation.py --target registerService --arm guided --check
```

These commands prepare prompts or check mutation configurations; they **do not** generate new LLM responses or rerun mutation testing. The completed experiment's results are archived in `experiments/` and `analysis/`.

## Results

The study produced **24 test suites (192 tests)**. All suites compiled; **11/12 baseline** and **12/12 guided** suites passed all tests against the original code. Across **11 matched functions and 89 mutants**, baseline explicitly killed **88** mutants (one timeout), and guided killed **89**. Both conditions achieved a **100% official StrykerJS mutation score**. These are descriptive results from a small, single-project study.
