//! The control-plane project a run's shared values come from (roadmap P1-15).
//!
//! Project-scoped values live only in the control plane. A run reaches one
//! project's values when its workspace folder sits under a folder this node
//! maps to an organization project (`/api/org-project-mappings`, set from
//! Desktop's project settings and stored by [`crate::fleet`]). The deepest
//! mapped root wins, as for managed instructions. The project id is derived
//! here from server-side state only (the conversation's recorded workspace
//! and the node's own mapping file), never from model-authored arguments, and
//! it is only a hint: the control plane re-checks that the project belongs to
//! this node's organization, is not archived, that a team node stays within
//! its team, and that the run's user can reach the project.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use crate::fleet::ProjectMapping;
use crate::plugin_secrets::{is_valid_scope_id, SecretResolutionContext};

/// The file `crate::fleet` keeps the node's project mappings in
/// (`fleet::mappings_path`).
const MAPPINGS_FILE: &str = "org-project-mappings.json";

/// Prefix of the synthetic conversation id a broker session resolves under.
const BROKER_CONVERSATION_PREFIX: &str = "broker:";

fn load_mappings() -> Vec<ProjectMapping> {
    let path = crate::paths::state_path(MAPPINGS_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            tracing::warn!("org project mappings are unreadable: {error}");
            Vec::new()
        }),
        Err(_) => Vec::new(),
    }
}

/// The organization project whose mapped root holds `workspace`, deepest
/// root first. `workspace` must already be canonical; mapped roots are
/// stored canonical by `PUT /api/org-project-mappings`.
pub fn project_for_workspace(
    mappings: &[ProjectMapping],
    organization_id: &str,
    workspace: &Path,
) -> Option<String> {
    crate::fleet::project_for_cwd(mappings, organization_id, workspace)
        .filter(|project| is_valid_scope_id(project))
        .map(str::to_owned)
}

/// The canonical workspace a conversation's run records (its worktree first,
/// then its folder), or `None` without one.
async fn run_workspace(conversation_id: &str) -> Option<PathBuf> {
    let registry = crate::sidecar::mcp::global_registry()?;
    let store = registry.conversations.as_ref()?;
    let summary = store.get_run_summary(conversation_id).await.ok()??;
    [summary.worktree_path, summary.folder_path]
        .into_iter()
        .flatten()
        .find_map(|raw| std::fs::canonicalize(raw).ok())
}

/// Whether `context` may carry a derived run project: a shared-value run with
/// a server-derived user in an organization, a real conversation, and no
/// project already chosen.
fn wants_run_project(context: &SecretResolutionContext, shared_enabled: bool) -> Option<&str> {
    if !shared_enabled
        || context.project_id.is_some()
        || context.user_id.is_none()
        || context.org_id.is_none()
    {
        return None;
    }
    context
        .conversation_id
        .as_deref()
        .filter(|id| !id.is_empty() && !id.starts_with(BROKER_CONVERSATION_PREFIX))
}

/// `context` with the run's mapped project filled in when it has none. A
/// context that already names a project, has no conversation, or runs where
/// shared values are off is returned unchanged.
pub async fn with_run_project(
    context: &SecretResolutionContext,
) -> Cow<'_, SecretResolutionContext> {
    let Some(conversation_id) = wants_run_project(context, crate::vault::shared::is_enabled())
    else {
        return Cow::Borrowed(context);
    };
    let Some(workspace) = run_workspace(conversation_id).await else {
        return Cow::Borrowed(context);
    };
    let organization_id = context.org_id.as_deref().unwrap_or_default();
    match project_for_workspace(&load_mappings(), organization_id, &workspace) {
        Some(project_id) => Cow::Owned(SecretResolutionContext {
            project_id: Some(project_id),
            ..context.clone()
        }),
        None => Cow::Borrowed(context),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(organization: &str, project: &str, root: &str) -> ProjectMapping {
        ProjectMapping {
            organization_id: organization.into(),
            project_id: project.into(),
            root: PathBuf::from(root),
        }
    }

    #[test]
    fn the_deepest_mapped_root_of_the_organization_names_the_project() {
        let mappings = vec![
            mapping("org-1", "proj-repo", "/work/repo"),
            mapping("org-1", "proj-api", "/work/repo/api"),
            mapping("org-2", "proj-other", "/work/repo/api/deeper"),
        ];
        let at = |path: &str| project_for_workspace(&mappings, "org-1", Path::new(path));
        assert_eq!(at("/work/repo/api/src").as_deref(), Some("proj-api"));
        assert_eq!(at("/work/repo/web").as_deref(), Some("proj-repo"));
        // Another organization's mapping never applies, even when deeper.
        assert_eq!(at("/work/repo/api/deeper").as_deref(), Some("proj-api"));
        // A sibling whose name only shares a prefix is not under the root.
        assert_eq!(at("/work/repository"), None);
        assert_eq!(at("/elsewhere"), None);
    }

    #[test]
    fn the_mapping_file_is_the_one_fleet_writes() {
        // `crate::fleet` keeps its loader private; pin the file it writes.
        let fleet = include_str!("../fleet/mod.rs");
        assert!(fleet.contains(&format!("crate::paths::state_path(\"{MAPPINGS_FILE}\")")));
    }

    #[test]
    fn an_invalid_project_id_in_the_mapping_file_is_ignored() {
        let mappings = vec![mapping("org-1", "has space", "/work/repo")];
        assert_eq!(
            project_for_workspace(&mappings, "org-1", Path::new("/work/repo")),
            None
        );
    }

    fn run_context() -> SecretResolutionContext {
        SecretResolutionContext {
            user_id: Some("u1".into()),
            org_id: Some("org-1".into()),
            node_id: "node-1".into(),
            conversation_id: Some("conv-1".into()),
            ..Default::default()
        }
    }

    #[test]
    fn only_a_shared_user_run_without_a_chosen_project_derives_one() {
        let context = run_context();
        assert_eq!(wants_run_project(&context, true), Some("conv-1"));
        assert_eq!(wants_run_project(&context, false), None);

        let chosen = SecretResolutionContext {
            project_id: Some("proj-picked".into()),
            ..run_context()
        };
        assert_eq!(wants_run_project(&chosen, true), None);

        for context in [
            SecretResolutionContext {
                user_id: None,
                ..run_context()
            },
            SecretResolutionContext {
                org_id: None,
                ..run_context()
            },
            SecretResolutionContext {
                conversation_id: None,
                ..run_context()
            },
            SecretResolutionContext {
                conversation_id: Some("broker:rvb_1".into()),
                ..run_context()
            },
        ] {
            assert_eq!(wants_run_project(&context, true), None);
        }
    }

    #[tokio::test]
    async fn a_context_is_unchanged_where_shared_values_are_off() {
        // No registered node in tests: shared values are off.
        let context = run_context();
        let derived = with_run_project(&context).await;
        assert!(matches!(derived, Cow::Borrowed(_)));
        assert_eq!(derived.project_id, None);
    }
}
