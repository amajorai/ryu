# ryu-tool-exec

The programmatic-tool-calling (PTC) code-execution sandbox primitive for Ryu
(#476): run untrusted tool-orchestration code in an isolated subprocess.

## Role in the decomposition

An extracted Core capability crate — **in-process by default** and consumed as a
**non-optional path dependency**: Core's PTC path (`run_sandboxed` /
`resume_parked` / `is_available`) links it in every build. It carries **zero
dependency on `apps/core`**. The MCP tool-call coupling injects via the `ToolCaller`
trait and the security scrubbers (untrusted-marker stripping, child-env scrub) via
`HostHooks` (`install_host_hooks`). The Gateway budget/scan/audit bracket, the
agent-allowlist, and governed `http` egress stay Core-side.

## Key API (`src/lib.rs` + modules)

- `CodeExecutor` (`Deno` | `SecureExec` | `Unavailable`) + `default_backend()` /
  `is_available()` — the swappable backend enum; the type is non-empty even with
  no backend feature (lean builds link a valid, sandbox-less tool-exec).
- `run_sandboxed` / `run_sandboxed_with_permissions` / `run_sandboxed_with_augment`
  / `resume_parked` — the execution entry points.
- `SandboxToolInvoker` / `SandboxBridge` (`invoker.rs`) — the sandbox-to-host
  bridge; `ToolInvocation` / `ExecOutcome` / `Elicitation` / `ResumeDecision`.
- `parked.rs` — bounded parked-execution store for Composio connect/resume.
- `schema.rs` — Contract-4 tool/eval schema defs. `deno_backend.rs` also exports
  `run_eval_js` (used by `ryu-eval-code`).

## Swap seam

- **Deno subprocess** (`tool-exec-deno`, default) — deny-by-default permissions
  lowered from `ryu-kernel-contracts` `PermissionSet`, real isolation, killable.
- **secure-exec V8-isolate** (`tool-exec-securexec`, off) — Linux + `bun`.
- **Unavailable** — always present; reports the miss instead of pretending.

## Consumed as

Compiled-into-Core crate (default path dependency); `default = ["tool-exec-deno"]`.
