//! Git capture — discovers git repositories under the user's working directories
//! and emits an event whenever a repo's HEAD commit or branch changes (commits,
//! checkouts, pulls, merges). Portable: shells out to the `git` CLI, no new crate.
//!
//! Repos are discovered by a shallow scan of the same roots the filesystem watcher
//! uses (plus `SHADOW_GIT_REPOS`), refreshed periodically so newly-cloned repos are
//! picked up.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_secs(30);
const RESCAN_EVERY: u32 = 20; // re-discover repos every ~10 min
const MAX_REPOS: usize = 64;
const SCAN_DEPTH: usize = 3;

fn scan_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(d) = dirs::document_dir() {
        roots.push(d);
    }
    if let Some(d) = dirs::desktop_dir() {
        roots.push(d);
    }
    if let Some(d) = dirs::download_dir() {
        roots.push(d);
    }
    if let Some(h) = dirs::home_dir() {
        for name in [
            "Code", "code", "src", "Projects", "projects", "dev", "repos",
        ] {
            let p = h.join(name);
            if p.is_dir() {
                roots.push(p);
            }
        }
    }
    roots
}

/// Recursively find `.git` repos under `dir` up to `depth`, appending repo roots
/// to `out`. Stops early once `MAX_REPOS` is reached.
fn find_repos(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_REPOS || depth == 0 {
        return;
    }
    if dir.join(".git").exists() {
        out.push(dir.to_path_buf());
        return; // don't descend into a repo's submodules/working tree
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
        }
        find_repos(&path, depth - 1, out);
        if out.len() >= MAX_REPOS {
            return;
        }
    }
}

fn discover_repos() -> Vec<PathBuf> {
    let mut repos = Vec::new();
    if let Ok(explicit) = std::env::var("SHADOW_GIT_REPOS") {
        for part in explicit.split([';', ',']) {
            let part = part.trim();
            if !part.is_empty() {
                repos.push(PathBuf::from(part));
            }
        }
    }
    for root in scan_roots() {
        find_repos(&root, SCAN_DEPTH, &mut repos);
    }
    repos.sort();
    repos.dedup();
    repos.truncate(MAX_REPOS);
    repos
}

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Returns `(commit_hash, branch, subject)` for the repo's current HEAD.
fn head_state(repo: &Path) -> Option<(String, String, String)> {
    let line = git(repo, &["log", "-1", "--format=%H%x1f%s"])?;
    let (hash, subject) = line.split_once('\u{1f}')?;
    let branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    Some((hash.to_string(), branch, subject.to_string()))
}

/// Start git monitoring on a dedicated thread.
pub fn start() {
    std::thread::Builder::new()
        .name("shadow-git".into())
        .spawn(move || {
            // Verify git exists before doing anything.
            if Command::new("git").arg("--version").output().is_err() {
                tracing::warn!("Git capture unavailable: `git` not found on PATH");
                return;
            }

            let mut last_commit: HashMap<PathBuf, String> = HashMap::new();
            let mut repos = discover_repos();
            tracing::info!("Git capture started ({} repos)", repos.len());
            // Seed current state so we don't emit the existing HEAD on first poll.
            for repo in &repos {
                if let Some((hash, _, _)) = head_state(repo) {
                    last_commit.insert(repo.clone(), hash);
                }
            }

            let mut ticks = 0u32;
            loop {
                std::thread::sleep(POLL_INTERVAL);
                ticks += 1;
                if ticks % RESCAN_EVERY == 0 {
                    repos = discover_repos();
                }
                if crate::server::is_capture_paused() {
                    continue;
                }
                for repo in &repos {
                    let Some((hash, branch, subject)) = head_state(repo) else {
                        continue;
                    };
                    let changed = last_commit.get(repo).map(|h| h != &hash).unwrap_or(true);
                    if !changed {
                        continue;
                    }
                    let first_seen = !last_commit.contains_key(repo);
                    last_commit.insert(repo.clone(), hash.clone());
                    if first_seen {
                        continue; // newly-discovered repo — record state, don't emit history
                    }
                    let name = repo
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("repo")
                        .to_string();
                    let text = format!("{name} [{branch}] {subject}");
                    super::emit(
                        super::TRACK_GIT,
                        "git_activity",
                        "Git",
                        &super::truncate(&text, 512),
                        vec![
                            ("repo", rmpv::Value::from(name)),
                            ("branch", rmpv::Value::from(branch)),
                            ("commit", rmpv::Value::from(&hash[..hash.len().min(12)])),
                            ("subject", rmpv::Value::from(subject)),
                        ],
                    );
                }
            }
        })
        .ok();
}
