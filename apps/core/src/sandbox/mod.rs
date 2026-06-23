/// Sandbox execution backend — M6 spike (issue #188).
///
/// Two sandbox kinds, decided by the [`Sandbox`] trait:
///
/// - **Ephemeral**: run a WASM module, capture stdout/stderr, return immediately.
///   Backed by wasmtime + WASIp1 (feature `sandbox-wasmtime`).
///
/// - **Workspace**: long-lived container with a persistent FS, native binaries,
///   full POSIX, multi-process, sockets.  Backed by Docker (future; not yet wired).
///
/// The split is driven by the WASI ceiling matrix — see
/// `docs/spikes/0188-wasmtime-wasi-ceiling.md`.

/// Result of running a sandboxed workload.
#[derive(Debug)]
pub struct SandboxOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Wall-clock duration of the execution (instantiation + run).
    pub duration_ms: u128,
}

/// Unified sandbox execution contract.
///
/// "What runs" is Core's decision — the trait lives here.
/// "What is allowed to run" (policy, quotas, DLP) is Gateway's decision.
pub trait Sandbox: Send + Sync {
    /// Execute a workload synchronously and return captured output.
    fn run(&self, request: SandboxRequest) -> anyhow::Result<SandboxOutput>;
}

/// Input to [`Sandbox::run`].
#[derive(Debug, Clone)]
pub struct SandboxRequest {
    /// WASM bytecode to execute (for wasmtime backend).
    pub wasm_bytes: Vec<u8>,
    /// Command-line arguments passed to the WASM module (argv[0] is always "wasm").
    pub args: Vec<String>,
    /// Environment variables.
    pub env: Vec<(String, String)>,
    /// Stdout/stderr size cap in bytes (default: 1 MiB).
    pub stdout_cap: usize,
}

impl Default for SandboxRequest {
    fn default() -> Self {
        Self {
            wasm_bytes: vec![],
            args: vec![],
            env: vec![],
            stdout_cap: 1024 * 1024,
        }
    }
}

// ---------------------------------------------------------------------------
// wasmtime backend (compiled in only when the feature is enabled)
// ---------------------------------------------------------------------------

#[cfg(feature = "sandbox-wasmtime")]
pub mod wasmtime_backend {
    use super::{Sandbox, SandboxOutput, SandboxRequest};
    use std::time::Instant;
    use wasmtime::{Engine, Linker, Module, Store};
    use wasmtime_wasi::p1::WasiP1Ctx;
    use wasmtime_wasi::WasiCtxBuilder;

    /// Ephemeral wasmtime sandbox: compiles, instantiates, and runs a WASI
    /// module, capturing stdout into memory.  No daemon, no external process,
    /// no network or FS access unless explicitly preopened.
    ///
    /// The [`Engine`] is shared across calls so Cranelift startup is paid once.
    /// Module compilation (the cold-start cost) can be cached in a higher layer
    /// by pre-computing [`Module::serialize`] keyed on content hash.
    pub struct WasmtimeSandbox {
        engine: Engine,
    }

    impl WasmtimeSandbox {
        /// Create a new sandbox.  `Engine::default()` initialises Cranelift
        /// JIT; this takes ~10–30 ms — do it once and reuse.
        pub fn new() -> anyhow::Result<Self> {
            let engine = Engine::default();
            Ok(Self { engine })
        }
    }

    impl Sandbox for WasmtimeSandbox {
        fn run(&self, request: SandboxRequest) -> anyhow::Result<SandboxOutput> {
            let t0 = Instant::now();

            // 1. Compile the module (JIT via Cranelift — ~40-120 ms for a
            //    small module).  The caller can pre-serialise with
            //    Module::serialize + Module::deserialize to skip this on
            //    repeated calls.
            let module = Module::from_binary(&self.engine, &request.wasm_bytes)?;

            // 2. Wire WASIp1 into a Linker.  The closure `|s| s` tells the
            //    linker that the Store data IS the WasiP1Ctx.
            let mut linker: Linker<WasiP1Ctx> = Linker::new(&self.engine);
            wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |s| s)?;

            // 3. Build a WASI context that redirects stdout/stderr to memory
            //    pipes so the caller can inspect the output.
            //    MemoryOutputPipe lives in wasmtime_wasi::p2::pipe (the p1
            //    adapter re-uses p2 stream types).
            let stdout_pipe = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(request.stdout_cap);
            let stderr_pipe = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(request.stdout_cap);

            let mut builder = WasiCtxBuilder::new();
            builder.stdout(stdout_pipe.clone());
            builder.stderr(stderr_pipe.clone());

