//! The cleanup an uninstall applies: the app's own data categories, then the Core-held rows.
// test-exempt: moved verbatim out of server/plugin_uninstall.rs by the module split, no behaviour change; the tests of the helpers it calls stay in the parent file.

use super::*;

/// Purge the app-declared data categories (`data:<category>` rows) the user
/// checked, through the app's own `data.purge`. Runs BEFORE the uninstall
/// deactivates the app: the capability broker only reaches an enabled provider,
/// so purging after teardown is always refused. Errors are display-safe strings;
/// a failed purge never blocks the uninstall.
pub async fn purge_app_data(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    selected: &[String],
) -> Vec<String> {
    let selected: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let mut errors = Vec::new();
    if let Some(contributes) = &manifest.contributes {
        for category in &contributes.data_categories {
            let selection = format!("{CLEANUP_DATA_PREFIX}{}", category.id);
            if !selected.contains(selection.as_str()) {
                continue;
            }
            if let Err(error) =
                crate::server::data_admin::clear_app_category(state, manifest, &category.id).await
            {
                errors.push(format!("{}: {error}", category.title));
            }
        }
    }
    errors
}

/// Apply the optional Core-held cleanup rows the user checked (everything but
/// app-declared data categories, which [`purge_app_data`] handles before
/// teardown). Errors are returned as display-safe strings so uninstall itself
/// can still complete.
pub async fn apply_cleanup(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    selected: &[String],
    filter: crate::server::spaces::DocFilter<'_>,
) -> Vec<String> {
    let selected: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let plugin_id = &manifest.id;
    let mut errors = Vec::new();

    if selected.contains(CLEANUP_KEYBINDINGS) {
        if let Err(error) = clear_keybindings(state, plugin_id).await {
            errors.push(format!("Keyboard shortcuts: {error}"));
        }
    }

    if selected.contains(CLEANUP_SETTINGS) {
        if let Err(error) = clear_settings(state, manifest).await {
            errors.push(format!("Saved app settings: {error}"));
        }
    }

    if selected.contains(CLEANUP_SECRETS) {
        if let Some(store) = crate::plugin_secrets::global() {
            if let Err(error) = store.delete_plugin(plugin_id).await {
                errors.push(format!("Saved credentials: {error}"));
            }
        }
    }

    if selected.contains(CLEANUP_STORAGE) {
        if let Some(store) = crate::plugin_storage::global() {
            if let Err(error) = store.delete_plugin(plugin_id).await {
                errors.push(format!("Plugin storage: {error}"));
            }
        }
    }

    if selected.contains(CLEANUP_SCHEDULER) {
        for job in crate::scheduler::store::list_jobs()
            .into_iter()
            .filter(|job| job.owner_app.as_deref() == Some(plugin_id.as_str()))
        {
            if let Err(error) = crate::scheduler::store::delete_job(&job.id) {
                errors.push(format!("Scheduled automation '{}': {error}", job.name));
            }
        }
    }

    if selected.contains(CLEANUP_OAUTH) {
        match crate::mcp_oauth::global()
            .disconnect_plugin(plugin_id)
            .await
        {
            Ok(unconfirmed) if !unconfirmed.is_empty() => errors.push(format!(
                "Connected accounts: local credentials removed, but remote revocation was not confirmed for {} account{}.",
                unconfirmed.len(),
                if unconfirmed.len() == 1 { "" } else { "s" }
            )),
            Ok(_) => {}
            Err(error) => errors.push(format!("Connected accounts: {error}")),
        }
    }

    if selected.contains(CLEANUP_SPACES) {
        if let Err(error) = state.spaces.delete_app_data(plugin_id, filter).await {
            errors.push(format!("App spaces and documents: {error}"));
        }
    }

    if selected.contains(CLEANUP_FILES) {
        let data_dir = plugin_data_dir(plugin_id);
        match tokio::fs::remove_dir_all(&data_dir).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => errors.push(format!("App files: {error}")),
        }
    }

    errors
}
