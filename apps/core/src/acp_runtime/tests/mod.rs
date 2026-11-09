use super::{
    calculate_auto_max_parallel_agents, cgroup_memory_from, effective_memory, sanitize_config,
};
use serde_json::json;

mod admission;

#[test]
fn automatic_limit_is_cpu_and_memory_bounded() {
    const GIB: u64 = 1024 * 1024 * 1024;
    // A nominal 4 GiB VM reports about 3.8 GiB.
    assert_eq!(calculate_auto_max_parallel_agents(2, 1, GIB * 38 / 10), 14);
    assert_eq!(calculate_auto_max_parallel_agents(2, 1, 4 * GIB), 16);
    assert_eq!(calculate_auto_max_parallel_agents(8, 4, 16 * GIB), 32);
    // CPU-bound: plenty of memory, one core.
    assert_eq!(calculate_auto_max_parallel_agents(1, 1, 32 * GIB), 8);
    // Everything reserved still admits one agent.
    assert_eq!(calculate_auto_max_parallel_agents(1, 1, GIB), 1);
    assert_eq!(calculate_auto_max_parallel_agents(1, 1, 0), 1);
    // Logical cores missing falls back to physical ones.
    assert_eq!(calculate_auto_max_parallel_agents(0, 1, 32 * GIB), 8);
}

#[test]
fn malformed_runtime_values_fail_safe_to_defaults_or_bounds() {
    let config = sanitize_config(&json!({
        "idle_timeout_minutes": 0,
        "max_parallel_agents": 500,
        "keep_computer_awake": false
    }));
    assert_eq!(config.idle_timeout_minutes, 1);
    assert_eq!(config.max_parallel_agents, None);
    assert!(!config.keep_computer_awake);
}

fn marked_pids(marker: &str) -> Vec<sysinfo::Pid> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_environ(UpdateKind::Always),
    );
    system
        .processes()
        .iter()
        .filter(|(_, process)| {
            super::marker_value(process.environ(), super::ACP_INSTANCE_ENV) == Some(marker)
        })
        .map(|(pid, _)| *pid)
        .collect()
}

/// Mirrors the ACP spawn shape: a shell wrapper whose grandchild survives a
/// kill of the direct child. The marker sweep must take the grandchild too.
#[test]
fn marker_sweep_kills_grandchildren_that_outlive_the_direct_child() {
    let marker = uuid::Uuid::new_v4().to_string();
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.args(["/d", "/s", "/c", "ping -n 60 127.0.0.1 >nul"]);
        command
    } else {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 60; true"]);
        command
    };
    let mut child = command
        .env(super::ACP_INSTANCE_ENV, &marker)
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("spawn wrapper");
    assert!(
        wait_for_marked_pids(&marker, |count| count >= 2),
        "wrapper and grandchild both carry the marker"
    );

    // What the ACP crate's drop guard does: kill only the direct child.
    // `wait` reaps it, so anything still marked is the orphaned grandchild.
    child.kill().expect("kill direct child");
    let _ = child.wait();
    assert!(
        !marked_pids(&marker).is_empty(),
        "grandchild outlives its killed parent"
    );

    let killed = super::kill_marked_processes(|value| value == marker);
    assert!(killed >= 1);
    assert!(
        wait_for_marked_pids(&marker, |count| count == 0),
        "tree fully reaped"
    );
}

/// Polls [`marked_pids`] until `done` accepts the count or a generous
/// deadline passes, so process start-up and reaping are not timed by fixed
/// sleeps on a loaded machine.
fn wait_for_marked_pids(marker: &str, done: impl Fn(usize) -> bool) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if done(marked_pids(marker).len()) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn a_cgroup_limit_below_host_ram_bounds_total_and_available_memory() {
    const GIB: u64 = 1024 * 1024 * 1024;
    // No cgroup, or one without a real limit: the host's numbers.
    assert_eq!(
        effective_memory(16 * GIB, 12 * GIB, None),
        (16 * GIB, 12 * GIB)
    );
    assert_eq!(
        effective_memory(16 * GIB, 12 * GIB, Some((u64::MAX / 2, GIB))),
        (16 * GIB, 12 * GIB)
    );
    // A 4 GiB container with 1 GiB in use.
    assert_eq!(
        effective_memory(16 * GIB, 12 * GIB, Some((4 * GIB, 3 * GIB))),
        (4 * GIB, 3 * GIB)
    );
    // The host can still be the tighter of the two for availability.
    assert_eq!(
        effective_memory(16 * GIB, 2 * GIB, Some((4 * GIB, 3 * GIB))),
        (4 * GIB, 2 * GIB)
    );
    // On a 64 GiB host with 4 vCPUs, the container limit sizes the cap.
    let (total, _) = effective_memory(64 * GIB, 60 * GIB, Some((4 * GIB, 4 * GIB)));
    assert_eq!(calculate_auto_max_parallel_agents(4, 2, total), 16);
}

