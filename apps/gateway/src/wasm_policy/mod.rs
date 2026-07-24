//! Gateway WASM policy tier — untrusted third-party policy code, in-process.
//!
//! This is the highest-risk piece of the gateway plugin plane: a policy plugin
//! whose code runs **inside** the gateway (the security choke point that governs
//! every model call), handed a request excerpt and returning a verdict. Because
//! the code is untrusted, the entire value of this module is its *sandbox
//! correctness*. The threat model (recon) concludes that with a fresh `Store`,
//! zero host functions, and no WASI, cross-request/cross-tenant **exfil is
//! structurally impossible** (the guest only ever sees the current request and
//! cannot persist or transmit), so the real v1 risk collapses to **availability
//! (DoS)** and **fail-direction correctness** — both addressed by the controls
//! below.
//!
//! ## Sandbox controls (all v1 MUST, enforced here — file:line in review notes)
//! - **No WASI**: we never call `wasmtime_wasi::*::add_to_linker`. The [`Linker`]
//!   is constructed with ZERO host imports. This denies filesystem, network,
//!   env/args, wall-clock (`clock_time_get`) and entropy (`random_get`) **by
//!   construction** — a module that imports any of them is rejected at load
//!   ([`WasmPolicyHost::load_module`] import check).
//! - **Bounded CPU**: `Config::consume_fuel(true)` + `Store::set_fuel`.
//! - **Bounded wall-time**: `Config::epoch_interruption(true)` +
//!   `Store::set_epoch_deadline` + a background ticker thread calling
//!   `Engine::increment_epoch` (epoch is INERT without the ticker).
//! - **Bounded memory**: `Store::limiter` with `StoreLimitsBuilder::memory_size`.
//! - **No threads / shared memory**: `Config::wasm_threads(false)`.
//! - **Fresh `Store` per call**: shared `Engine` + cached compiled `Module`, but a
//!   NEW `Store` every request, so no state persists across calls or tenants.
//! - **Compile once**: modules are content-addressed (sha256) and compiled once,
//!   then cached; at config-declaration `PUT /v1/config` the module is compiled +
//!   import-validated OFF the request path.
//! - **Don't block the reactor**: guest execution runs on `spawn_blocking` behind a
//!   [`Semaphore`] so a slow plugin can neither stall the async runtime nor exhaust
//!   the blocking pool.
//! - **Input/output caps**: input excerpt, module bytes, and the guest-returned
//!   `reason` string are all size-capped; the reason is control-char/newline
//!   stripped before it can enter an audit row or HTTP body.
//!
//! ## ABI (v1) — see [`WasmVerdict`] and the module doc on the guest contract.
//!
//! ## Dedupe / follow-up
//! Core's `apps/core/src/sandbox/` is a bare M6 spike: `Engine::default()`, the
//! FULL WASI p1 linker, and NONE of fuel/epoch/`StoreLimits`. There is therefore
//! nothing safe to reuse from it — this host is built fresh, pinned to the same
//! wasmtime v45. The documented follow-up is to factor a shared `ryu-wasm-host`
//! crate (this hardened `Config` + limits + epoch ticker) under `crates/` and
//! retrofit the Core spike, which is itself currently unsafe for untrusted wasm.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};

/// Max decoded module size (bytes). Bounds the compile cost + memory of an
/// untrusted module blob.
const MAX_MODULE_BYTES: usize = 8 * 1024 * 1024;
/// Max size of the base64-ENCODED module string, checked by the pipeline arm
/// before it decodes an untrusted manifest field (bounds the decode work itself).
/// ~4/3 of the decoded cap, plus slack for padding/whitespace.
pub const MAX_MODULE_B64_LEN: usize = MAX_MODULE_BYTES / 3 * 4 + 1024;
/// Max input excerpt handed to the guest (bytes). Caps per-call work + the copy
/// into guest memory.
const MAX_INPUT_BYTES: usize = 128 * 1024;
/// Max bytes of the guest-returned `reason` string (before it becomes an audit
/// row / HTTP body). Bounds log-injection / response-poisoning blast radius.
const MAX_REASON_BYTES: usize = 512;
/// Per-call linear-memory cap (bytes). A guest that tries to grow past this has
/// `memory.grow` denied; a guest whose *initial* memory exceeds it fails to
/// instantiate — either way it never touches host memory.
const MEM_CAP_BYTES: usize = 16 * 1024 * 1024;
/// Per-call fuel budget (bounded CPU). Enough for real policy logic, small enough
/// that a tight loop is trapped in well under the epoch deadline.
const DEFAULT_FUEL: u64 = 200_000_000;
/// Epoch ticker interval.
const EPOCH_TICK_MS: u64 = 10;
/// Epoch deadline in ticks (=> ~`EPOCH_TICK_MS * EPOCH_DEADLINE_TICKS` ms wall
/// budget). The hard ceiling on guest wall-time regardless of fuel.
const EPOCH_DEADLINE_TICKS: u64 = 20;
/// Max concurrent guest executions across the whole process. Bounds pressure on
/// the blocking pool so one slow plugin can't starve all traffic.
const MAX_CONCURRENT: usize = 8;

