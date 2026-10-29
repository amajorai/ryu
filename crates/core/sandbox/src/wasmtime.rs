//! wasmtime backend implementing the Core [`Sandbox`] trait (M6 / issue #190).
//!
//! Compiles and runs WASM/WASI modules in-process with strict default-deny
//! capabilities. No external process is spawned; no daemon is required.
//!
//! ## Capability model
//!
//! `WasmtimeSandbox` maps [`SandboxCapabilities`] directly to WASIp1 context
//! knobs:
//!   - `fs_read_paths` → `WasiCtxBuilder::preopened_dir` with
//!     `FsPerms::ReadOnly` (read contents and metadata; no create, delete,
//!     write, or truncate).
//!   - `fs_write_paths` → `WasiCtxBuilder::preopened_dir` with
//!     `FsPerms::ReadWrite` (union with read set when the same path appears in
//!     both).
//!   - `network` → not directly controllable via WASIp1 (the WASI socket ABI
//!     is WASIp2); the standard WASIp1 linker does not expose socket syscalls
//!     by default, so the default-deny is structural, not explicit.
//!
//! Any FS `path_open` call to an un-preopened path returns `errno::NOENT` from
//! the WASI layer — the capability was never granted so it cannot be exercised.
//!
//! ## Engine sharing
//!
//! A single engine initialises the Cranelift JIT compiler once; reusing the
//! same engine across calls avoids re-initialisation cost (~10–30 ms). Epoch
//! interruption is enabled on that engine so every execution can enforce its
//! requested wall-clock timeout even when guest code never yields.
//! `WasmtimeSandbox` holds the engine via `Arc` so clones share it.
//!
//! ## Feature gate
//!
//! This module compiles only when the `sandbox-wasmtime` Cargo feature is
//! enabled.  The MCP dispatch layer provides a graceful-degrade response when
//! the feature is absent.

#[cfg(feature = "sandbox-wasmtime")]
use std::sync::Arc;
#[cfg(feature = "sandbox-wasmtime")]
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::BoxFuture;

/// Ephemeral wasmtime sandbox: one WASM module, one run, auto-teardown.
///
/// Long-lived workspace (`create_workspace` / `exec_in_workspace` /
/// `destroy_workspace`) is not supported by this backend — wasmtime modules
/// are fundamentally single-invocation; long-lived state requires a persistent
/// container.  The workspace methods return a clear error so callers fall back
/// to an appropriate backend (e.g. Docker).
#[derive(Clone)]
pub struct WasmtimeSandbox {
    #[cfg(feature = "sandbox-wasmtime")]
    engine: Arc<wasmtime::Engine>,
}

#[cfg(feature = "sandbox-wasmtime")]
const EPOCH_TICK: Duration = Duration::from_millis(10);
#[cfg(feature = "sandbox-wasmtime")]
const MAX_GUEST_MEMORY_BYTES: usize = 64 * 1024 * 1024;

impl WasmtimeSandbox {
    /// Construct the sandbox, initialising the Cranelift JIT engine.
    ///
    /// Returns an error only if the engine fails to initialise (extremely rare;
    /// typically indicates a system-level problem such as missing CPU features).
    pub fn new() -> Result<Self> {
        #[cfg(feature = "sandbox-wasmtime")]
        {
            let mut config = wasmtime::Config::new();
            config.epoch_interruption(true);
            // Only the two admitted workers compile; do not fan each module out
            // into additional parallel compiler jobs.
            config.parallel_compilation(false);
            let engine = wasmtime::Engine::new(&config)?;
            let weak = engine.weak();
            std::thread::Builder::new()
                .name("ryu-wasmtime-epoch".to_owned())
                .spawn(move || {
                    while let Some(engine) = weak.upgrade() {
                        std::thread::sleep(EPOCH_TICK);
                        engine.increment_epoch();
                    }
                })
                .map_err(|error| anyhow!("failed to start wasmtime epoch ticker: {error}"))?;
            Ok(Self {
                engine: Arc::new(engine),
            })
        }
        #[cfg(not(feature = "sandbox-wasmtime"))]
        {
            Ok(Self {})
        }
    }
}

// ── Sandbox trait implementation ─────────────────────────────────────────────

