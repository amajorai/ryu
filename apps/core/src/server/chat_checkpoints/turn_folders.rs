//! The folder boundary for turns on a shared node.
//!
//! On a node that several people use (a registered Org or Team node, or a managed
//! node that is not registered yet) Core acts in a turn's folder for whoever sent
//! the turn: it snapshots the folder, lists what changed in it, rolls it back,
//! reads and writes files there for the engine, loads its instruction files and
//! starts the engine in it. On such a node every folder of a turn must therefore
//! lie inside one of the node's member folders, a list kept in the
//! `member-workspace-roots` preference by whoever may manage the node.
//!
//! The rule is one function, [`bound_turn`], used at every place a turn's folder
//! enters Core or a stored folder is used again. It fails closed: no list, an
//! empty list or an entry Core cannot fully read allows nothing.
//!
//! A personal node is not touched: every function here returns before any path
//! work when [`node_bounds_turn_folders`] is false.
//!
//! This bounds what Core itself does in a folder. It does not bound the engine's
//! own tools; an engine started in an allowed folder still runs as the Core user.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::sidecar::adapters::ChatStreamRequest;
use crate::sidecar::control_plane::{self, NodeScope};

/// Preference holding the member folders: a JSON array of `{ "path": "<absolute
/// directory>" }`. A folder covers everything beneath it.
pub const MEMBER_WORKSPACE_ROOTS_PREF_KEY: &str = "member-workspace-roots";

/// Answer for a folder outside the member folders. It names no folder.
pub(crate) const FOLDER_UNAVAILABLE_MESSAGE: &str = "Project folder is unavailable";
/// Answer for an engine turn that has no folder it may run in.
pub(crate) const FOLDER_REQUIRED_MESSAGE: &str = "A project folder is required";

/// The member folders, canonical, as last loaded from the preference.
static MEMBER_ROOTS: RwLock<Vec<PathBuf>> = RwLock::new(Vec::new());

#[cfg(test)]
tokio::task_local! {
    /// A per-task member folder list, so a test never changes the list that
    /// concurrently running tests read.
    static TEST_MEMBER_ROOTS: Vec<PathBuf>;
}

/// Run `fut` with `roots` as the node's member folders (already canonical).
#[cfg(test)]
pub(crate) async fn with_test_member_roots<F: std::future::Future>(
    roots: Vec<PathBuf>,
    fut: F,
) -> F::Output {
    TEST_MEMBER_ROOTS.scope(roots, fut).await
}

/// Whether this node bounds the folders of every turn: a registered Org or Team
/// node, or a managed node that is not registered yet. Nobody is exempt on such a
/// node, a turn with no caller included. A personal node, registered or not, is
/// never bounded.
pub(crate) fn node_bounds_turn_folders() -> bool {
    match control_plane::registered_node() {
        Some(node) => node.scope != NodeScope::Personal,
        None => control_plane::is_managed_node(),
    }
}

/// Load the member folders from the preference value (startup and on change).
pub fn set_from_pref(value: &str) {
    let parsed = parse_member_roots(value);
    match MEMBER_ROOTS.write() {
        Ok(mut roots) => *roots = parsed,
        Err(poisoned) => *poisoned.into_inner() = parsed,
    }
}

fn member_roots() -> Vec<PathBuf> {
    #[cfg(test)]
    if let Ok(roots) = TEST_MEMBER_ROOTS.try_with(|roots| roots.clone()) {
        return roots;
    }
    match MEMBER_ROOTS.read() {
        Ok(roots) => roots.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RootEntry {
    path: String,
}

/// Parse the preference. A value that is not a JSON array allows nothing, and an
/// entry Core cannot fully read is dropped, never widened.
pub(crate) fn parse_member_roots(value: &str) -> Vec<PathBuf> {
    let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(value.trim()) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value::<RootEntry>(entry).ok())
        .filter_map(|entry| usable_root(entry.path.trim()))
        .collect()
}

/// A member folder must be an absolute path to an existing directory. It is never
/// a filesystem root, the home directory or a directory above it, a directory
/// that holds Ryu's own data, or a protected store.
fn usable_root(raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.is_dir() || canonical.parent().is_none() {
        return None;
    }
    if crate::tool_exec::is_protected_host_path(&canonical) {
        return None;
    }
    let holds = |inner: Option<PathBuf>| {
        inner
            .and_then(|inner| std::fs::canonicalize(inner).ok())
            .is_some_and(|inner| inner.starts_with(&canonical))
    };
    if holds(dirs::home_dir()) || holds(Some(crate::paths::ryu_dir())) {
        return None;
    }
    Some(canonical)
}

/// One folder of a turn, judged against the member folders.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Folder {
    /// No folder, a blank one, or one that does not resolve on this node.
    Absent,
    /// Resolves inside a member folder; the resolved path.
    Inside(PathBuf),
    /// Resolves outside every member folder, or inside a protected store.
    Outside,
}

