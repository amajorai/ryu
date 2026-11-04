//! App catalog browse, install-from-URL and hot reload: `install_default_official_plugins` through `std::error::Error for CatalogResolveFailed`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Install the official default package set on first use. This is deliberately
/// the same catalog install path used by the Store UI: signatures, package
/// integrity, dependency closure, provenance, and lifecycle writes must not
/// have a second startup-only implementation.
pub async fn install_default_official_plugins(
    state: &ServerState,
) -> std::collections::HashSet<String> {
    let mut newly_materialized = std::collections::HashSet::new();
    let preexisting: std::collections::HashSet<String> = state
        .app_store
        .list_all_records()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|record| record.id)
        .collect();
    let mut ids: Vec<String> = crate::plugins::builtins::CORE_PREINSTALLED
        .iter()
        .map(|id| (*id).to_owned())
        .collect();
    for record_id in &preexisting {
        if !crate::plugins::builtins::is_system_plugin(record_id)
            && !ids.iter().any(|id| id == record_id)
        {
            ids.push(record_id.clone());
        }
    }

    for id in ids {
        if crate::plugins::builtins::is_system_plugin(&id) {
            continue;
        }
        let manifest_path = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
            .join(crate::plugin_manifest::plugin_dir_name(&id))
            .join(crate::plugin_manifest::MANIFEST_FILE_NAME);
        let has_lifecycle_record = state
            .app_store
            .get_record(&id)
            .await
            .ok()
            .flatten()
            .is_some();
        if should_skip_official_package_materialization(
            manifest_path.exists(),
            has_lifecycle_record,
        ) {
            // A pre-digest lifecycle row must not make an existing package a
            // permanent Community package. Re-verify through the catalog before
            // taking this materialization fast path; a changed on-disk manifest,
            // unsigned record, or non-official source is deliberately left
            // untrusted.
            reverify_existing_official_package(state, &id).await;
            continue;
        }
        let response = install_plugin_from_catalog(
            axum::extract::State(state.clone()),
            axum::http::HeaderMap::new(),
            axum::Extension(None),
            axum::Json(PluginCatalogInstallBody {
                id: id.clone(),
                channel: None,
                version: None,
            }),
        )
        .await;
        if !response.status().is_success() {
            tracing::warn!(plugin = %id, status = %response.status(), "official package materialization deferred");
        }
    }
    // A pre-installed package may have been materialized as a dependency of another
    // default package, so derive this from the complete post-pass state rather
    // than only from the top-level catalog requests.
    for id in crate::plugins::builtins::CORE_PREINSTALLED {
        if preexisting.contains(*id) {
            continue;
        }
        let manifest_path = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
            .join(crate::plugin_manifest::plugin_dir_name(id))
            .join(crate::plugin_manifest::MANIFEST_FILE_NAME);
        if manifest_path.exists()
            && state
                .app_store
                .get_record(id)
                .await
                .ok()
                .flatten()
                .is_some()
        {
            newly_materialized.insert((*id).to_owned());
        }
    }
    newly_materialized
}

pub(in crate::server) fn should_skip_official_package_materialization(
    manifest_exists: bool,
    has_lifecycle_record: bool,
) -> bool {
    manifest_exists && has_lifecycle_record
}

/// Re-verify and backfill legacy official-package provenance before startup
/// materialization returns early for an already-present manifest.
pub(in crate::server) async fn reverify_existing_official_package(state: &ServerState, id: &str) {
    let Some(record) = state.app_store.get_record(id).await.ok().flatten() else {
        return;
    };
    let Some(old_provenance) = record.provenance.as_ref() else {
        return;
    };
    if old_provenance.manifest_sha256.is_some()
        || old_provenance.source_id.as_deref()
            != Some(crate::plugins::isolation::OFFICIAL_MARKETPLACE_SOURCE_ID)
        || !old_provenance.signature_verified
    {
        return;
    }
    let Some(on_disk_manifest) = state
        .app_manifests
        .read()
        .await
        .iter()
        .find(|manifest| manifest.id == id)
        .cloned()
    else {
        return;
    };
    let Ok((catalog_manifest, _, verified_provenance)) =
        resolve_plugin_from_catalog(state, id, None, None, None).await
    else {
        return;
    };
    let Some(backfilled) = crate::plugins::lifecycle::reverified_provenance(
        &on_disk_manifest,
        &catalog_manifest,
        &verified_provenance,
    ) else {
        return;
    };
    if let Err(error) = state.app_store.set_provenance(id, Some(&backfilled)).await {
        tracing::warn!(plugin = %id, "could not backfill verified package provenance: {error}");
    }
}

