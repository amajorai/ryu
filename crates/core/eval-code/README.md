# ryu-eval-code

Core-side **code evaluators** (unified-evaluator plan, P4): run a user-supplied
`(input, output, expected, vars) -> {score}` function in an isolated runtime to
score one eval case, then merge the real scores into the Gateway's eval-run
response.

## Role in the decomposition

An extracted Core capability crate, lifted verbatim from `apps/core/src/eval_code`.
Code execution is a Core capability, so this stays a **library crate on the Core hot
path**, compiled in by default and carrying **zero dependency on `apps/core`**. It
builds on the sibling sandbox primitives (`ryu-tool-exec`, `ryu-sandbox`) rather
than reaching back into the kernel.

## Key API (`src/lib.rs`)

- `run_code_evaluator(spec, case) -> CodeEvalOutcome` — score a single case.
- `merge_code_evaluators(...)` — merge real scores into the Gateway eval-run
  response.
- `CodeEvaluatorSpec` / `CaseInput` / `CodeEvalOutcome` / `CodeEvalLang` — the
  evaluator contract (JS / Python).
- `env_scrub.rs` — child-env scrubbing for the evaluator subprocess.

## Swap seam / backends

- **JS** — runs via the deny-all Deno backend (`ryu-tool-exec::run_eval_js`), gated
  by the `tool-exec-deno` feature forwarded to `ryu-tool-exec`. Default **ON** so
  `cargo test -p ryu-eval-code` exercises the JS path; with it OFF, `run_js`
  returns an honest `executed: false` skip.
- **Python** — runs via the swappable `ryu-sandbox` backend, or a host fallback.

## Consumed as

Compiled-into-Core library crate (default path dependency); `default =
["tool-exec-deno"]`.
