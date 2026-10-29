//! Workspace trust for agent sessions.
//!
//! A coding agent pointed at a folder reads that folder's README, docs, and
//! scripts as part of its task, and a model cannot reliably tell repository
//! text apart from instructions. A malicious repository can therefore talk an
//! agent into running its own payload ("run `security.sh` before testing"). Ryu
//! cannot fix that in the model, so it decides how much autonomy an agent gets
//! from whether the user has said they trust the folder the agent works in.
//!
//! An untrusted workspace:
//! - refuses agent session modes that skip permission prompts
//!   (`bypassPermissions`, Claude Code `auto`, Codex `full-access`, …);
//! - rejects every shell-execution permission request on a headless turn,
//!   because there is no person to ask and a quiet scanner verdict is not
//!   consent;
//! - runs the agent under the strict OS sandbox profile
//!   ([`crate::agent_sandbox`]) where the host supports it.
//!
//! Trusted folders are a JSON array of absolute paths in the
//! `trusted-workspaces` preference. A folder trusts everything beneath it. A
//! chat that names no project runs in the desktop's default projectless folder
//! (`Documents/Ryu/Projects`) or in Core's own working directory. The
//! projectless folder holds no repository the user chose, so exactly that
//! folder (not its subfolders, where clones land) is trusted implicitly.
//!
//! Core's working directory is NOT trusted in shipped builds: whatever started
//! Core picks it, and that is routinely the home directory or `/` (a desktop
//! launcher, a service manager, a shell in `~`). Trusting it would hand every
//! projectless chat full autonomy over the user's whole home or disk. Only a
//! `dev`-profile Core, which a developer starts from the checkout they are
//! working on, trusts its working directory, and only when that directory is
//! narrower than the home directory, the temp directory, and a top-level
//! folder ([`working_directory_is_implicitly_trusted`]). A git worktree
//! inherits the trust of the repository it was created from, verified against
//! the back-link git keeps in that repository. Operators running unattended
//! nodes can opt out of the whole gate with `RYU_TRUST_ALL_WORKSPACES=1`.
//!
//! Clients add and remove folders through [`trust_folders`] and
//! [`untrust_folder`] (`POST /api/workspace-trust/{trust,untrust}`), which read,
//! change and write the preference under one lock. Two windows editing the
//! list at once therefore cannot drop each other's change; a lost removal
//! would leave a folder trusted.

use crate::server::preferences::PreferencesStore;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// Preferences key the desktop writes: a JSON array of absolute folder paths.
pub const TRUSTED_WORKSPACES_PREF_KEY: &str = "trusted-workspaces";

/// Operator escape hatch for unattended nodes that only ever run known code.
const ENV_TRUST_ALL: &str = "RYU_TRUST_ALL_WORKSPACES";

static TRUSTED: RwLock<Vec<PathBuf>> = RwLock::new(Vec::new());

/// Serializes every write of the trusted list, so an add/remove reads the
/// value the previous edit wrote.
static EDIT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Hold while replacing the whole preference through the generic preference
/// route, so that write cannot land between an edit's read and its write.
pub async fn lock_edits() -> tokio::sync::MutexGuard<'static, ()> {
    EDIT_LOCK.lock().await
}

/// The stored entries as the user wrote them (trimmed, non-empty, unique, in
/// order). Unlike [`parse_pref`] this keeps the original spelling so the list
/// round-trips; a malformed value reads as empty, as it does for the gate.
fn stored_entries(value: Option<&str>) -> Vec<String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let entries = serde_json::from_str::<Vec<String>>(value).unwrap_or_default();
    unique_entries(entries.iter().map(String::as_str))
}

fn unique_entries<'a>(entries: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for entry in entries.map(str::trim).filter(|entry| !entry.is_empty()) {
        if !unique.iter().any(|existing| existing == entry) {
            unique.push(entry.to_owned());
        }
    }
    unique
}

/// Read, change and write the trusted list under [`EDIT_LOCK`], then apply the
/// result to the live gate. Returns the stored list.
async fn edit_trusted(
    preferences: &PreferencesStore,
    edit: impl FnOnce(&mut Vec<String>),
) -> anyhow::Result<Vec<String>> {
    let _guard = lock_edits().await;
    let current = stored_entries(
        preferences
            .get(TRUSTED_WORKSPACES_PREF_KEY)
            .await?
            .as_deref(),
    );
    let mut next = current.clone();
    edit(&mut next);
    if next != current {
        let value = serde_json::to_string(&next)?;
        preferences.set(TRUSTED_WORKSPACES_PREF_KEY, &value).await?;
        set_from_pref(&value);
    }
    Ok(next)
}

