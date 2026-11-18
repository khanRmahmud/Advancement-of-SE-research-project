# Summit LLM unit-test study — locked candidate set v1

**Decision:** Use 12 implemented backend service functions across four feature areas. Perform exactly one code-only and one specification-guided generation per function (24 initial generated suites). Keep `removePostService` separately as the pilot and do not include its previously observed metrics in confirmatory estimates.

The 12 JSON files under `specifications/approved/` contain **source-backed requirements**, with provenance notes. "Approved" means the research team has chosen to proceed with these scope-limited statements; it does **not** claim full third-party SRS verification. Never expand requirements by reverse-engineering code and label them independent specification.

**Email verification correction:** There is no email delivery provider. The backend creates a verification code and prints it to Docker/server logs. The user manually enters that code. `registerService` calls `sendVerificationCode`, a console-oriented adapter. Do not ask GPT to test actual email delivery. `loginService` checks account-verification state.

**Comment voting:** `voteCommentService` is implemented in the backend and the initial backlog documents voting on replies. A frontend voting control is **not verified**. The backend service remains an eligible unit-test target; no assumption is made about UI availability.

**Do not claim unsupported semantics:** The original backlog does not define exact HTTP error codes/messages, duplicate community-join semantics, vote toggle rules, or all deleted-comment behavior. These can be tested as implementation-based cases but must not be called independently documented requirements.

**Next implementation priorities:**
1. Freeze a source commit and SHA-256 hashes and preserve these inputs.
2. Adapt generators to accept `--source`, `--target`, `--spec`, one run per target, and immutable output paths.
3. Generate a single baseline/guided pair per function. Preserve raw code even if it fails.
4. Compile/test each suite in a clean isolated build; measure target-scope coverage and StrykerJS mutations with identical sets in each pair.
5. Save complete logs, raw tests, prompts, tokens, scores, and mutant statuses.

**Methodological note:** Lack of repeated LLM generations limits conclusions about generative variability. Do not describe the study as deterministic. Requirements coverage should use only those requirements testable at the service layer, with end-to-end requirements clearly flagged.