/// The verdict a policy guest returns for one request, plus the host's own
/// failure signal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WasmVerdict {
    /// Guest returned decision byte `0` — let the turn proceed.
    Allow,
    /// Guest returned decision byte `1` — deny with this (sanitized, bounded)
    /// reason. Routed through the binding's action map by the caller, so an
    /// operator may bind a deny-capable plugin as Block / Sanitize / Warn.
    Deny { reason: String },
    /// The host could not obtain a trustworthy verdict: trap, fuel exhaustion,
    /// epoch timeout, OOM/instantiation failure, missing/mistyped export, or
    /// invalid guest output. The CALLER decides the direction (default CLOSED for
    /// a security policy); this variant never itself allows a request.
    Fail { reason: String },
}

/// Per-`Store` data: just the resource limiter. No secrets, no cross-call state —
/// a fresh one is built for every call.
struct StoreData {
    limits: StoreLimits,
}

/// The hardened wasmtime host for untrusted policy modules. One per process,
/// lazily constructed and held in [`crate::state::AppState`].
pub struct WasmPolicyHost {
    engine: Engine,
    /// Compiled modules, content-addressed by sha256(bytes). Compilation happens
    /// once (at declaration or first use); every call reuses the `Arc<Module>`.
    modules: DashMap<String, Arc<Module>>,
    /// Bounds concurrent guest executions.
    sem: Arc<Semaphore>,
    /// Set on drop so the epoch ticker thread exits within one tick.
    stop: Arc<AtomicBool>,
}