/// Add folders to the trusted list (already-trusted folders are kept once).
pub async fn trust_folders(
    preferences: &PreferencesStore,
    folders: &[String],
) -> anyhow::Result<Vec<String>> {
    edit_trusted(preferences, |entries| {
        let added = unique_entries(entries.iter().chain(folders).map(String::as_str));
        *entries = added;
    })
    .await
}

/// Remove one folder from the trusted list.
pub async fn untrust_folder(
    preferences: &PreferencesStore,
    folder: &str,
) -> anyhow::Result<Vec<String>> {
    let folder = folder.trim().to_owned();
    edit_trusted(preferences, |entries| {
        entries.retain(|entry| *entry != folder);
    })
    .await
}

/// Parse the preference value. Entries that are not absolute paths are
/// dropped: a relative entry would silently trust whatever Core's working
/// directory happens to be.
pub fn parse_pref(value: &str) -> Vec<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Vec<String>>(trimmed) {
        Ok(entries) => entries
            .into_iter()
            .map(|entry| PathBuf::from(entry.trim()))
            .filter(|path| path.is_absolute())
            .map(|path| canonical(&path))
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "ignoring malformed trusted-workspaces preference");
            Vec::new()
        }
    }
}

/// Load the trusted folders from a preference value (startup and on change).
pub fn set_from_pref(value: &str) {
    let parsed = parse_pref(value);
    match TRUSTED.write() {
        Ok(mut trusted) => *trusted = parsed,
        Err(poisoned) => *poisoned.into_inner() = parsed,
    }
}

fn trust_all() -> bool {
    std::env::var(ENV_TRUST_ALL).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn canonical(path: &Path) -> PathBuf {
    dunce_canonicalize(path).unwrap_or_else(|| path.to_path_buf())
}

/// `std::fs::canonicalize` without the Windows `\\?\` verbatim prefix, so
/// paths compare equal to what the desktop stored.
fn dunce_canonicalize(path: &Path) -> Option<PathBuf> {
    let resolved = std::fs::canonicalize(path).ok()?;
    #[cfg(windows)]
    {
        let text = resolved.to_string_lossy();
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            if !stripped.starts_with("UNC\\") {
                return Some(PathBuf::from(stripped));
            }
        }
    }
    Some(resolved)
}

/// The repository a linked git worktree was created from, read from the
/// worktree's `.git` file (`gitdir: <repo>/.git/worktrees/<name>`). The folder
/// itself is untrusted, so its `.git` file alone proves nothing: a downloaded
/// project can ship one naming any trusted repository. Git records the
/// worktree's location inside the origin repository
/// (`<repo>/.git/worktrees/<name>/gitdir`), which the folder cannot write, so
/// that back-link must name this folder.
fn worktree_origin(path: &Path) -> Option<PathBuf> {
    let marker = std::fs::read_to_string(path.join(".git")).ok()?;
    let gitdir = marker.trim().strip_prefix("gitdir:")?.trim();
    let gitdir = PathBuf::from(gitdir);
    let gitdir = if gitdir.is_absolute() {
        gitdir
    } else {
        path.join(gitdir)
    };
    let worktrees = gitdir.parent()?;
    if worktrees.file_name()? != "worktrees" {
        return None;
    }
    let dot_git = worktrees.parent()?;
    if dot_git.file_name()? != ".git" {
        return None;
    }
    let back_link = std::fs::read_to_string(gitdir.join("gitdir")).ok()?;
    let linked = canonical(&PathBuf::from(back_link.trim()));
    if linked != canonical(&path.join(".git")) {
        return None;
    }
    dot_git.parent().map(canonical)
}

/// The desktop's default folder for chats without a project
/// (`apps/desktop/src-tauri/src/projectless_task_folder.rs`).
fn default_projectless_folder() -> Option<PathBuf> {
    dirs::document_dir().map(|documents| documents.join("Ryu").join("Projects"))
}

fn covered_by(path: &Path, trusted: &[PathBuf]) -> bool {
    trusted.iter().any(|root| path.starts_with(root))
}

/// The only profile whose Core trusts its own working directory: a developer
/// runs it from the checkout they are editing. Shipped profiles (`release`,
/// `beta`, `canary`, `nightly`) are started by launchers and service managers
/// whose working directory says nothing about what the user trusts.
const WORKING_DIRECTORY_TRUST_PROFILE: &str = "dev";

