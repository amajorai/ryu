//! Workspace path arguments and protected host paths for command tools.
//!
//! Split out of `tool_exec/mod.rs`; items are re-exported there, so
//! `crate::tool_exec::*` paths are unchanged.

use super::*;

/// Replace declared filesystem arguments with canonical paths inside the active
/// workspace. The command backend remains argv-only, but argv separation alone
/// does not stop a read-only binary from opening an arbitrary absolute path.
/// Canonicalization happens after the grant check and before spawn, so a command
/// tool gets neither a path outside its caller's workspace nor a symlink escape.
/// `hidden` holds the canonical stores the calling agent's account access
/// hides from it ([`account_hidden_paths`]): a path inside one, or a folder
/// that contains one (which a recursive tool would walk into), is refused.
pub(super) fn prepare_workspace_path_args(
    args: &mut Value,
    path_args: &[String],
    workspace_root: Option<&std::path::Path>,
    hidden: &[std::path::PathBuf],
) -> Result<(), String> {
    if path_args.is_empty() {
        return Ok(());
    }
    let root = workspace_root.ok_or_else(|| {
        "command tool: an active workspace is required for filesystem path arguments".to_owned()
    })?;
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("command tool: workspace root is unavailable: {e}"))?;
    if !root.is_dir() {
        return Err("command tool: workspace root is not a directory".to_owned());
    }
    let object = args
        .as_object_mut()
        .ok_or_else(|| "command tool: filesystem path arguments require an object".to_owned())?;
    for name in path_args {
        let raw = object
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("command tool: missing filesystem path argument '{name}'"))?;
        let resolved = resolve_workspace_path(&root, raw)?;
        let resolved_path = std::path::Path::new(&resolved);
        if hidden.iter().any(|store| {
            path_is_within(resolved_path, store) || path_is_within(store, resolved_path)
        }) {
            return Err(
                "command tool: this agent's account access hides that path from it".to_owned(),
            );
        }
        object.insert(name.clone(), Value::String(resolved));
    }
    Ok(())
}

