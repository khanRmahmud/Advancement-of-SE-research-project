#!/usr/bin/env python3
"""Generate or dry-run one code-only LLM unit-test suite for a Summit target.

Example (no API request): python generate_baseline_tests.py --target loginService
Example (paid once):    python generate_baseline_tests.py --target loginService --send
"""

from llm_common import run_generation

if __name__ == "__main__":
    run_generation("baseline")