/// Whether Core's (canonical) working directory `cwd` may be trusted
/// implicitly under `profile`.
///
/// Only a `dev`-profile Core qualifies, and never for a folder that would cover
/// far more than one project: the filesystem root or a top-level folder
/// (`/home`, `/Users`, `/tmp`, `C:\Users`), the home directory or any folder
/// containing it, or the system temp directory, anything inside it
/// (world-writable, where downloads and extractions land), or any folder
/// containing it. The shared world-writable temp folders other than the
/// process temp directory (`/var/tmp`, `/private/tmp`, `/dev/shm`, …) are
/// excluded the same way. A Core that cannot name its home directory trusts no
/// working directory, since it cannot tell whether one covers the home.
pub(crate) fn working_directory_is_implicitly_trusted(
    cwd: &Path,
    profile: &str,
    home: Option<&Path>,
    temp: &Path,
) -> bool {
    if profile != WORKING_DIRECTORY_TRUST_PROFILE || !cwd.is_absolute() {
        return false;
    }
    let depth = cwd
        .components()
        .filter(|component| matches!(component, std::path::Component::Normal(_)))
        .count();
    if depth < 2 {
        return false;
    }
    let Some(home) = home else {
        return false;
    };
    if home.starts_with(cwd) {
        return false;
    }
    std::iter::once(temp)
        .chain(SHARED_TEMP_FOLDERS.iter().map(Path::new))
        .all(|temp| !temp.starts_with(cwd) && !cwd.starts_with(temp))
}

/// World-writable temp folders shared by every user, besides whatever
/// `std::env::temp_dir()` names (macOS's `/tmp` resolves to `/private/tmp`).
const SHARED_TEMP_FOLDERS: &[&str] = &[
    "/tmp",
    "/var/tmp",
    "/private/tmp",
    "/private/var/tmp",
    "/dev/shm",
];