impl Sandbox for WasmtimeSandbox {
    fn name(&self) -> &'static str {
        "wasmtime"
    }

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        #[cfg(feature = "sandbox-wasmtime")]
        {
            let engine = Arc::clone(&self.engine);
            // wasmtime-wasi's synchronous WASI shims may drive their own Tokio
            // runtime. Keep the synchronous guest call off the caller's async
            // runtime so it cannot try to block the runtime worker that is
            // currently polling this future.
            Box::pin(async move {
                anyhow::ensure!(
                    spec.stdin
                        .as_ref()
                        .is_none_or(|bytes| bytes.len() <= 4 * 1024 * 1024),
                    "WASM module exceeds compilation input limit"
                );
                static WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
                let permit = WORKERS
                    .try_acquire()
                    .map_err(|_| anyhow!("WASM worker admission limit reached"))?;
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    exec_wasm(&engine, spec)
                })
                .await
                .map_err(|error| anyhow!("wasmtime worker failed: {error}"))?
            })
        }
        #[cfg(not(feature = "sandbox-wasmtime"))]
        {
            let _ = spec;
            Box::pin(async move {
                Err(anyhow!(
                    "wasmtime sandbox is not available: recompile with `--features sandbox-wasmtime`"
                ))
            })
        }
    }

    fn create_workspace(&self, _caps: SandboxCapabilities) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            Err(anyhow!(
                "wasmtime backend does not support long-lived workspaces; \
                 use the docker backend for persistent container workspaces"
            ))
        })
    }

    fn exec_in_workspace(
        &self,
        _id: &WorkspaceId,
        _spec: ExecSpec,
    ) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            Err(anyhow!(
                "wasmtime backend does not support long-lived workspaces"
            ))
        })
    }

    fn destroy_workspace(&self, _id: &WorkspaceId) -> BoxFuture<Result<()>> {
        Box::pin(async move {
            Err(anyhow!(
                "wasmtime backend does not support long-lived workspaces"
            ))
        })
    }
}

// ── Core execution logic (feature-gated) ─────────────────────────────────────