impl WasmPolicyHost {
    /// Build the host: a hardened [`Engine`] and the background epoch ticker.
    /// Fallible only if wasmtime rejects the (fixed, safe) config.
    pub fn new() -> anyhow::Result<Self> {
        let mut config = Config::new();
        // Bounded CPU + bounded wall-time. Both are inert without the runtime
        // wiring below (fuel: `set_fuel`; epoch: `set_epoch_deadline` + ticker).
        config.consume_fuel(true);
        config.epoch_interruption(true);
        // No shared memory / atomics: denies the threads proposal outright.
        config.wasm_threads(false);
        // Deny the reference-types/GC proposals — pure-compute policy guests never
        // need them, and keeping the enabled proposal surface minimal shrinks the
        // JIT attack surface. (SIMD/bulk-memory left at defaults: pure compute, no
        // ambient authority.)
        config.wasm_reference_types(false);

        let engine = Engine::new(&config)?;

        // Epoch ticker: without a thread incrementing the epoch, `epoch_interruption`
        // never fires and there is NO wall-time bound (the exact reason Core's spike
        // has none). Detached; exits within one tick after `stop` is set on drop.
        let stop = Arc::new(AtomicBool::new(false));
        {
            let engine = engine.clone();
            let stop = Arc::clone(&stop);
            std::thread::Builder::new()
                .name("wasm-policy-epoch".into())
                .spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_millis(EPOCH_TICK_MS));
                        engine.increment_epoch();
                    }
                })?;
        }

        Ok(Self {
            engine,
            modules: DashMap::new(),
            sem: Arc::new(Semaphore::new(MAX_CONCURRENT)),
            stop,
        })
    }

    /// Compile + validate a module blob and cache it under its sha256. Used both at
    /// declaration (`PUT /v1/config`, off the request path) and lazily at first
    /// eval. Rejects (returns `Err`, fail-closed for the caller):
    ///   * oversized blobs;
    ///   * anything wasmtime won't validate;
    ///   * a module that **imports anything at all** — v1 grants zero host
    ///     functions, so any import (WASI, network, a bespoke host fn) is a load
    ///     failure. This is the "reject a module that imports outside the ABI"
    ///     control, enforced at load, independent of the empty-`Linker` belt below.
    pub fn load_module(&self, bytes: &[u8]) -> anyhow::Result<Arc<Module>> {
        if bytes.len() > MAX_MODULE_BYTES {
            anyhow::bail!(
                "wasm module too large: {} bytes (max {})",
                bytes.len(),
                MAX_MODULE_BYTES
            );
        }
        let key = hex::encode(Sha256::digest(bytes));
        if let Some(m) = self.modules.get(&key) {
            return Ok(Arc::clone(m.value()));
        }
        // Only ever from BINARY — never wat text — so untrusted manifests cannot
        // smuggle in a textual module the host would parse differently.
        let module = Module::from_binary(&self.engine, bytes)?;
        let import_count = module.imports().count();
        if import_count > 0 {
            let names: Vec<String> = module
                .imports()
                .map(|i| format!("{}::{}", i.module(), i.name()))
                .collect();
            anyhow::bail!(
                "wasm policy module declares {import_count} host import(s) — v1 grants \
                 zero host functions (no WASI, no network, no fs); imports: {}",
                names.join(", ")
            );
        }
        let module = Arc::new(module);
        self.modules.insert(key, Arc::clone(&module));
        Ok(module)
    }

    /// Evaluate `input` against the policy `module_bytes`, returning a verdict.
    /// Never allows on failure: any load/instantiate/trap/timeout/invalid-output
    /// yields [`WasmVerdict::Fail`], which the caller maps per the plugin's declared
    /// fail direction (default CLOSED). Runs the guest on `spawn_blocking` behind a
    /// concurrency semaphore so it can never stall the async reactor.
    pub async fn evaluate(&self, module_bytes: &[u8], input: &str) -> WasmVerdict {
        let module = match self.load_module(module_bytes) {
            Ok(m) => m,
            Err(e) => {
                return WasmVerdict::Fail {
                    reason: format!("module load: {e}"),
                }
            }
        };

        // Cap the excerpt on a char boundary so the guest gets valid-ish UTF-8.
        let mut input_bytes = input.as_bytes();
        if input_bytes.len() > MAX_INPUT_BYTES {
            let mut end = MAX_INPUT_BYTES;
            while end > 0 && !input.is_char_boundary(end) {
                end -= 1;
            }
            input_bytes = &input.as_bytes()[..end];
        }
        let input_owned = input_bytes.to_vec();

        let permit = match self.sem.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => {
                return WasmVerdict::Fail {
                    reason: "semaphore closed".into(),
                }
            }
        };
        let engine = self.engine.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit; // held for the whole blocking run
            run_guest(&engine, &module, &input_owned)
        })
        .await;

        match result {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => WasmVerdict::Fail {
                reason: sanitize_reason(&e.to_string()),
            },
            Err(join) => WasmVerdict::Fail {
                reason: format!("guest task panicked: {join}"),
            },
        }
    }
}

