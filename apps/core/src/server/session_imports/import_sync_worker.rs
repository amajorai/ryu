//! The folder sync worker's way into the setup import.
//!
//! The worker (`reconcile_import` in `server/agent_sync`) imports with nobody
//! present. `apply_import_selections` cannot tell it from a person: its caller
//! is `None` for the worker and also for the import routes of a node with no
//! sign-in. So the worker has this entry of its own. Every kind goes through
//! the same importer as a manual import, except a skill, which is installed
//! with `install_from_dir_unattended`. There an installed skill of the same
//! name is kept unless the worker can show that it installed it, and the
//! installed copy does not keep `always-on`.

use crate::server::*;

/// One result of the sync worker's import.
pub(crate) struct SyncWorkerOutcome {
    pub(crate) outcome: crate::import::ImportOutcome,
    /// The directory a skill was installed into by this call, so the worker
    /// can remember what it wrote there.
    pub(crate) installed_skill_dir: Option<std::path::PathBuf>,
}

/// Import the items the sync worker selected, one result per selection, in
/// order. `may_replace_skill(selection, installed_dir)` is asked when a skill
/// of the same name is installed already.
pub(crate) async fn apply_sync_worker_selections(
    state: &ServerState,
    root: &std::path::Path,
    selections: Vec<crate::import::ImportSelection>,
    may_replace_skill: &(dyn Fn(&crate::import::ImportSelection, &std::path::Path) -> bool + Sync),
) -> Vec<SyncWorkerOutcome> {
    let caller: Option<crate::identity_verify::VerifiedCaller> = None;
    let mut export_batch = read_chat_export_batch(&caller, root, &selections).await;
    let mut results = Vec::with_capacity(selections.len());
    for selection in selections {
        let result = if selection.kind == crate::import::kind::SKILL {
            import_skill_item_unattended(state, root, &selection, may_replace_skill)
        } else {
            let outcome = match export_batch.as_mut() {
                Some(batch) if selection.kind == crate::import::kind::CONVERSATIONS => {
                    import_chat_export_item(state, &caller, root, &selection, Some(batch)).await
                }
                _ => import_setup_item(state, &caller, root, &selection).await,
            };
            SyncWorkerOutcome {
                outcome,
                installed_skill_dir: None,
            }
        };
        results.push(result);
    }
    results
}

fn import_skill_item_unattended(
    state: &ServerState,
    root: &std::path::Path,
    selection: &crate::import::ImportSelection,
    may_replace_skill: &(dyn Fn(&crate::import::ImportSelection, &std::path::Path) -> bool + Sync),
) -> SyncWorkerOutcome {
    use crate::import::{kind, ImportOutcome};
    use crate::skills_catalog::from_source::{install_from_dir_unattended, UnattendedInstall};

    let failed = |error: String| SyncWorkerOutcome {
        outcome: ImportOutcome::failed(kind::SKILL, &selection.id, &selection.id, &error),
        installed_skill_dir: None,
    };
    let dir = match crate::import::resolve_item_path(root, &selection.id) {
        Ok(dir) => dir,
        Err(error) => return failed(error.to_string()),
    };
    let may_replace = |installed: &std::path::Path| may_replace_skill(selection, installed);
    match install_from_dir_unattended(&dir, &may_replace) {
        Ok(UnattendedInstall::Installed(result)) => {
            state.skills.reload();
            SyncWorkerOutcome {
                outcome: ImportOutcome::ok(
                    kind::SKILL,
                    &selection.id,
                    &format!("Skill '{}'", result.slug),
                ),
                installed_skill_dir: std::path::Path::new(&result.path)
                    .parent()
                    .map(std::path::Path::to_path_buf),
            }
        }
        Ok(UnattendedInstall::Kept { slug }) => SyncWorkerOutcome {
            outcome: ImportOutcome::already(
                kind::SKILL,
                &selection.id,
                &format!("Skill '{}'", slug),
            ),
            installed_skill_dir: None,
        },
        Err(error) => failed(error.to_string()),
    }
}
