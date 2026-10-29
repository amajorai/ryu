# ryu-tool-exec

The programmatic-tool-calling (PTC) code-execution sandbox primitive for Ryu
(#476): run untrusted tool-orchestration JavaScript with no access to the host
beyond the tool bridge.

## Role in the decomposition

An extracted Core capability crate — **in-process by default** and consumed as a
**non-optional path dependency**: Core's PTC path (`run_sandboxed` /
`resume_parked` / `is_available`) links it in every build. It carries **zero
dependency on `apps/core`**. The MCP tool-call coupling injects via the `ToolCaller`
trait and the security scrubbers (untrusted-marker stripping, child-env scrub) via
`HostHooks` (`install_host_hooks`). The Gateway budget/scan/audit bracket, the
agent-allowlist, and governed `http` egress stay Core-side.

## Key API (`src/lib.rs` + modules)

- `CodeExecutor` (`Js` | `Unavailable`) + `default_backend()` / `is_available()` —
  the swappable backend enum; the type is non-empty even with no backend feature
  (lean builds link a valid, sandbox-less tool-exec).
- `run_sandboxed` / `run_sandboxed_with_permissions` / `run_sandboxed_with_augment`
  / `resume_parked` — the execution entry points; `run_eval_js` runs a pure eval
  function (used by `ryu-eval-code`).
- `SandboxToolInvoker` / `SandboxBridge` (`invoker.rs`) — the sandbox-to-host
  bridge; `ToolInvocation` / `ExecOutcome` / `Elicitation` / `ResumeDecision`.
- `parked.rs` — bounded parked-execution store for Composio connect/resume.
- `schema.rs` — Contract-4 tool/eval schema defs.

## The sandbox

`js_backend.rs` (feature `js-sandbox`, default) runs QuickJS — the Bytecode
Alliance's Javy runtime — compiled to WebAssembly, in-process under Wasmtime.

- The guest's source is `guest/` (its own Cargo package, built for
  `wasm32-wasip1` only). The committed `assets/ryu_js_guest.wasm` is what the
  host embeds, so ordinary builds need no WASI toolchain. It lives in `assets/`,
  not `guest/`, because `cargo package` leaves nested packages out of the
  `.crate`; `tools/publish-crates.sh` checks the packaged file list for it.
- `assets/ryu_js_guest.wasm.sha256` records the blob's hash, and the
  `embedded_guest_matches_its_recorded_sha256` test fails if the two disagree, so
  the binary cannot change without a visible diff to the hash.
- **Rebuilding the guest.** After editing `guest/src/main.rs` (or bumping its
  `guest/Cargo.lock`), run `tools/build-js-guest.sh` from the repository root.
  It needs `rustup` and either `WASI_SDK=<path to a wasi-sdk install>` or a
  system clang with the wasm32 target plus a WASI sysroot (see the script
  header). It builds `guest/` in release mode for `wasm32-wasip1`, copies the
  result to `assets/ryu_js_guest.wasm`, and rewrites the `.sha256` file; commit
  all three changes together. The toolchain is not pinned, so a rebuild is not
  byte-for-byte reproducible across machines: review the source diff, not the
  blob.
- `warm_up(cache_dir)` compiles the guest on a background thread at host startup
  (Core calls it with `<data dir>/cache/js-sandbox`). The compiled guest is kept
  there and loaded by later processes: 14 to 25 ms instead of about 0.7 to 0.9 s
  of Cranelift compilation on the benchmark hosts. A cache file is used only if its
  checksum matches, its name matches this engine and guest, this user owns it and
  nobody else can write it; otherwise the guest is compiled again. The disk cache
  is unix only: on other platforms the compiled guest is never written to or read
  from disk (leftover compiles are deleted), and it is compiled once per process.
- Programs see `tools.<server>.<tool>(args)`, `console`, timers, `URL` /
  `URLSearchParams`, `TextEncoder`/`TextDecoder` and `childProcess.run`. There is no
  `fetch`, filesystem, environment or module loader.
- A `PermissionSet` granting filesystem or network is refused. `child_process`
  lets `childProcess.run` start only the bare names in `SandboxAugment::run_allow`.
- Bounds: wall-clock deadline (the guest yields every 10 ms), memory cap
  (`RYU_TOOL_EXEC_MEMORY_MB`, default 256), 64 KiB guest frames, capped logs and
  output. A paused run is parked by not polling it, and resumes where it stopped.
- Concurrency: operations fan out, but one run has at most 8 tool calls, 2 child
  processes and 1,024 timers in flight. An operation keeps its slot until the
  program reads its result, so finished-but-unread results are bounded by the
  same caps. Further operations wait in a queue of at most 10,000 operations
  (4 MiB of requests); a program that overflows it (for example a loop that
  starts calls and never awaits them) fails with an error asking for smaller
  batches. Log lines past the log budget are dropped before they are copied out
  of the guest.
- On Windows, `childProcess.run` resolves an allow-listed bare name through the
  child's `PATH` and `PATHEXT`, so the `.cmd` capability shims start by base name.
- `src/bench.rs` is an ignored benchmark of the sandbox (first run, per-workload
  latency, throughput, peak memory). Run it twice, so the second run loads the
  cached guest:
  `cargo test -p ryu-tool-exec --release bench_js_sandbox -- --ignored --nocapture`.

## Consumed as

Compiled-into-Core crate (default path dependency); `default = ["js-sandbox"]`.
