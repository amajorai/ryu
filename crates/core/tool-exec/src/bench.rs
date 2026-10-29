//! Sandbox benchmark (ignored by default). It runs the same programs through the
//! public entry point, `run_sandboxed`, with a mock tool invoker that answers
//! every call with `{ "ok": true }`, and checks each result, so a broken run
//! fails the benchmark instead of looking fast.
//!
//! ```sh
//! cargo test -p ryu-tool-exec --release bench_js_sandbox -- --ignored --nocapture
//! ```
//!
//! Run it twice: the first process compiles the guest and caches it in
//! `ryu-tool-exec-bench` under `std::env::temp_dir()`, the second loads it. A
//! `.cwasm` left there by another guest or Wasmtime build makes the first run
//! report `cache_hit` while it recompiles, so delete that directory after
//! changing either. Each process prints `BENCH {json}` lines: one per latency
//! workload, and one each for the first program, throughput and (on Unix)
//! memory. These are the workloads and sample counts behind the engine
//! comparison on the programmatic tool calling docs page.

use super::*;
use serde_json::json;
use std::time::{Duration, Instant};

fn invoker() -> Arc<SandboxToolInvoker> {
    Arc::new(SandboxToolInvoker::mock(Box::new(|_| {
        InvokeOutcome::Result(ToolInvokeResult {
            value: json!({ "ok": true }),
            is_error: false,
            error: None,
        })
    })))
}

struct Workload {
    name: &'static str,
    program: &'static str,
    expect: i64,
    runs: usize,
}

const WORKLOADS: &[Workload] = &[
    Workload {
        name: "noop",
        program: "return 1;",
        expect: 1,
        runs: 40,
    },
    Workload {
        name: "fib25",
        program: "function fib(n){ return n < 2 ? n : fib(n - 1) + fib(n - 2); } return fib(25);",
        expect: 75025,
        runs: 15,
    },
    Workload {
        name: "json20k",
        program: "const items = []; for (let i = 0; i < 20000; i++) items.push({ id: i, name: 'item-' + i, tags: ['a', 'b'] }); return JSON.parse(JSON.stringify(items)).length;",
        expect: 20000,
        runs: 15,
    },
    Workload {
        name: "string_regex20k",
        program: "let s = ''; for (let i = 0; i < 20000; i++) s += 'word' + i + ' '; return s.replace(/word(\\d+)/g, (_, d) => d).split(' ').filter(Boolean).length;",
        expect: 20000,
        runs: 15,
    },
    Workload {
        name: "tools_seq20",
        program: "let n = 0; for (let i = 0; i < 20; i++) { const r = await tools.fixture.echo({ i }); if (r && r.ok) n++; } return n;",
        expect: 20,
        runs: 20,
    },
    Workload {
        name: "tools_par20",
        program: "const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => tools.fixture.echo({ i }))); return rs.filter((r) => r && r.ok).length;",
        expect: 20,
        runs: 20,
    },
];

/// Run `program` once and return its wall-clock time; panics unless it
/// completed with `expect`.
async fn timed_run(program: &str, expect: i64) -> Duration {
    let started = Instant::now();
    let outcome = run_sandboxed(program.to_owned(), invoker(), "bench-agent").await;
    let elapsed = started.elapsed();
    match outcome {
        ExecOutcome::Completed {
            is_error: false,
            result: Some(value),
            ..
        } => assert_eq!(value.as_i64(), Some(expect), "`{program}` returned {value}"),
        other => panic!("`{program}` failed: {other:?}"),
    }
    elapsed
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn summary(mut samples: Vec<Duration>) -> serde_json::Value {
    samples.sort();
    let pick = |q: f64| ms(samples[((samples.len() as f64 - 1.0) * q).round() as usize]);
    let mean = samples.iter().map(|d| ms(*d)).sum::<f64>() / samples.len() as f64;
    json!({
        "n": samples.len(),
        "min_ms": pick(0.0),
        "p50_ms": pick(0.5),
        "p95_ms": pick(0.95),
        "max_ms": pick(1.0),
        "mean_ms": mean,
    })
}

/// Peak resident set size of this process, in KiB. Linux reports
/// `ru_maxrss` in KiB; macOS reports bytes, so it is converted there.
#[cfg(unix)]
fn peak_rss_kb() -> i64 {
    // SAFETY: getrusage only writes into the zeroed struct passed to it.
    let max_rss = unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        usage.ru_maxrss
    };
    if cfg!(target_vendor = "apple") {
        max_rss / 1024
    } else {
        max_rss
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark; run explicitly with --release --ignored --nocapture"]
async fn bench_js_sandbox() {
    #[cfg(unix)]
    let rss_before = peak_rss_kb();

    // First program: start the warm-up the way Core does at boot, then issue
    // a program immediately, so it waits on whatever warm-up still has to do
    // (compile on an empty cache, load on a populated one).
    let cache_dir = std::env::temp_dir().join("ryu-tool-exec-bench");
    let cached = std::fs::read_dir(&cache_dir).is_ok_and(|mut entries| {
        entries.any(|entry| {
            entry.is_ok_and(|entry| entry.file_name().to_string_lossy().ends_with(".cwasm"))
        })
    });
    crate::warm_up(Some(cache_dir));
    let first = timed_run("return 1;", 1).await;
    println!(
        "BENCH {}",
        json!({
            "metric": "cold_first_run",
            "cache": if cached { "cache_hit" } else { "cache_empty" },
            "ms": ms(first),
        })
    );

    // Latency: three unrecorded runs, then the recorded samples.
    for workload in WORKLOADS {
        for _ in 0..3 {
            timed_run(workload.program, workload.expect).await;
        }
        let mut samples = Vec::with_capacity(workload.runs);
        for _ in 0..workload.runs {
            samples.push(timed_run(workload.program, workload.expect).await);
        }
        println!(
            "BENCH {}",
            json!({ "metric": "latency", "workload": workload.name, "stats": summary(samples) })
        );
    }

    // Throughput: 64 empty programs, 8 in flight at once.
    let total = 64usize;
    let concurrency = 8usize;
    let started = Instant::now();
    let mut set = tokio::task::JoinSet::new();
    let mut launched = 0usize;
    let mut done = 0usize;
    while done < total {
        while launched < total && set.len() < concurrency {
            set.spawn(async { timed_run("return 1;", 1).await });
            launched += 1;
        }
        set.join_next().await.expect("task").expect("join");
        done += 1;
    }
    let wall = started.elapsed();
    println!(
        "BENCH {}",
        json!({
            "metric": "throughput_noop",
            "runs": total,
            "concurrency": concurrency,
            "wall_ms": ms(wall),
            "runs_per_sec": total as f64 / wall.as_secs_f64(),
        })
    );

    #[cfg(unix)]
    println!(
        "BENCH {}",
        json!({
            "metric": "memory",
            "peak_rss_kb_before": rss_before,
            "peak_rss_kb_after": peak_rss_kb(),
        })
    );
}