#[cfg(feature = "sandbox-wasmtime")]
fn exec_wasm(engine: &wasmtime::Engine, spec: ExecSpec) -> Result<ExecOutput> {
    use wasmtime::{Linker, Module, Store, StoreLimitsBuilder};
    use wasmtime_wasi::{p2::pipe::MemoryOutputPipe, WasiCtxBuilder};

    // Accept WASM bytecode from spec.stdin; the command field names the module
    // conceptually (argv[0]).  Callers that want to run WASM pass the bytes as
    // stdin; callers that want a native command get an appropriate error.
    let wasm_bytes = spec.stdin.ok_or_else(|| {
        anyhow!(
            "wasmtime backend requires WASM bytecode via `stdin`; \
             set ExecSpec::stdin to the module bytes"
        )
    })?;

    anyhow::ensure!(
        wasm_bytes.len() <= 4 * 1024 * 1024,
        "WASM module exceeds compilation input limit"
    );
    validate_compilation_shape(&wasm_bytes)?;
    let started = Instant::now();
    // Compile the module (Cranelift JIT — typically 40–120 ms for a small
    // module).  The engine caches compilations internally when possible.
    let module = Module::from_binary(engine, &wasm_bytes)?;

    // Wire WASIp1 into a linker.
    struct GuestState {
        wasi: wasmtime_wasi::p1::WasiP1Ctx,
        limits: wasmtime::StoreLimits,
    }
    let mut linker: Linker<GuestState> = Linker::new(engine);
    wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |s| &mut s.wasi)?;

    // Capture stdout/stderr in memory.
    let cap = 4 * 1024 * 1024; // 4 MiB cap
    let stdout_pipe = MemoryOutputPipe::new(cap);
    let stderr_pipe = MemoryOutputPipe::new(cap);

    // Build the WASI context.  Default: no preopened dirs, deny-all.  The
    // guest environment holds only the caller's explicit `spec.env` pairs;
    // nothing is inherited from the host.
    let mut builder = WasiCtxBuilder::new();
    builder.stdout(stdout_pipe.clone());
    builder.stderr(stderr_pipe.clone());
    builder.envs(&spec.env);

    // argv: [spec.command, ...spec.args]
    let argv: Vec<String> = std::iter::once(spec.command.clone())
        .chain(spec.args.iter().cloned())
        .collect();
    let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    builder.args(&argv_refs);

    // Map granted FS paths into WASI preopens, honoring the declared workspace
    // access level. `effective_mounts` applies the None/ReadOnly/ReadWrite clamp
    // (the default ReadWrite reproduces the historical per-path behavior: read
    // paths read-only, write paths read+write).
    let caps = &spec.capabilities;
    for (path, writable) in caps.effective_mounts() {
        // wasmtime-wasi 48 collapsed the separate dir/file permission bitsets
        // into one `FsPerms`: `ReadOnly` (read contents + metadata; no create,
        // delete, write, or truncate) and `ReadWrite` (all of the above) — the
        // exact pair the old `DirPerms`/`FilePerms` combinations expressed.
        let perms = if writable {
            wasmtime_wasi::FsPerms::ReadWrite
        } else {
            wasmtime_wasi::FsPerms::ReadOnly
        };
        builder.preopened_dir(&path, path.to_string_lossy().as_ref(), perms)?;
    }

    let wasi = builder.build_p1();

    // Instantiate and run the module. Epoch interruption is driven by the
    // engine ticker started in `new`; the store deadline is set per execution
    // so one request cannot influence another request's timeout.
    let limits = StoreLimitsBuilder::new()
        .memory_size(MAX_GUEST_MEMORY_BYTES)
        .table_elements(10_000)
        .memories(1)
        .tables(4)
        .instances(1)
        .build();
    let mut store = Store::new(engine, GuestState { wasi, limits });
    store.limiter(|state| &mut state.limits);
    let timeout_secs = Some(spec.timeout_secs.unwrap_or(120));
    let timeout = Duration::from_secs(timeout_secs.unwrap());
    let remaining = timeout
        .checked_sub(started.elapsed())
        .ok_or_else(|| anyhow!("wasmtime compilation exceeded execution deadline"))?;
    let deadline_ticks = (remaining.as_millis().min(u64::MAX as u128) as u64)
        .div_ceil(EPOCH_TICK.as_millis() as u64)
        .max(1);
    store.set_epoch_deadline(deadline_ticks);
    linker.module(&mut store, "", &module)?;
    let func = linker
        .get_default(&mut store, "")
        .map_err(|e| anyhow!("no default export (_start): {e}"))?
        .typed::<(), ()>(&store)?;

    // `proc_exit(0)` surfaces as a trap wrapping `I32Exit(0)` — normal WASI.
    let run_result = func.call(&mut store, ());
    let elapsed = started.elapsed();
    drop(store); // flush memory pipe buffers

    let stdout = stdout_pipe.contents().to_vec();
    let stderr = stderr_pipe.contents().to_vec();

    let exit_code = match run_result {
        Ok(()) => 0,
        Err(trap) => {
            let epoch_timeout = trap.to_string().contains("epoch deadline");
            if timeout_secs
                .is_some_and(|secs| epoch_timeout || elapsed >= Duration::from_secs(secs))
            {
                let secs = timeout_secs.expect("timeout checked above");
                return Err(anyhow!("wasmtime execution timed out after {secs}s"));
            }
            if let Some(exit) = trap.downcast_ref::<wasmtime_wasi::I32Exit>() {
                exit.0
            } else {
                // Unexpected trap — surface as exit code 1.
                tracing::warn!("wasmtime unexpected trap: {trap}");
                1
            }
        }
    };

    Ok(ExecOutput {
        exit_code,
        stdout,
        stderr,
    })
}