/// Resolve one command-tool path against a canonical workspace root.
/// Existing paths are required so the check can reject symlink components rather
/// than checking a path that may later resolve somewhere else. The command still
/// receives the canonical path, not the caller's spelling.
pub(super) fn resolve_workspace_path(
    workspace_root: &std::path::Path,
    raw: &str,
) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("command tool: filesystem path must not be empty".to_owned());
    }
    if raw.len() > MAX_COMMAND_ARG_LEN {
        return Err(format!(
            "command tool: filesystem path exceeds {MAX_COMMAND_ARG_LEN} bytes"
        ));
    }
    if raw.contains('\0') {
        return Err("command tool: filesystem path contains a NUL byte".to_owned());
    }

    let requested = std::path::Path::new(raw);
    let candidate = if requested.is_absolute() {
        requested.to_owned()
    } else {
        workspace_root.join(requested)
    };
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|_| "command tool: filesystem path could not be resolved".to_owned())?;
    if !path_is_within(&canonical, workspace_root) {
        return Err(
            "command tool: filesystem path must stay inside the active workspace".to_owned(),
        );
    }
    if path_has_symlink_component_below_root(&candidate, workspace_root) {
        return Err("command tool: filesystem path may not contain symlinks".to_owned());
    }
    if is_or_contains_protected_host_path(&canonical) {
        return Err("command tool: protected host paths are not searchable".to_owned());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// The stores the OS sandbox hides from a limited agent's engine
/// ([`crate::agent_access::AccountConfinement`]), canonical: Ryu's data dir,
/// the home credential stores (SSH, cloud, package-registry and Git keys,
/// browser profiles), the Ryu Desktop's and Ryu Browser's data and, when its
/// model providers are limited, the user's provider sign-in and key stores.
/// Empty for an unrestricted agent or an unattributed call.
pub(super) async fn account_hidden_paths(agent_id: Option<&str>) -> Vec<std::path::PathBuf> {
    let (Some(agent_id), Some(store)) = (agent_id, crate::agents::global()) else {
        return Vec::new();
    };
    let confinement = crate::agent_access::account_confinement_for_agent(store, agent_id).await;
    if !confinement.is_confined() {
        return Vec::new();
    }
    let provider_stores = confinement
        .hides_providers()
        .then(crate::agent_access::user_provider_stores);
    confined_hidden_paths(
        &crate::paths::ryu_dir(),
        dirs::home_dir().as_deref(),
        provider_stores.as_deref(),
    )
}

/// The canonical stores a confined agent's command tools may not reach:
/// `ryu_dir`, the home credential stores under `home`
/// ([`crate::agent_sandbox::home_credential_masks`]), the user's Keychain
/// files ([`crate::agent_sandbox::keychain_masks`]), the Ryu Desktop's and
/// Ryu Browser's data, and `provider_stores` when given. Each is resolved
/// through symlinks, so a store linked elsewhere is hidden where it really
/// lives; a store that does not exist is skipped, since a path inside it
/// cannot resolve either. `home` itself is not a store: a workspace in the
/// home folder keeps its ordinary paths, though a folder containing a store
/// is refused by [`prepare_workspace_path_args`].
pub(super) fn confined_hidden_paths(
    ryu_dir: &std::path::Path,
    home: Option<&std::path::Path>,
    provider_stores: Option<&[std::path::PathBuf]>,
) -> Vec<std::path::PathBuf> {
    let mut paths = vec![ryu_dir.to_owned()];
    paths.extend(crate::agent_sandbox::home_credential_masks(home));
    paths.extend(crate::agent_sandbox::keychain_masks(home));
    paths.extend(crate::agent_sandbox::ryu_app_data_masks(
        &crate::agent_sandbox::ryu_app_data_roots(home),
    ));
    if let Some(stores) = provider_stores {
        paths.extend(stores.iter().cloned());
    }
    let mut hidden: Vec<std::path::PathBuf> = paths
        .into_iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .collect();
    hidden.sort();
    hidden.dedup();
    hidden
}

pub(super) fn path_is_within(path: &std::path::Path, root: &std::path::Path) -> bool {
    path == root || path.strip_prefix(root).is_ok()
}

/// Check workspace-relative spelling supplied to `canonicalize`, not only its
/// resolved target. Parent directories outside the workspace may legitimately be
/// symlinks (for example macOS's `/tmp`), so only components below the canonical
/// workspace root are rejected.
pub(super) fn path_has_symlink_component_below_root(
    path: &std::path::Path,
    workspace_root: &std::path::Path,
) -> bool {
    let Ok(relative) = path.strip_prefix(workspace_root) else {
        return false;
    };
    let mut current = workspace_root.to_owned();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    false
}

/// Ryu's own data and the conventional per-user credential directories are not
/// valid workspace search targets, even when an operator accidentally selects a
/// parent directory as the active workspace. Known Ryu credential filenames are
/// denied at any depth as a second defense for copied or nested data directories.
pub(crate) fn is_protected_host_path(path: &std::path::Path) -> bool {
    if protected_host_roots()
        .iter()
        .any(|root| path_is_within(path, root))
    {
        return true;
    }

    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        file_name.to_ascii_lowercase().as_str(),
        "node-auth.token" | "core.token" | "gateway.token" | "pairing.token"
    )
}

/// True when `path` is a protected store or a directory that holds one (a parent
/// of the home folder such as `/home`, or of `~/.ssh`). A tool that mounts or
/// walks the whole directory, `just-bash` reading `alice/.ssh/id_ed25519` through
/// `/home`, would otherwise reach the store although the path itself is not inside it.
pub(super) fn is_or_contains_protected_host_path(path: &std::path::Path) -> bool {
    is_protected_host_path(path)
        || protected_host_roots()
            .iter()
            .any(|root| path_is_within(root, path))
}

/// The conventional protected stores, canonical; a store that does not exist is skipped.
pub(super) fn protected_host_roots() -> Vec<std::path::PathBuf> {
    let mut roots = vec![crate::paths::ryu_dir()];
    if let Some(home) = dirs::home_dir() {
        roots.extend([
            home.join(".ssh"),
            home.join(".gnupg"),
            home.join(".aws"),
            home.join(".azure"),
            home.join(".codex"),
            home.join(".pi"),
            home.join(".config").join("gcloud"),
        ]);
    }
    roots
        .into_iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect()
}

/// Reject workspace roots that would turn a narrowly selected project search
/// into a host-wide search. The active root must be a real directory below the
/// filesystem root and must not be the user's home, a parent of it (`/home`,
/// `/Users`), or a protected host store or a folder holding one.
pub(crate) fn is_usable_workspace_root(path: &std::path::Path) -> bool {
    if !path.is_dir() || path.parent().is_none() {
        return false;
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    if is_or_contains_protected_host_path(&canonical) {
        return false;
    }
    dirs::home_dir()
        .and_then(|home| std::fs::canonicalize(home).ok())
        .is_none_or(|home| !path_is_within(&home, &canonical))
}