/// Whether an agent working in `workspace` may run with full autonomy.
pub fn is_trusted(workspace: &Path) -> bool {
    if trust_all() {
        return true;
    }
    let path = canonical(workspace);
    let working_directory = std::env::current_dir()
        .ok()
        .map(|cwd| canonical(&cwd))
        .filter(|cwd| {
            working_directory_is_implicitly_trusted(
                cwd,
                crate::profile::profile(),
                dirs::home_dir().map(|home| canonical(&home)).as_deref(),
                &canonical(&std::env::temp_dir()),
            )
        });
    if working_directory
        .into_iter()
        .chain(default_projectless_folder().map(|folder| canonical(&folder)))
        .any(|folder| folder == path)
    {
        return true;
    }
    let trusted = match TRUSTED.read() {
        Ok(trusted) => trusted.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    if covered_by(&path, &trusted) {
        return true;
    }
    worktree_origin(&path).is_some_and(|origin| covered_by(&origin, &trusted))
}

/// Agent session modes that stop the agent from asking before it runs
/// commands. Claude Code's `auto` mode approves commands with a classifier,
/// which is exactly the setup a malicious README defeats; Codex's `auto` is its
/// default sandboxed, ask-on-escalation mode and stays available.
pub fn mode_skips_permission_prompts(mode: &str, is_claude_code: bool) -> bool {
    let normalized = mode.trim().to_ascii_lowercase().replace(['_', ' '], "-");
    match normalized.as_str() {
        "bypasspermissions" | "bypass-permissions" | "dontask" | "dont-ask" | "yolo"
        | "full-access" | "danger-full-access" | "never-ask" | "auto-approve" => true,
        "auto" => is_claude_code,
        _ => false,
    }
}

#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn with_trusted<T>(entries: &[&Path], body: impl FnOnce() -> T) -> T {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::remove_var(ENV_TRUST_ALL);
        let value = serde_json::to_string(
            &entries
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        set_from_pref(&value);
        let result = body();
        set_from_pref("");
        result
    }

    #[test]
    fn untrusted_until_a_parent_folder_is_trusted() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("geopy");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        with_trusted(&[], || assert!(!is_trusted(&repo)));
        with_trusted(&[root.path()], || {
            assert!(is_trusted(&repo));
            assert!(is_trusted(&repo.join("src")));
        });
        with_trusted(&[&repo.join("src")], || assert!(!is_trusted(&repo)));
    }

    #[test]
    fn sibling_prefix_is_not_trusted() {
        let root = tempfile::tempdir().unwrap();
        let trusted = root.path().join("app");
        let sibling = root.path().join("app-evil");
        std::fs::create_dir_all(&trusted).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        with_trusted(&[&trusted], || assert!(!is_trusted(&sibling)));
    }

    #[test]
    fn worktree_inherits_origin_trust() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let worktree = root.path().join("wt");
        std::fs::create_dir_all(repo.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", repo.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        std::fs::write(
            repo.join(".git/worktrees/wt/gitdir"),
            format!("{}\n", worktree.join(".git").display()),
        )
        .unwrap();
        with_trusted(&[], || assert!(!is_trusted(&worktree)));
        with_trusted(&[&repo], || assert!(is_trusted(&worktree)));
    }

    #[test]
    fn forged_worktree_marker_does_not_borrow_trust() {
        // A downloaded project ships a `.git` file naming a trusted repository's
        // real worktree; the repository's back-link names that worktree, not it.
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let real = root.path().join("wt");
        let forged = root.path().join("download");
        std::fs::create_dir_all(repo.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&forged).unwrap();
        let marker = format!("gitdir: {}\n", repo.join(".git/worktrees/wt").display());
        std::fs::write(real.join(".git"), &marker).unwrap();
        std::fs::write(forged.join(".git"), &marker).unwrap();
        std::fs::write(
            repo.join(".git/worktrees/wt/gitdir"),
            format!("{}\n", real.join(".git").display()),
        )
        .unwrap();
        with_trusted(&[&repo], || {
            assert!(is_trusted(&real));
            assert!(!is_trusted(&forged));
        });

        // No back-link at all: not a worktree git created.
        let orphan_repo = root.path().join("orphan");
        let orphan = root.path().join("orphan-wt");
        std::fs::create_dir_all(orphan_repo.join(".git/worktrees/x")).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(
            orphan.join(".git"),
            format!(
                "gitdir: {}\n",
                orphan_repo.join(".git/worktrees/x").display()
            ),
        )
        .unwrap();
        with_trusted(&[&orphan_repo], || assert!(!is_trusted(&orphan)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_trust_and_untrust_edits_all_persist() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.db");
        let preferences = PreferencesStore::open(path.clone()).unwrap();
        let removed: Vec<String> = (0..8).map(|index| format!("/old/{index}")).collect();
        preferences
            .set(
                TRUSTED_WORKSPACES_PREF_KEY,
                &serde_json::to_string(&removed).unwrap(),
            )
            .await
            .unwrap();
        let added: Vec<String> = (0..8).map(|index| format!("/new/{index}")).collect();

        let mut tasks = tokio::task::JoinSet::new();
        for (add, remove) in added.iter().cloned().zip(removed.iter().cloned()) {
            let trust_store = preferences.clone();
            tasks.spawn(async move { trust_folders(&trust_store, &[add]).await.map(drop) });
            let untrust_store = preferences.clone();
            tasks.spawn(async move { untrust_folder(&untrust_store, &remove).await.map(drop) });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap().unwrap();
        }

        let reopened = PreferencesStore::open(path).unwrap();
        let mut stored = stored_entries(
            reopened
                .get(TRUSTED_WORKSPACES_PREF_KEY)
                .await
                .unwrap()
                .as_deref(),
        );
        stored.sort();
        assert_eq!(stored, added);
        set_from_pref("");
    }

    #[tokio::test]
    async fn edits_keep_spelling_and_skip_duplicates() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = tempfile::tempdir().unwrap();
        let preferences = PreferencesStore::open(directory.path().join("p.db")).unwrap();
        preferences
            .set(TRUSTED_WORKSPACES_PREF_KEY, "not json")
            .await
            .unwrap();
        let folders = [
            "/a".to_owned(),
            " /b ".to_owned(),
            "/a".to_owned(),
            String::new(),
        ];
        assert_eq!(
            trust_folders(&preferences, &folders).await.unwrap(),
            ["/a", "/b"]
        );
        assert_eq!(untrust_folder(&preferences, " /a").await.unwrap(), ["/b"]);
        assert_eq!(
            preferences
                .get(TRUSTED_WORKSPACES_PREF_KEY)
                .await
                .unwrap()
                .as_deref(),
            Some(r#"["/b"]"#)
        );
        set_from_pref("");
    }

    #[test]
    fn malformed_and_relative_entries_are_ignored() {
        assert!(parse_pref("not json").is_empty());
        assert!(parse_pref(r#"["relative/path", ""]"#).is_empty());
        assert_eq!(parse_pref("").len(), 0);
    }

    #[test]
    fn dev_core_trusts_the_checkout_it_runs_from() {
        let home = Path::new("/home/dev");
        let temp = Path::new("/tmp");
        assert!(working_directory_is_implicitly_trusted(
            Path::new("/home/dev/src/ryu"),
            "dev",
            Some(home),
            temp,
        ));
        assert!(working_directory_is_implicitly_trusted(
            Path::new("/srv/checkouts/ryu"),
            "dev",
            Some(home),
            temp,
        ));
    }

    #[test]
    fn shipped_core_never_trusts_its_working_directory() {
        // A desktop launcher or service manager picks Core's working directory;
        // a repository the user chose is not implied by it.
        for profile in ["release", "beta", "canary", "nightly", ""] {
            assert!(
                !working_directory_is_implicitly_trusted(
                    Path::new("/home/dev/src/ryu"),
                    profile,
                    Some(Path::new("/home/dev")),
                    Path::new("/tmp"),
                ),
                "{profile}"
            );
        }
    }

    #[test]
    fn broad_working_directories_are_never_trusted() {
        let home = Path::new("/home/dev");
        let temp = Path::new("/var/folders/ab/T");
        for broad in [
            "/",
            "/home",
            "/home/dev",
            "/Users",
            "/tmp",
            "/var/folders",
            "/var/folders/ab/T",
            "/var/folders/ab/T/download",
        ] {
            assert!(
                !working_directory_is_implicitly_trusted(Path::new(broad), "dev", Some(home), temp),
                "{broad}"
            );
        }
        assert!(!working_directory_is_implicitly_trusted(
            Path::new("relative/dir"),
            "dev",
            Some(home),
            temp,
        ));
    }

    #[test]
    fn shared_temp_folders_and_an_unknown_home_are_never_trusted() {
        // `std::env::temp_dir()` names only one temp folder (on macOS a
        // per-user `/var/folders/...`); the shared world-writable ones are
        // still not a checkout.
        let home = Path::new("/Users/dev");
        let temp = Path::new("/private/var/folders/ab/T");
        for shared in [
            "/private/tmp",
            "/private/tmp/download",
            "/var/tmp",
            "/var/tmp/x",
            "/dev/shm",
            "/private/var/tmp",
        ] {
            assert!(
                !working_directory_is_implicitly_trusted(
                    Path::new(shared),
                    "dev",
                    Some(home),
                    temp
                ),
                "{shared}"
            );
        }
        // Without a home directory Ryu cannot tell `/home/dev` from a checkout.
        assert!(!working_directory_is_implicitly_trusted(
            Path::new("/home/dev"),
            "dev",
            None,
            Path::new("/tmp"),
        ));
    }

    #[test]
    fn working_directory_trust_follows_the_dev_rule() {
        // `is_trusted` itself: Core's working directory (the crate directory
        // under `cargo test`) is trusted exactly when the pure rule says so.
        let cwd = canonical(&std::env::current_dir().unwrap());
        let expected = working_directory_is_implicitly_trusted(
            &cwd,
            crate::profile::profile(),
            dirs::home_dir().map(|home| canonical(&home)).as_deref(),
            &canonical(&std::env::temp_dir()),
        );
        with_trusted(&[], || assert_eq!(is_trusted(&cwd), expected));
        if let Some(home) = dirs::home_dir() {
            with_trusted(&[], || assert!(!is_trusted(&home)));
        }
        with_trusted(&[], || assert!(!is_trusted(Path::new("/"))));
    }

    #[test]
    fn projectless_folder_is_trusted_but_not_repositories_inside_it() {
        // Paths that do not exist compare as given, so this touches no files.
        let Some(projectless) = default_projectless_folder() else {
            return;
        };
        with_trusted(&[], || {
            assert!(is_trusted(&projectless));
            assert!(!is_trusted(&projectless.join("cloned-repo")));
        });
    }

    #[test]
    fn permission_skipping_modes_are_recognized_per_agent() {
        assert!(mode_skips_permission_prompts("bypassPermissions", true));
        assert!(mode_skips_permission_prompts("auto", true));
        assert!(!mode_skips_permission_prompts("auto", false));
        assert!(mode_skips_permission_prompts("full-access", false));
        assert!(mode_skips_permission_prompts("dontAsk", true));
        for safe in ["default", "plan", "acceptEdits", "read-only"] {
            assert!(!mode_skips_permission_prompts(safe, true), "{safe}");
        }
    }
}
