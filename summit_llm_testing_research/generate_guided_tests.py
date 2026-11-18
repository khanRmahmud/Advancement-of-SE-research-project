#!/usr/bin/env python3
"""Generate or dry-run one specification-guided LLM test suite for a Summit target.

Example (no API request): python generate_guided_tests.py --target loginService
Example (paid once):    python generate_guided_tests.py --target loginService --send
"""

from llm_common import run_generation

if __name__ == "__main__":
    run_generation("guided")