impl Drop for WasmPolicyHost {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Validate every `Wasm` evaluator in a custom-evaluator set at DECLARATION time
/// (`PUT /v1/config`): base64 decode, size cap, then a full compile + zero-import
/// check via [`WasmPolicyHost::load_module`] (which also warms the compiled-module
/// cache, so activation is off the request path). Returns the offending evaluator +
/// reason on the first rejection; non-`Wasm` evaluators are ignored. Extracted from
/// the config handler so the "reject at declaration" contract is unit-testable
/// without the auth / `ConnectInfo` HTTP plumbing.
pub fn validate_wasm_evaluators(
    host: &WasmPolicyHost,
    custom: &[crate::evaluators::Evaluator],
) -> Result<(), String> {
    use base64::Engine as _;
    for ev in custom {
        let crate::evaluators::EvaluatorImpl::Wasm { module_base64, .. } = &ev.impl_ else {
            continue;
        };
        if module_base64.len() > MAX_MODULE_B64_LEN {
            return Err(format!(
                "evaluator '{}': wasm module payload too large",
                ev.id
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(module_base64.as_bytes())
            .map_err(|e| format!("evaluator '{}': invalid base64 wasm module: {e}", ev.id))?;
        host.load_module(&bytes)
            .map_err(|e| format!("evaluator '{}': wasm module rejected: {e}", ev.id))?;
    }
    Ok(())
}

/// Synchronous single guest execution against a FRESH `Store`. All resource
/// bounds are installed BEFORE instantiation so a hostile `(start)` function or an
/// oversized initial memory is caught too. Any error here is a fail-closed signal.
fn run_guest(engine: &Engine, module: &Module, input: &[u8]) -> anyhow::Result<WasmVerdict> {
    let data = StoreData {
        limits: StoreLimitsBuilder::new()
            .memory_size(MEM_CAP_BYTES)
            .memories(1)
            .tables(1)
            .instances(1)
            .build(),
    };
    let mut store = Store::new(engine, data);
    // Order matters: caps must be live before instantiation (covers `(start)` +
    // OOM-at-instantiation).
    store.limiter(|d| &mut d.limits);
    store.set_fuel(DEFAULT_FUEL)?;
    store.set_epoch_deadline(EPOCH_DEADLINE_TICKS);

    // Zero host imports. A module that needs any import fails to instantiate here
    // (belt to `load_module`'s suspenders).
    let linker: Linker<StoreData> = Linker::new(engine);
    let instance = linker.instantiate(&mut store, module)?;

    // Optional ABI-version handshake: if the guest exports it, it must be 1.
    if let Ok(ver) = instance.get_typed_func::<(), i32>(&mut store, "ryu_abi_version") {
        let v = ver.call(&mut store, ())?;
        if v != 1 {
            anyhow::bail!("unsupported ABI version {v} (host speaks 1)");
        }
    }

    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or_else(|| anyhow::anyhow!("guest missing `memory` export"))?;
    let alloc = instance.get_typed_func::<i32, i32>(&mut store, "ryu_alloc")?;
    let eval = instance.get_typed_func::<(i32, i32), i64>(&mut store, "ryu_policy_eval")?;

    // Ask the guest for a buffer and write the input excerpt into it (checked
    // write — a hostile `ryu_alloc` pointer just errors → fail-closed).
    let len = input.len() as i32;
    let ptr = alloc.call(&mut store, len)?;
    if ptr < 0 {
        anyhow::bail!("ryu_alloc returned negative pointer {ptr}");
    }
    memory.write(&mut store, ptr as usize, input)?;

    // Run. Traps (fuel/epoch/OOB) surface as Err here → fail-closed.
    let packed = eval.call(&mut store, (ptr, len))?;

    // Unpack + validate the guest's output. High 32 bits = out ptr, low = out len.
    let out_ptr = ((packed >> 32) & 0xFFFF_FFFF) as usize;
    let out_len = (packed & 0xFFFF_FFFF) as usize;
    if out_len == 0 || out_len > 1 + MAX_REASON_BYTES {
        anyhow::bail!("guest returned invalid output length {out_len}");
    }
    let mut buf = vec![0u8; out_len];
    memory.read(&store, out_ptr, &mut buf)?; // checked read — OOB → Err → fail-closed
    match buf[0] {
        0 => Ok(WasmVerdict::Allow),
        1 => Ok(WasmVerdict::Deny {
            reason: sanitize_reason(&String::from_utf8_lossy(&buf[1..])),
        }),
        other => anyhow::bail!("guest returned invalid decision byte {other}"),
    }
}

/// Bound + de-fang a guest-controlled string before it can reach an audit row or
/// an HTTP error body: strip control chars / newlines (log-injection,
/// response-poisoning) and truncate to [`MAX_REASON_BYTES`].
fn sanitize_reason(reason: &str) -> String {
    let mut out = String::with_capacity(reason.len().min(MAX_REASON_BYTES));
    for ch in reason.chars() {
        if out.len() + ch.len_utf8() > MAX_REASON_BYTES {
            break;
        }
        // Keep a single space + any non-control, non-whitespace char; drop \n \r \t,
        // other whitespace, and all control chars.
        if ch == ' ' || (!ch.is_control() && !ch.is_whitespace()) {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Guest fixtures, authored as WAT and compiled to wasm at test time via the
    // `wat` dev-dep (no wasm32 toolchain, no committed opaque binary). ---
    //
    // ABI recap for the guests below:
    //   * export `memory`
    //   * export `ryu_alloc(size:i32)->i32` : return a ptr the host writes `size`
    //     input bytes to. (These guests use a fixed scratch offset 1024.)
    //   * export `ryu_policy_eval(ptr:i32,len:i32)->i64` : return
    //     `(out_ptr<<32)|out_len`, pointing at `[decision:u8][reason:utf8...]`.
    //
    // Result buffers are placed via `data` segments at fixed offsets:
    //   2048: `\00`               -> allow (len 1)
    //   2100: `\01denied`         -> deny  (len 7, reason "denied")

    /// Always allow.
    const ALLOW_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (data (i32.const 2048) "\00")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0800_0000_0001)))
    "#; // ptr 2048 (0x800), len 1

    /// Always deny with reason "denied".
    const DENY_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (data (i32.const 2100) "\01denied")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0834_0000_0007)))
    "#; // ptr 2100 (0x834), len 7 (1 decision + "denied")