pub(crate) fn judge(raw: Option<&str>, roots: &[PathBuf]) -> Folder {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Folder::Absent;
    };
    let Ok(canonical) = std::fs::canonicalize(raw) else {
        return Folder::Absent;
    };
    let inside = roots.iter().any(|root| canonical.starts_with(root));
    if inside && !crate::tool_exec::is_protected_host_path(&canonical) {
        Folder::Inside(plain(canonical))
    } else {
        Folder::Outside
    }
}

/// `canonicalize` on Windows returns `\\?\C:\…`, which engines and Git do not take
/// as a working folder. Use the plain drive or share path instead.
fn plain(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(text) = path.to_str() {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn text(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// The folder fields of one turn.
pub(crate) struct TurnFolders<'a> {
    pub(crate) cwd: &'a mut Option<String>,
    pub(crate) workspace_folders: &'a mut Vec<String>,
    pub(crate) worktree_path: &'a mut Option<String>,
    pub(crate) worktree_isolation: bool,
}

/// Apply the boundary to a turn's folders, in place.
///
/// On a bounded node a folder that resolves outside the member folders refuses
/// the turn. A folder that does not resolve is cleared, so it is never stored and
/// never used as a project id. A folder inside is replaced by its resolved path,
/// so what is used later is what was checked. With worktree isolation the Git
/// root of the folder must be inside as well, because the managed worktree is a
/// checkout of the whole repository.
pub(crate) fn bound_turn(folders: TurnFolders<'_>) -> Result<(), &'static str> {
    if !node_bounds_turn_folders() {
        return Ok(());
    }
    bound_turn_in(folders, &member_roots())
}

fn bound_turn_in(folders: TurnFolders<'_>, roots: &[PathBuf]) -> Result<(), &'static str> {
    let mut resolved = Vec::with_capacity(2);
    for raw in [folders.cwd.as_deref(), folders.worktree_path.as_deref()] {
        match judge(raw, roots) {
            Folder::Outside => return Err(FOLDER_UNAVAILABLE_MESSAGE),
            Folder::Inside(path) => resolved.push(Some(path)),
            Folder::Absent => resolved.push(None),
        }
    }
    let mut extra = Vec::with_capacity(folders.workspace_folders.len());
    for raw in folders.workspace_folders.iter() {
        match judge(Some(raw), roots) {
            Folder::Outside => return Err(FOLDER_UNAVAILABLE_MESSAGE),
            Folder::Inside(path) => extra.push(text(path)),
            Folder::Absent => {}
        }
    }
    let worktree = resolved.pop().flatten();
    let cwd = resolved.pop().flatten();
    if folders.worktree_isolation {
        if let Some(root) = cwd
            .as_deref()
            .and_then(ryu_workspace::worktree::find_git_root)
        {
            if !matches!(judge(root.to_str(), roots), Folder::Inside(_)) {
                return Err(FOLDER_UNAVAILABLE_MESSAGE);
            }
        }
    }
    *folders.cwd = cwd.map(text);
    *folders.workspace_folders = extra;
    *folders.worktree_path = worktree.map(text);
    Ok(())
}

/// [`bound_turn`] for a chat request. Every turn passes it in `admit_chat_turn`.
pub(crate) fn bound_request(req: &mut ChatStreamRequest) -> Result<(), &'static str> {
    bound_turn(TurnFolders {
        cwd: &mut req.cwd,
        workspace_folders: &mut req.workspace_folders,
        worktree_path: &mut req.worktree_path,
        worktree_isolation: req.worktree_isolation,
    })
}

/// The chat route's check before it claims the conversation, so a refused turn
/// records nothing. A cloud turn is left to the cloud branch, which clears the
/// folder fields, and to `admit_chat_turn` behind it.
pub(crate) async fn bound_request_before_claim(
    req: &mut ChatStreamRequest,
) -> Result<(), &'static str> {
    if !node_bounds_turn_folders() {
        return Ok(());
    }
    if let Some(conversation_id) = req.conversation_id.as_deref() {
        if req.cloud_environment_id.is_some()
            || crate::server::cloud_tasks::has_bound_task(conversation_id).await
        {
            return Ok(());
        }
    }
    bound_request(req)
}

/// The refusal for running a conversation's stored folders again (retry), judged
/// as the rerun request will be: isolation is on when a worktree is stored.
pub(crate) fn stored_turn_refusal(
    folder_path: Option<&str>,
    worktree_path: Option<&str>,
) -> Option<&'static str> {
    let mut cwd = folder_path.map(str::to_owned);
    let mut worktree = worktree_path.map(str::to_owned);
    bound_turn(TurnFolders {
        cwd: &mut cwd,
        workspace_folders: &mut Vec::new(),
        worktree_path: &mut worktree,
        worktree_isolation: worktree_path.is_some(),
    })
    .err()
}

/// Whether Core may act in a stored folder (a checkpoint's workspace, a thread's
/// folder, a command tool's root). Always true on a personal node. On a bounded
/// node the folder must resolve inside a member folder.
pub(crate) fn stored_folder_allowed(folder: &Path) -> bool {
    !node_bounds_turn_folders()
        || matches!(judge(folder.to_str(), &member_roots()), Folder::Inside(_))
}

#[cfg(test)]
mod tests;
