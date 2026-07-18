# ryu-sandbox

Sandbox execution primitive for Ryu: `run(command|wasm, spec) -> output` behind a
swappable backend seam.

## Role in the decomposition

An extracted Core capability crate — **in-process by default** and consumed as a
**non-optional path dependency**: Core's sidecar / session / eval-code data paths
reach it unconditionally. It carries **zero dependency on `apps/core`**. Host
couplings it cannot own (Gateway url/bearer for metering, the ryu-dir for the
persisted backend selection, the registered org id, the preferences-backed default
run budget) inject via the global `SandboxHost` seam (`host.rs`, `install_host`).

## Key API (`src/lib.rs` + modules)

- `Sandbox` trait — `run` / workspace-session contract implemented by every backend.
- `SandboxBackend` (`Wasmtime` | `Docker` | `Custom`) + `select_backend` /
  `default_backend` / `configured_backend` / `SandboxBackendStore` — named
  selection; a typo surfaces as a real error, never a silent downgrade.
- `ExecSpec` / `ExecOutput` / `SandboxCapabilities` / `SandboxScope` /
  `WorkspaceAccess` / `WorkspaceId` — the exec contract; capabilities are lowered
  from `ryu-kernel-contracts` `PermissionSet`.
- `heartbeat.rs` — per-run metering heartbeat (kill-isolation + Gateway
  `sandbox/tick` debit). `session.rs` — long-lived-workspace path.
- Backends: `wasmtime.rs` (feature `sandbox-wasmtime`), `docker.rs`,
  `microsandbox.rs`, `opensandbox.rs`, `daytona.rs` (remote REST).

## Swap seam

`select_backend(preferred)` picks by name. **wasmtime/WASI** is the in-process
default (only one built INTO Core, always resolves); command backends (docker,
microsandbox, opensandbox) and remote Daytona are detect-gated swaps. There is no
lower-isolation fallback below the default by design — a missing strong backend
fails loudly, never silently downgrades.

## Consumed as

Compiled-into-Core crate (default path dependency); `sandbox-wasmtime` off in
`default` to keep CI lean, forwarded on by the shipped binaries.