    /// Input-sensitive: deny iff the first input byte is 'B' (0x42).
    const FIRST_BYTE_B_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (data (i32.const 2048) "\00")
        (data (i32.const 2100) "\01denied")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param $ptr i32) (param $len i32) (result i64)
          (if (result i64) (i32.eqz (local.get $len))
            (then (i64.const 0x0000_0800_0000_0001))
            (else
              (if (result i64)
                (i32.eq (i32.load8_u (local.get $ptr)) (i32.const 0x42))
                (then (i64.const 0x0000_0834_0000_0007))
                (else (i64.const 0x0000_0800_0000_0001)))))))
    "#;

    /// No-persistence probe: a mutable global starts 0; deny if it is non-zero,
    /// then set it to 1. With a fresh Store per call the global re-initialises to
    /// 0, so every call must Allow. If state leaked across calls, call 2 would Deny.
    const STATEFUL_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (global $seen (mut i32) (i32.const 0))
        (data (i32.const 2048) "\00")
        (data (i32.const 2100) "\01denied")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (if (result i64) (i32.eqz (global.get $seen))
            (then (global.set $seen (i32.const 1)) (i64.const 0x0000_0800_0000_0001))
            (else (i64.const 0x0000_0834_0000_0007)))))
    "#;

    /// Infinite loop — must be killed by fuel/epoch and fail closed.
    const INFINITE_LOOP_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (loop $l (br $l))
          (i64.const 0)))
    "#;

    /// Initial memory (300 pages ~= 19.6 MiB) exceeds MEM_CAP_BYTES (16 MiB), so the
    /// limiter denies it at instantiation → Fail.
    const MEM_BOMB_WAT: &str = r#"
      (module
        (memory (export "memory") 300)
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0800_0000_0001)))
    "#;

    /// Imports a WASI function — must be REJECTED at load (zero host imports).
    /// Stands in for network/fs/clock/entropy: all arrive as imports and are denied.
    const FORBIDDEN_IMPORT_WAT: &str = r#"
      (module
        (import "wasi_snapshot_preview1" "fd_write"
          (func (param i32 i32 i32 i32) (result i32)))
        (memory (export "memory") 1)
        (data (i32.const 2048) "\00")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0800_0000_0001)))
    "#;

    /// Returns a wildly out-of-range output length → invalid output → Fail.
    const BAD_OUTPUT_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0800_7FFF_FFFF)))
    "#; // len = 0x7FFFFFFF

    fn wasm(wat: &str) -> Vec<u8> {
        wat::parse_str(wat).expect("wat compiles")
    }

    #[tokio::test]
    async fn allow_and_deny_verdicts_enforced() {
        let host = WasmPolicyHost::new().unwrap();
        assert_eq!(
            host.evaluate(&wasm(ALLOW_WAT), "anything").await,
            WasmVerdict::Allow
        );
        assert_eq!(
            host.evaluate(&wasm(DENY_WAT), "anything").await,
            WasmVerdict::Deny {
                reason: "denied".into()
            }
        );
    }

    #[tokio::test]
    async fn verdict_depends_on_host_supplied_input() {
        let host = WasmPolicyHost::new().unwrap();
        let m = wasm(FIRST_BYTE_B_WAT);
        assert_eq!(
            host.evaluate(&m, "Blocked prompt").await,
            WasmVerdict::Deny {
                reason: "denied".into()
            }
        );
        assert_eq!(
            host.evaluate(&m, "allowed prompt").await,
            WasmVerdict::Allow
        );
        assert_eq!(host.evaluate(&m, "").await, WasmVerdict::Allow);
    }

    #[tokio::test]
    async fn no_cross_call_state_leak() {
        let host = WasmPolicyHost::new().unwrap();
        let m = wasm(STATEFUL_WAT);
        // If the Store (and its globals) persisted, the 2nd call would Deny.
        assert_eq!(host.evaluate(&m, "x").await, WasmVerdict::Allow);
        assert_eq!(host.evaluate(&m, "x").await, WasmVerdict::Allow);
        assert_eq!(host.evaluate(&m, "x").await, WasmVerdict::Allow);
    }

    #[tokio::test]
    async fn infinite_loop_is_killed_and_fails_closed() {
        let host = WasmPolicyHost::new().unwrap();
        let t0 = std::time::Instant::now();
        let v = host.evaluate(&wasm(INFINITE_LOOP_WAT), "x").await;
        assert!(
            matches!(v, WasmVerdict::Fail { .. }),
            "infinite loop must Fail, got {v:?}"
        );
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(5),
            "must be bounded by fuel/epoch, took {:?}",
            t0.elapsed()
        );
    }

    #[tokio::test]
    async fn memory_bomb_is_capped_and_fails_closed() {
        let host = WasmPolicyHost::new().unwrap();
        let v = host.evaluate(&wasm(MEM_BOMB_WAT), "x").await;
        assert!(
            matches!(v, WasmVerdict::Fail { .. }),
            "over-cap memory must Fail, got {v:?}"
        );
    }

    #[tokio::test]
    async fn forbidden_import_rejected_at_load() {
        let host = WasmPolicyHost::new().unwrap();
        // Rejected at load (compile/validate), independent of any call.
        assert!(host.load_module(&wasm(FORBIDDEN_IMPORT_WAT)).is_err());
        // And via evaluate → Fail (fail-closed).
        assert!(matches!(
            host.evaluate(&wasm(FORBIDDEN_IMPORT_WAT), "x").await,
            WasmVerdict::Fail { .. }
        ));
    }

    #[tokio::test]
    async fn invalid_output_fails_closed() {
        let host = WasmPolicyHost::new().unwrap();
        assert!(matches!(
            host.evaluate(&wasm(BAD_OUTPUT_WAT), "x").await,
            WasmVerdict::Fail { .. }
        ));
    }

    #[tokio::test]
    async fn garbage_bytes_rejected_at_load() {
        let host = WasmPolicyHost::new().unwrap();
        assert!(host.load_module(b"not a wasm module").is_err());
    }

    fn wasm_eval(id: &str, wat: &str) -> crate::evaluators::Evaluator {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(wasm(wat));
        crate::evaluators::Evaluator {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            category: crate::evaluators::EvaluatorCategory::Security,
            target: crate::evaluators::EvaluatorTarget::Input,
            capabilities: crate::evaluators::Capabilities {
                inline: true,
                offline: false,
            },
            impl_: crate::evaluators::EvaluatorImpl::Wasm {
                module_base64: b64,
                fail_open: false,
            },
            inline: None,
            offline: None,
            builtin: false,
            enforced: true,
            higher_is_better: true,
        }
    }

    /// Declaration-boundary validation (the config-handler path, minus HTTP
    /// plumbing): a good module is accepted; a forbidden-import module is REJECTED
    /// at declaration; non-wasm evaluators are ignored.
    #[test]
    fn validate_wasm_evaluators_rejects_at_declaration() {
        let host = WasmPolicyHost::new().unwrap();
        assert!(validate_wasm_evaluators(&host, &[wasm_eval("ok", ALLOW_WAT)]).is_ok());
        assert!(
            validate_wasm_evaluators(&host, &[wasm_eval("bad", FORBIDDEN_IMPORT_WAT)]).is_err()
        );
        // A non-wasm evaluator is ignored (no wasm to validate).
        let non_wasm = crate::evaluators::Evaluator {
            impl_: crate::evaluators::EvaluatorImpl::Heuristic,
            ..wasm_eval("nw", ALLOW_WAT)
        };
        assert!(validate_wasm_evaluators(&host, &[non_wasm]).is_ok());
    }

    #[test]
    fn sanitize_reason_strips_control_and_bounds() {
        let dirty = "line1\nline2\r\tTAB\u{0007}bell";
        let clean = sanitize_reason(dirty);
        assert!(!clean.contains('\n') && !clean.contains('\r') && !clean.contains('\t'));
        assert!(!clean.contains('\u{0007}'));
        let long = "a".repeat(MAX_REASON_BYTES * 2);
        assert!(sanitize_reason(&long).len() <= MAX_REASON_BYTES);
    }
}