/// Resolve ONE plugin id to its validated manifest (+ pre-gated `ui_code`) from
/// the plugin catalog.
///
/// Tries the **active** source first (the user's chosen marketplace — so the
/// target's resolution, and its failure status codes, are exactly what they were
/// before dependencies existed), then every other registered plugin source: a
/// dependency may legitimately live in a different source than the plugin that
/// needs it, and refusing to look there would strand an install the merged catalog
/// can plainly satisfy.
///
/// Always goes through `install_descriptor`, never `detail` — that is the seam
/// that runs the ed25519 signature verification and the fail-closed ui_code
/// integrity gate. Returns the ACTIVE source's failure (status + message) when no
/// source can serve the id.
///
/// Tracked in the global download center. This resolve is the whole network cost
/// of installing or updating an app/plugin — it fans out across catalog sources
/// and pulls the manifest plus the (potentially large) `ui_code` bundle — and it
/// was previously invisible: the Store button spun, the Downloads page stayed
/// empty. Wrapping it HERE rather than in each handler means the dependency
/// closure gets a row per plugin too, so a plugin that pulls three dependencies
/// shows four rows instead of one opaque stall.
///
/// One row per plugin id (`plugin:<id>`), so a retry dedups onto the same row.
///
/// `channel` names the release train to resolve on (`None`/`stable` = the ordinary
/// published version). It is honoured only by a source that actually publishes
/// trains; anything else REFUSES a named prerelease channel rather than serving
/// its stable build under a beta label ([`crate::catalog_source::Source::install_descriptor_at`]).
/// Note that it applies to the id being resolved and is deliberately NOT inherited
/// by that plugin's dependencies: a dependency is its own listing with its own
/// trains, and pulling every dependency onto `nightly` because the target is there
/// would put a user on prereleases they never chose.
pub(in crate::server) async fn resolve_plugin_from_catalog(
    state: &ServerState,
    id: &str,
    buyer_token: Option<String>,
    channel: Option<&str>,
    version: Option<&str>,
) -> Result<
    (
        crate::plugin_manifest::PluginManifest,
        Option<String>,
        crate::plugins::isolation::PluginProvenance,
    ),
    (StatusCode, String),
> {
    let tracked = state
        .downloads
        .register_indeterminate_as(
            format!("plugin:{id}"),
            crate::downloads::DownloadKind::Other,
            crate::downloads::DownloadRole::Plugin,
            id.to_string(),
            async {
                resolve_plugin_from_catalog_inner(state, id, buyer_token, channel, version)
                    .await
                    .map_err(|(status, message)| {
                        anyhow::Error::new(CatalogResolveFailed { status, message })
                    })
            },
        )
        .await;
    let resolved = tracked.map_err(|e| match e.downcast::<CatalogResolveFailed>() {
        Ok(failed) => (failed.status, failed.message),
        // The only other way out is a user Cancel from the download center.
        Err(other) => (StatusCode::CONFLICT, other.to_string()),
    })?;

    // HOST-FLOOR GATE. Every path that pulls a manifest out of the catalog comes
    // through here — a direct install, an update, and the transitive dependency
    // closure of either — so this is the one place that can guarantee a plugin this
    // node cannot run is never written to disk or into the store.
    //
    // Gating at install rather than only at load is what makes the marketplace card
    // honest: the card is SHOWN (see the incompatible lane), and the verb behind it
    // refuses with the specific floor that failed instead of installing something
    // that would silently vanish on next boot.
    //
    // Only BLOCKING entries refuse. A floor against a surface Core cannot observe
    // is advisory and must not stop an install — otherwise every plugin declaring a
    // mobile or island floor would be uninstallable on every node.
    let (manifest, _, _) = &resolved;
    if let Some(engines) = &manifest.engines {
        let verdict = crate::plugin_manifest::node_host_versions().evaluate(Some(engines));
        if !verdict.compatible {
            let detail: Vec<String> = verdict
                .blocking()
                .map(|u| match u {
                    crate::plugin_manifest::UnmetRequirement::TooOld {
                        surface,
                        required,
                        present,
                    } => format!(
                        "{} {required} (this node has {present})",
                        surface.engines_key()
                    ),
                    crate::plugin_manifest::UnmetRequirement::InvalidRequirement {
                        surface,
                        required,
                        reason,
                    } => format!(
                        "{} has an invalid requirement '{required}': {reason}",
                        surface.engines_key()
                    ),
                    crate::plugin_manifest::UnmetRequirement::HostApiTooOld {
                        required,
                        present,
                        ..
                    } => format!("host API {required} (this node serves {present})"),
                    // Not reachable: `Unknown` is never blocking.
                    crate::plugin_manifest::UnmetRequirement::Unknown { surface, required } => {
                        format!("{} {required}", surface.engines_key())
                    }
                })
                .collect();
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "`{}` requires {} — update Ryu to install it",
                    manifest.id,
                    detail.join(", ")
                ),
            ));
        }
    }

    Ok(resolved)
}

/// A catalog resolve failure carried through `anyhow` so the download center can
/// mark the row Failed with the real message while the handler still returns the
/// exact status code it did before.
#[derive(Debug)]
pub(in crate::server) struct CatalogResolveFailed {
    pub(in crate::server) status: StatusCode,
    pub(in crate::server) message: String,
}

impl std::fmt::Display for CatalogResolveFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CatalogResolveFailed {}
