# ryu-code-runner

Language runners behind the workflow **`code`** step (`NodeKind::Code`): run or
check a Lean 4, Bend 2, or BAML program and return the step output.

## Role in the decomposition

A Core capability crate with **zero dependency on `apps/core`**. Core owns the
node (what runs, template resolution of `input`/`args`, the gateway route); this
crate owns how each language is invoked, isolated, bounded and interpreted. It
builds on `ryu-sandbox` for command execution.

## Key API (`src/lib.rs`)

- `run_code(&CodeRequest) -> Result<CodeOutput, String>`: run or check one program.
- `CodeLanguage` (`lean` / `bend` / `baml`) and `CodeMode` (`run` / `check`), the
  serde wire enums used by `NodeKind::Code`.
- `LlmRoute`: the gateway base URL, token and model the BAML `Ryu` client uses.
- Limits: `MAX_SOURCE_BYTES`, `MAX_INPUT_BYTES`, `MAX_OUTPUT_BYTES`,
  `DEFAULT_TIMEOUT` (120 s), `MAX_TIMEOUT` (300 s).

## Languages

| Language | `run` | `check` |
|----------|-------|---------|
| Lean 4 | `lean --run Main.lean <input>`; stdout | `lean Main.lean`; fails on errors or `declaration uses sorry` |
| Bend 2 | `bend main.bend -- <input>`; stdout | `bend main.bend --check-only`; requires `ALL PROOFS CHECK` |
| BAML | `baml-cli serve` + `POST /call/<function>` | `baml-cli check` |

## Isolation

- **Lean / Bend** can perform arbitrary IO (Lean even at elaboration time via
  `#eval`). They run through a live command-capable `ryu-sandbox` backend, with
  the source passed as a positional argument to a fixed `sh -c` script. Without
  one, release builds refuse unless `RYU_WORKFLOW_ALLOW_UNSANDBOXED_CODE=1`;
  debug builds fall back to the host. Host runs use a fresh temp directory and a
  cleared environment (`PATH`, `HOME`, locale, temp and toolchain-home variables
  only).
- **BAML** has no IO besides model calls, so `baml-cli` runs on the host with a
  cleared environment, a random `BAML_PASSWORD` (the server binds every
  interface), an empty working directory (it reads `.env` from there), and a
  Core-written `client<llm> Ryu` whose base URL, token and model come from the
  server environment. Sources that declare their own clients are refused.

## Toolchains

Resolved in order: `RYU_LEAN_BIN` / `RYU_BEND_BIN` / `RYU_BAML_BIN`, then the
installer home (`~/.elan/bin`, `~/.bend/bin`), then `PATH`.

## Tests

`cargo test -p ryu-code-runner`. The real-toolchain tests run when `lean`,
`bend`, or `baml-cli` resolve and print a skip line otherwise; the BAML run test
uses an in-process mock gateway, so it needs no model credentials.