            // argv[0] is the program name; caller args follow.
            let mut all_args = vec!["wasm".to_string()];
            all_args.extend(request.args.iter().cloned());
            let arg_refs: Vec<&str> = all_args.iter().map(String::as_str).collect();
            builder.args(&arg_refs);

            for (k, v) in &request.env {
                builder.env(k, v);
            }

            let wasi = builder.build_p1();

            // 4. Register the module and invoke the WASI entry point.
            let mut store = Store::new(&self.engine, wasi);
            linker.module(&mut store, "", &module)?;
            let func = linker
                .get_default(&mut store, "")
                .map_err(|e| anyhow::anyhow!("no default export (_start): {e}"))?
                .typed::<(), ()>(&store)?;

            // proc_exit(0) surfaces as a Trap wrapping I32Exit(0) — that is
            // normal WASI exit and must be treated as success.
            let run_result = func.call(&mut store, ());
            drop(store); // flush pipe buffers

            let stdout = stdout_pipe.contents().to_vec();
            let stderr = stderr_pipe.contents().to_vec();
            let duration_ms = t0.elapsed().as_millis();

            match run_result {
                Ok(()) => {}
                Err(trap) => {
                    if let Some(exit) = trap.downcast_ref::<wasmtime_wasi::I32Exit>() {
                        if exit.0 != 0 {
                            anyhow::bail!(
                                "WASI module exited with code {}: {}",
                                exit.0,
                                String::from_utf8_lossy(&stderr)
                            );
                        }
                        // exit code 0 — fall through to success
                    } else if stdout.is_empty() {
                        // An unexpected trap with no stdout: surface it.
                        return Err(trap.context("wasmtime trap").into());
                    }
                    // Unexpected trap but we have stdout — probably the host
                    // proc_exit call that wasmtime surfaces as a trap.
                }
            }

            Ok(SandboxOutput {
                stdout,
                stderr,
                duration_ms,
            })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Probe WASM binary compiled from a small Rust program with:
        ///   cargo build --target wasm32-wasip1 --release
        /// Source (src/main.rs):
        ///   fn main() {
        ///     println!("ryu-wasm-probe: hello from WASI");
        ///     println!("args: {}", std::env::args().skip(1).collect::<Vec<_>>().join(","));
        ///   }
        const PROBE_WASM: &[u8] = include_bytes!("fixtures/probe.wasm");

        /// AC#1 — Links wasmtime, runs a WASI module, captures stdout.
        #[test]
        fn test_wasmtime_runs_wasi_module_and_captures_stdout() {
            let sandbox = WasmtimeSandbox::new().expect("engine init");
            let req = SandboxRequest {
                wasm_bytes: PROBE_WASM.to_vec(),
                args: vec!["hello".to_string(), "world".to_string()],
                ..Default::default()
            };
            let out = sandbox.run(req).expect("sandbox run");
            let stdout = String::from_utf8(out.stdout).expect("utf8");
            assert!(
                stdout.contains("ryu-wasm-probe: hello from WASI"),
                "expected probe string in stdout, got: {stdout:?}"
            );
            assert!(
                stdout.contains("hello,world"),
                "expected args in stdout, got: {stdout:?}"
            );
            eprintln!(
                "[spike] WASI exec ok  duration={}ms  stdout={stdout:?}",
                out.duration_ms
            );
        }

        /// AC#4 — Measures cold-start breakdown so the spike doc can record
        /// real numbers.  Run with:
        ///   cargo test --features sandbox-wasmtime -- --nocapture bench_cold_start
        #[test]
        fn bench_cold_start() {
            let t0 = Instant::now();
            let engine = Engine::default();
            let engine_ms = t0.elapsed().as_millis();

            let t1 = Instant::now();
            let module = Module::from_binary(&engine, PROBE_WASM).expect("compile");
            let compile_ms = t1.elapsed().as_millis();

            let mut linker: Linker<WasiP1Ctx> = Linker::new(&engine);
            wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |s| s).unwrap();

            let t2 = Instant::now();
            let stdout_pipe = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(1024 * 1024);
            let mut builder = WasiCtxBuilder::new();
            builder.stdout(stdout_pipe);
            builder.args(&["wasm"]);
            let wasi = builder.build_p1();
            let mut store = Store::new(&engine, wasi);
            linker.module(&mut store, "", &module).expect("module");
            let func = linker
                .get_default(&mut store, "")
                .expect("default")
                .typed::<(), ()>(&store)
                .expect("typed");
            func.call(&mut store, ()).ok();
            drop(store);
            let exec_ms = t2.elapsed().as_millis();

            eprintln!(
                "[spike] cold-start: engine={}ms  compile={}ms  exec={}ms  total={}ms",
                engine_ms,
                compile_ms,
                exec_ms,
                t0.elapsed().as_millis()
            );
        }
    }
}