#[cfg(feature = "sandbox-wasmtime")]
fn validate_compilation_shape(bytes: &[u8]) -> Result<()> {
    use wasmparser::{Parser, Payload};
    let mut total_code = 0usize;
    let mut types = 0usize;
    let mut type_elements = 0usize;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::ImportSection(section) => {
                // Compact imports group many names under one section entry.
                for (index, import) in section.into_imports().enumerate() {
                    import?;
                    anyhow::ensure!(index < 4096, "WASM imports exceed compilation limit");
                }
            }
            Payload::ExportSection(section) => {
                anyhow::ensure!(
                    section.count() <= 4096,
                    "WASM exports exceed compilation limit"
                );
            }
            Payload::GlobalSection(section) => {
                anyhow::ensure!(
                    section.count() <= 4096,
                    "WASM globals exceed compilation limit"
                );
            }
            Payload::ElementSection(section) => {
                anyhow::ensure!(
                    section.count() <= 4096,
                    "WASM element segments exceed compilation limit"
                );
            }
            Payload::FunctionSection(section) => {
                anyhow::ensure!(
                    section.count() <= 4096,
                    "WASM function count exceeds compilation limit"
                );
            }
            Payload::TypeSection(section) => {
                anyhow::ensure!(
                    section.count() <= 4096,
                    "WASM type count exceeds compilation limit"
                );
                // The section counts groups, which may contain many types.
                for group in section {
                    let group = group?;
                    types += group.types().len();
                    anyhow::ensure!(
                        types <= 4096,
                        "WASM expanded type count exceeds compilation limit"
                    );
                    for subtype in group.types() {
                        let elements = match &subtype.composite_type.inner {
                            wasmparser::CompositeInnerType::Func(function) => {
                                function.params().len() + function.results().len()
                            }
                            wasmparser::CompositeInnerType::Struct(structure) => {
                                structure.fields.len()
                            }
                            _ => 1,
                        };
                        type_elements += elements;
                        anyhow::ensure!(
                            elements <= 4096 && type_elements <= 65_536,
                            "WASM type shape exceeds compilation limit"
                        );
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                let size = body.range().len();
                total_code += size;
                anyhow::ensure!(
                    size <= 16 * 1024 && total_code <= 1024 * 1024,
                    "WASM code exceeds compilation limit"
                );
                let mut locals = 0u64;
                for local in body.get_locals_reader()? {
                    locals += u64::from(local?.0);
                    anyhow::ensure!(locals <= 4096, "WASM locals exceed compilation limit");
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SandboxCapabilities;

    /// Run this with `cargo test --features sandbox-wasmtime`
    ///
    /// Without the feature, the test verifies the graceful-degrade error path.
    #[test]
    fn exec_requires_wasm_in_stdin() {
        let sandbox = WasmtimeSandbox::new().expect("sandbox init");
        let spec = ExecSpec {
            env: Vec::new(),
            command: "noop".to_owned(),
            args: vec![],
            capabilities: SandboxCapabilities::default(),
            stdin: None, // no WASM bytes
            timeout_secs: None,
        };
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(sandbox.exec(spec));
        // Both with and without the feature this must be an error (missing bytes
        // or missing feature).
        assert!(result.is_err(), "exec without WASM bytes must fail");
    }

    #[cfg(feature = "sandbox-wasmtime")]
    #[test]
    fn wasi_guest_file_access_enforces_explicit_grants_and_workspace_clamps() {
        use crate::WorkspaceAccess;
        // Exercise the actual guest syscall and observe both its errno and the
        // host file, rather than inferring isolation from an empty mount list.
        fn guest(path: &str, write: bool) -> Vec<u8> {
            let action = if write {
                r#"(i32.store (i32.const 0) (i32.const 64))
                    (i32.store (i32.const 4) (i32.const 7))
                    (call $exit (call $write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 16)))"#
            } else {
                r#"(i32.store (i32.const 0) (i32.const 256))
                    (i32.store (i32.const 4) (i32.const 128))
                    (local.set $error (call $read (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 16)))
                    (if (local.get $error) (then (call $exit (local.get $error))))
                    (i32.store (i32.const 4) (i32.load (i32.const 16)))
                    (call $exit (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16)))"#
            };
            wat::parse_str(format!(r#"(module
                (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
                (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
                (memory (export "memory") 1)
                (data (i32.const 32) "{path}")
                (data (i32.const 64) "updated")
                (func (export "_start") (local $fd i32) (local $error i32)
                    (local.set $error (call $open (i32.const 3) (i32.const 0) (i32.const 32)
                        (i32.const {length}) (i32.const 0) (i64.const {rights}) (i64.const 0) (i32.const 0) (i32.const 96)))
                    (if (local.get $error) (then (call $exit (local.get $error))))
                    (local.set $fd (i32.load (i32.const 96)))
                    {action}))"#, length=path.len(), rights=if write {64} else {2})).unwrap()
        }
        let root = tempfile::tempdir().unwrap();
        let granted = root.path().join("granted");
        std::fs::create_dir(&granted).unwrap();
        let file = granted.join("allowed.txt");
        std::fs::write(&file, b"before!").unwrap();
        std::fs::write(root.path().join("outside.txt"), b"private").unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let sandbox = WasmtimeSandbox::new().unwrap();
        let execute = |path: &str, write: bool, capabilities| {
            runtime
                .block_on(sandbox.exec(ExecSpec {
                    env: Vec::new(),
                    command: "file-permissions-proof".into(),
                    args: vec![],
                    capabilities,
                    stdin: Some(guest(path, write)),
                    timeout_secs: Some(5),
                }))
                .expect("actual WASI guest must execute and return its syscall result")
        };
        let denied = execute("allowed.txt", false, SandboxCapabilities::default());
        assert_ne!(denied.exit_code, 0, "no preopen must deny actual path_open");
        assert!(denied.stdout.is_empty());
        let mut read = SandboxCapabilities::default();
        read.fs_read_paths.insert(granted.clone());
        let allowed = execute("allowed.txt", false, read.clone());
        assert_eq!(allowed.exit_code, 0);
        assert_eq!(allowed.stdout, b"before!");
        let denied = execute("allowed.txt", true, read.clone());
        assert_ne!(
            denied.exit_code, 0,
            "read-only grant must reject actual write rights"
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"before!");
        let escape = execute("../outside.txt", false, read);
        assert_ne!(
            escape.exit_code, 0,
            "a preopen must not expose its parent directory"
        );
        assert!(escape.stdout.is_empty());
        let mut write = SandboxCapabilities::default();
        write.fs_write_paths.insert(granted);
        for clamp in [WorkspaceAccess::ReadOnly, WorkspaceAccess::None] {
            write.workspace_access = clamp;
            let denied = execute("allowed.txt", true, write.clone());
            assert_ne!(
                denied.exit_code, 0,
                "workspace clamp {clamp:?} must override an explicit write path"
            );
            assert_eq!(std::fs::read(&file).unwrap(), b"before!");
        }
        write.workspace_access = WorkspaceAccess::ReadWrite;
        let allowed = execute("allowed.txt", true, write);
        assert_eq!(
            allowed.exit_code, 0,
            "explicit write grant must permit actual guest mutation"
        );
        assert_eq!(std::fs::read(file).unwrap(), b"updated");
    }

    #[cfg(feature = "sandbox-wasmtime")]
    #[test]
    fn compiler_rejects_compressed_resource_bombs_before_jit() {
        for source in [
            format!("(module (func {}))", "nop ".repeat(20_000)),
            format!("(module (func (local {})))", "i32 ".repeat(100_000)),
            format!("(module {})", "(func) ".repeat(4097)),
            format!("(module {})", "(import \"m\" \"f\" (func)) ".repeat(4097)),
            format!("(module (rec {}))", "(type (struct)) ".repeat(4097)),
            format!("(module (type (func (param {}))))", "i32 ".repeat(100_000)),
        ] {
            let bytes = wat::parse_str(source).unwrap();
            assert!(bytes.len() < 4 * 1024 * 1024);
            assert!(validate_compilation_shape(&bytes).is_err());
        }
        let bytes = wat::parse_str("(module (memory 1) (func (export \"_start\")))").unwrap();
        validate_compilation_shape(&bytes).unwrap();
    }

    #[cfg(feature = "sandbox-wasmtime")]
    #[test]
    fn guest_memory_and_table_allocations_are_bounded() {
        let sandbox = WasmtimeSandbox::new().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for source in [
            r#"(module (memory 1025) (func (export "_start")))"#,
            r#"(module (table 100001 funcref) (func (export "_start")))"#,
        ] {
            let spec = ExecSpec {
                env: Vec::new(),
                command: "probe".into(),
                args: vec![],
                capabilities: SandboxCapabilities::default(),
                stdin: Some(wat::parse_str(source).unwrap()),
                timeout_secs: Some(1),
            };
            assert!(exec_wasm(&sandbox.engine, spec)
                .map(|output| output.exit_code != 0)
                .unwrap_or(true));
        }
        let spec = ExecSpec {
            env: Vec::new(),
            command: "probe".into(),
            args: vec![],
            capabilities: SandboxCapabilities::default(),
            stdin: Some(vec![0; 4 * 1024 * 1024 + 1]),
            timeout_secs: Some(1),
        };
        assert!(runtime
            .block_on(sandbox.exec(spec))
            .unwrap_err()
            .to_string()
            .contains("compilation input limit"));
    }

    #[test]
    fn execution_timeout_interrupts_non_yielding_guest() {
        #[cfg(feature = "sandbox-wasmtime")]
        {
            let sandbox = WasmtimeSandbox::new().expect("sandbox init");
            let wasm_bytes = wat::parse_str(
                r#"
                (module
                  (func (export "_start")
                    (loop br 0)))
                "#,
            )
            .expect("WAT parse");
            let spec = ExecSpec {
                env: Vec::new(),
                command: "timeout-probe".to_owned(),
                args: Vec::new(),
                capabilities: SandboxCapabilities::default(),
                stdin: Some(wasm_bytes),
                timeout_secs: Some(1),
            };
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            let started = Instant::now();
            let error = rt
                .block_on(sandbox.exec(spec))
                .expect_err("non-yielding guest must time out");
            assert!(error.to_string().contains("timed out"));
            assert!(started.elapsed() < Duration::from_secs(3));
        }
    }

    #[cfg(feature = "sandbox-wasmtime")]
    #[test]
    fn guest_memory_growth_stops_at_store_limit() {
        let sandbox = WasmtimeSandbox::new().expect("sandbox init");
        let wasm_bytes = wat::parse_str(
            r#"
            (module
              (memory 1)
              (func (export "_start")
                i32.const 1024
                memory.grow
                i32.const -1
                i32.ne
                if unreachable end))
            "#,
        )
        .expect("WAT parse");
        let spec = ExecSpec {
            env: Vec::new(),
            command: "memory-limit-probe".to_owned(),
            args: Vec::new(),
            capabilities: SandboxCapabilities::default(),
            stdin: Some(wasm_bytes),
            timeout_secs: Some(5),
        };
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let output = rt.block_on(sandbox.exec(spec)).expect("exec must complete");
        assert_eq!(output.exit_code, 0, "oversized memory.grow must be denied");
    }

    #[cfg(feature = "sandbox-wasmtime")]
    #[test]
    fn spec_env_is_the_guest_environment() {
        // The guest copies its whole WASI environment block (NUL-separated
        // `KEY=VALUE` strings) to stdout.
        let wasm_bytes = wat::parse_str(
            r#"
            (module
              (import "wasi_snapshot_preview1" "environ_sizes_get"
                (func $sizes (param i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "environ_get"
                (func $get (param i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "fd_write"
                (func $write (param i32 i32 i32 i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                (drop (call $sizes (i32.const 0) (i32.const 4)))
                (drop (call $get (i32.const 64) (i32.const 1024)))
                (i32.store (i32.const 16) (i32.const 1024))
                (i32.store (i32.const 20) (i32.load (i32.const 4)))
                (drop (call $write (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 24)))))
            "#,
        )
        .expect("WAT parse");
        let run = |env: Vec<(String, String)>| {
            let sandbox = WasmtimeSandbox::new().expect("sandbox init");
            let spec = ExecSpec {
                env,
                command: "env-probe".to_owned(),
                args: Vec::new(),
                capabilities: SandboxCapabilities::default(),
                stdin: Some(wasm_bytes.clone()),
                timeout_secs: Some(5),
            };
            let output = exec_wasm(&sandbox.engine, spec).expect("exec must complete");
            assert_eq!(output.exit_code, 0);
            output.stdout
        };

        let stdout = run(vec![("GREETING".to_owned(), "hi".to_owned())]);
        assert_eq!(stdout, b"GREETING=hi\0");
        assert!(
            run(Vec::new()).is_empty(),
            "host env must not leak into the guest"
        );
    }
}
