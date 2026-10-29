//! Heartbeat tests. Shared helpers live here; the tests are grouped by topic.

use super::*;
use crate::spec::{GpuKind, OsKind};
use std::sync::{Arc, Mutex};

mod box_run_tests;
mod registry_tests;
mod tick_tests;

/// A metering cycle ([`snapshot_cycle`]) ticks every live run in the
/// process-global registry, not only the caller's, so a test that drives one
/// advances the `ticked_seconds` of runs other tests registered concurrently.
/// Tests that drive a cycle hold this exclusively; tests that assert a run's
/// accumulated `elapsed_seconds_total` hold it shared, from registering the
/// run until they have read its totals.
static METERING_CYCLE: std::sync::RwLock<()> = std::sync::RwLock::new(());

fn exclusive_metering_cycle() -> std::sync::RwLockWriteGuard<'static, ()> {
    METERING_CYCLE.write().unwrap_or_else(|e| e.into_inner())
}

fn shared_metering_cycle() -> std::sync::RwLockReadGuard<'static, ()> {
    METERING_CYCLE.read().unwrap_or_else(|e| e.into_inner())
}

fn sample_spec() -> SandboxSpec {
    SandboxSpec {
        vcpu: 2,
        mem_gib: 4,
        storage_gib: 10,
        gpu: GpuKind::None,
        gpu_count: 0,
        os: OsKind::Linux,
    }
}

/// One-shot HTTP server answering `status` and `body`; returns the raw
/// request it saw.
fn one_shot_server(
    status: &'static str,
    body: &'static str,
) -> (String, std::thread::JoinHandle<String>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 8192];
        let count = stream.read(&mut bytes).unwrap();
        let request = String::from_utf8_lossy(&bytes[..count]).into_owned();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
        request
    });
    (format!("http://{address}/sandbox/quote"), server)
}

/// Build the tick job the ticker would send for a registered run.
fn job_for(run_id: &str, tick_index: u64) -> TickJob {
    let runs = lock_runs();
    let run = runs.get(run_id).expect("run registered");
    TickJob {
        run_id: run_id.to_owned(),
        generation: run.generation,
        org_id: run.org_id.clone(),
        spec: run.spec.clone(),
        backend: run.backend.clone(),
        workspace: run.workspace.clone(),
        per_run_budget_micro_usd: run.per_run_budget_micro_usd,
        elapsed_seconds_delta: 10,
        tick_index,
        kill_action: run.kill_action.clone(),
        size: run.size,
        box_id: run.box_id.clone(),
        elapsed_seconds_total: run.ticked_seconds.saturating_add(10),
        minimum_waiver: run.minimum_waiver.clone(),
    }
}

/// A park action that fails `failures` times, then succeeds, recording
/// every reason it was called with.
fn counting_park(failures: usize) -> (KillAction, Arc<Mutex<Vec<KillReason>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&calls);
    let action = KillAction::Park(Arc::new(move |reason| {
        let seen = Arc::clone(&seen);
        Box::pin(async move {
            let mut calls = seen.lock().unwrap();
            calls.push(reason);
            if calls.len() <= failures {
                anyhow::bail!("Box service unavailable");
            }
            Ok(())
        })
    }));
    (action, calls)
}

fn insert_box_run(run_id: &str, size: BoxSize, kill_action: KillAction) {
    insert_run(
        run_id.to_owned(),
        Some("org_box".to_owned()),
        "box".to_owned(),
        WorkspaceId("bx_0123456789abcdef0123456789abcdef".to_owned()),
        crate::box_types::spec_for(size),
        0,
        RunOptions {
            kill_action,
            size: Some(size),
            box_id: Some("bx_0123456789abcdef0123456789abcdef".to_owned()),
            minimum_waiver: None,
        },
    );
}

/// A Box run registered as a resume whose per-start minimum was waived.
fn insert_waived_box_run(run_id: &str, size: BoxSize) {
    insert_run(
        run_id.to_owned(),
        Some("org_box".to_owned()),
        "box".to_owned(),
        WorkspaceId("bx_0123456789abcdef0123456789abcdef".to_owned()),
        crate::box_types::spec_for(size),
        0,
        RunOptions {
            kill_action: KillAction::Destroy,
            size: Some(size),
            box_id: Some("bx_0123456789abcdef0123456789abcdef".to_owned()),
            minimum_waiver: Some(WAIVER.to_owned()),
        },
    );
}

/// A signed waiver as the Box service hands it to Core (Core forwards it
/// as is; the Gateway verifies it).
const WAIVER: &str = "bw1.eyJib3hJZCI6ImJ4In0.c2lnbmF0dXJl";
