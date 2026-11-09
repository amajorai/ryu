//! Tracking and killing each ACP instance's whole process tree, including trees
//! orphaned by a previous Core.

use std::sync::OnceLock;
use std::time::Duration;

use sysinfo::System;
/// Environment variable stamped on every ACP subprocess. Descendants inherit it,
/// which is how Core finds the whole tree again: the ACP crate's drop guard only
/// kills the direct child, and on Windows that child is `cmd.exe`, whose `npx`,
/// agent bridge and CLI grandchildren survive a `TerminateProcess` of it.
pub const ACP_INSTANCE_ENV: &str = "RYU_ACP_INSTANCE_ID";
/// Identifies the Core process that owns a marked tree, as `<pid>:<start_time>`,
/// so a later Core can tell its predecessor's orphans from a sibling profile's
/// live agents.
pub const ACP_OWNER_ENV: &str = "RYU_ACP_OWNER";

fn core_owner_token() -> &'static str {
    static OWNER: OnceLock<String> = OnceLock::new();
    OWNER.get_or_init(|| {
        let pid = sysinfo::get_current_pid().ok();
        let start_time = pid
            .and_then(|pid| {
                let mut system = System::new();
                system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
                system.process(pid).map(sysinfo::Process::start_time)
            })
            .unwrap_or(0);
        format!(
            "{}:{start_time}",
            pid.map(|pid| pid.as_u32()).unwrap_or(std::process::id())
        )
    })
}

/// Owns one ACP instance's process tree. Dropping it (instance exit, idle reap,
/// eviction, crash, or task cancellation) kills every process still carrying the
/// instance marker, off the async runtime.
pub struct AcpProcessTree {
    marker: String,
}

impl AcpProcessTree {
    pub fn new() -> Self {
        Self {
            marker: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// Variables to add to the ACP subprocess environment.
    pub fn environment(&self) -> [(String, String); 2] {
        [
            (ACP_INSTANCE_ENV.to_owned(), self.marker.clone()),
            (ACP_OWNER_ENV.to_owned(), core_owner_token().to_owned()),
        ]
    }
}

impl Drop for AcpProcessTree {
    fn drop(&mut self) {
        let marker = std::mem::take(&mut self.marker);
        let spawned = std::thread::Builder::new()
            .name("acp-tree-reap".to_owned())
            .spawn(move || {
                // Two passes: a grandchild can still be starting when the first
                // snapshot is taken, and a bridge may take a moment to notice EOF.
                let mut killed = 0;
                for delay in [Duration::from_millis(250), Duration::from_secs(2)] {
                    std::thread::sleep(delay);
                    killed += kill_marked_processes(|value| value == marker);
                }
                if killed > 0 {
                    tracing::info!(killed, "reaped ACP subprocess tree");
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "could not start ACP process-tree reaper");
        }
    }
}

pub(super) fn marker_value<'a>(environ: &'a [std::ffi::OsString], name: &str) -> Option<&'a str> {
    environ.iter().find_map(|entry| {
        let entry = entry.to_str()?;
        let (key, value) = entry.split_once('=')?;
        key.eq_ignore_ascii_case(name).then_some(value)
    })
}

/// Kill every process (except Core itself) whose [`ACP_INSTANCE_ENV`] value
/// satisfies `matches`, plus their later-started descendants in case an agent
/// spawned a child with a scrubbed environment. Returns how many were killed.
pub(super) fn kill_marked_processes(matches: impl Fn(&str) -> bool) -> usize {
    kill_processes_where(|environ| marker_value(environ, ACP_INSTANCE_ENV).is_some_and(&matches))
}

fn kill_processes_where(select: impl Fn(&[std::ffi::OsString]) -> bool) -> usize {
    use std::collections::{HashMap, HashSet};
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};

    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_environ(UpdateKind::Always),
    );
    let own = sysinfo::get_current_pid().ok();
    let mut selected: HashSet<Pid> = system
        .processes()
        .iter()
        .filter(|(pid, process)| Some(**pid) != own && select(process.environ()))
        .map(|(pid, _)| *pid)
        .collect();

    // Windows keeps a dead parent's pid in `parent()`, and pids are reused, so
    // only follow an edge when the child started no earlier than its parent.
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    let mut stack: Vec<Pid> = selected.iter().copied().collect();
    while let Some(parent) = stack.pop() {
        let parent_start = system
            .process(parent)
            .map_or(0, sysinfo::Process::start_time);
        for child in children.get(&parent).into_iter().flatten() {
            let started_after = system
                .process(*child)
                .is_some_and(|process| process.start_time() >= parent_start);
            if Some(*child) != own && started_after && selected.insert(*child) {
                stack.push(*child);
            }
        }
    }

    selected
        .iter()
        .filter(|pid| system.process(**pid).is_some_and(sysinfo::Process::kill))
        .count()
}

/// Kill ACP trees left behind by a previous Core that crashed or was killed
/// before its reapers ran. A tree is an orphan when its owner token names a Core
/// that is no longer running; a live sibling Core (another profile) keeps its own.
pub fn reap_orphaned_trees() {
    let spawned = std::thread::Builder::new()
        .name("acp-orphan-reap".to_owned())
        .spawn(|| {
            let mut system = System::new();
            system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let owner_alive = |token: &str| {
                let Some((pid, start)) = token.split_once(':') else {
                    return false;
                };
                let (Ok(pid), Ok(start)) = (pid.parse::<u32>(), start.parse::<u64>()) else {
                    return false;
                };
                system
                    .process(sysinfo::Pid::from_u32(pid))
                    .is_some_and(|process| process.start_time() == start)
            };
            let killed = kill_processes_where(|environ| {
                marker_value(environ, ACP_INSTANCE_ENV).is_some()
                    && !marker_value(environ, ACP_OWNER_ENV).is_some_and(owner_alive)
            });
            if killed > 0 {
                tracing::info!(
                    killed,
                    "reaped orphaned ACP subprocesses from a previous Core"
                );
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "could not start orphaned ACP reaper");
    }
}