#[test]
fn cgroup_memory_reads_the_tightest_limit_and_least_headroom_on_the_path() {
    use std::collections::HashMap;
    use std::path::Path;
    const GIB: u64 = 1024 * 1024 * 1024;
    let files: HashMap<&str, String> = HashMap::from([
        (
            "/sys/fs/cgroup/memory/memory.limit_in_bytes",
            "9223372036854771712\n".to_owned(),
        ),
        (
            "/sys/fs/cgroup/memory/box/memory.limit_in_bytes",
            format!("{}\n", 4 * GIB),
        ),
        (
            "/sys/fs/cgroup/memory/box/memory.usage_in_bytes",
            format!("{}\n", GIB),
        ),
        (
            "/sys/fs/cgroup/memory/box/memory.stat",
            format!("total_cache 9\ntotal_inactive_file {}\n", GIB / 4),
        ),
        (
            "/sys/fs/cgroup/memory/box/agent/memory.limit_in_bytes",
            format!("{}\n", 8 * GIB),
        ),
    ]);
    let read = |path: &Path| {
        files
            .get(path.to_str()?.replace('\\', "/").as_str())
            .cloned()
    };
    assert_eq!(
        cgroup_memory_from("4:memory:/box/agent\n1:cpu:/\n", &read),
        Some((4 * GIB, 4 * GIB - (GIB - GIB / 4)))
    );

    // A roomier parent shared with siblings can leave less headroom than
    // Core's own, tighter cgroup.
    let files: HashMap<&str, String> = HashMap::from([
        ("/sys/fs/cgroup/slice/memory.max", format!("{}\n", 8 * GIB)),
        (
            "/sys/fs/cgroup/slice/memory.current",
            format!("{}\n", 8 * GIB - GIB / 2),
        ),
        (
            "/sys/fs/cgroup/slice/core/memory.max",
            format!("{}\n", 6 * GIB),
        ),
        (
            "/sys/fs/cgroup/slice/core/memory.current",
            format!("{}\n", GIB),
        ),
    ]);
    let read = |path: &Path| {
        files
            .get(path.to_str()?.replace('\\', "/").as_str())
            .cloned()
    };
    assert_eq!(
        cgroup_memory_from("0::/slice/core\n", &read),
        Some((6 * GIB, GIB / 2))
    );

    // cgroup v2: `max` means no limit; a missing leaf directory is skipped.
    let files: HashMap<&str, String> = HashMap::from([
        ("/sys/fs/cgroup/memory.max", format!("{}\n", 2 * GIB)),
        ("/sys/fs/cgroup/memory.current", format!("{}\n", GIB / 2)),
        (
            "/sys/fs/cgroup/memory.stat",
            "anon 1\ninactive_file 0\n".to_owned(),
        ),
        ("/sys/fs/cgroup/svc/memory.max", "max\n".to_owned()),
    ]);
    let read = |path: &Path| {
        files
            .get(path.to_str()?.replace('\\', "/").as_str())
            .cloned()
    };
    assert_eq!(
        cgroup_memory_from("0::/svc/missing\n", &read),
        Some((2 * GIB, 2 * GIB - GIB / 2))
    );
    assert_eq!(cgroup_memory_from("0::/\n", &|_: &Path| None), None);
}

#[test]
fn memory_pressure_uses_a_tenth_of_ram_with_a_floor_capped_at_a_quarter() {
    const GIB: u64 = 1024 * 1024 * 1024;
    assert!(super::under_memory_pressure(6 * GIB, 64 * GIB));
    assert!(!super::under_memory_pressure(7 * GIB, 64 * GIB));
    assert!(super::under_memory_pressure(3 * GIB, 32 * GIB));
    assert!(!super::under_memory_pressure(3 * GIB + GIB / 2, 32 * GIB));
    assert!(super::under_memory_pressure(GIB + GIB / 2, 8 * GIB));
    assert!(!super::under_memory_pressure(3 * GIB, 8 * GIB));
    // 4 GiB node: the floor is 1 GiB, not 2 GiB.
    assert!(!super::under_memory_pressure(GIB + GIB / 2, 4 * GIB));
    assert!(super::under_memory_pressure(GIB - 1, 4 * GIB));
    assert!(!super::under_memory_pressure(0, 0));
}

/// Admission is process-global; tests that fill it must not overlap.
pub(crate) static ADMISSION_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Set the `[acp]` section for an admission test holding [`ADMISSION_TEST_LOCK`].
pub(crate) fn apply_test_config(value: &serde_json::Value) {
    super::apply_config(value);
}
