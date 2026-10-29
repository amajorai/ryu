use super::*;

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::plugin_manifest::PluginManifest;

// ── scaffold_runnable ─────────────────────────────────────────────────────────

pub(super) async fn scaffold_runnable(
    args: Value,
    hot_manifests: Arc<RwLock<Vec<PluginManifest>>>,
) -> Result<Value> {
    let id = args["id"].as_str().ok_or_else(|| anyhow!("missing 'id'"))?;
    let name = args["name"]
        .as_str()
        .ok_or_else(|| anyhow!("missing 'name'"))?;
    let kind_str = args["kind"]
        .as_str()
        .ok_or_else(|| anyhow!("missing 'kind'"))?;
    let version = args["version"]
        .as_str()
        .ok_or_else(|| anyhow!("missing 'version'"))?;
    let _description = args["description"].as_str().map(str::to_owned);
    let permission_grants: Vec<String> = args["permission_grants"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    // Validate semver.
    semver::Version::parse(version)
        .with_context(|| format!("version '{version}' is not valid semver"))?;

    // Parse the kind.
    let kind = parse_runnable_kind(kind_str)?;

    // Check grant before writing.
    check_self_build_grant(id).await?;

    // Build the manifest.
    let runnable_id = format!("{id}.{kind_str}");
    let entry = crate::plugin_manifest::schema::RunnableEntry {
        id: runnable_id.clone(),
        name: name.to_owned(),
        kind,
        config: None,
    };

    let manifest = PluginManifest {
        id: id.to_owned(),
        name: name.to_owned(),
        version: version.to_owned(),
        runnables: vec![entry],
        permission_grants,
        companion: None,
        ..Default::default()
    };

    // Write to disk and hot-reload.
    let app_dir = write_manifest_to_disk(&manifest).await?;
    hot_reload_manifest(manifest.clone(), hot_manifests).await;

    tracing::info!(
        app_id = id,
        app_dir = %app_dir.display(),
        "self-build: scaffold_runnable completed"
    );

    Ok(json!({
        "success": true,
        "app_id": id,
        "path": app_dir.to_string_lossy(),
        "manifest": serde_json::to_value(&manifest).unwrap_or_default(),
        "message": format!("Runnable '{name}' scaffolded and hot-installed. Appears in GET /api/apps immediately.")
    }))
}

// ── install_app_tool ──────────────────────────────────────────────────────────

pub(super) async fn install_app_tool(
    args: Value,
    hot_manifests: Arc<RwLock<Vec<PluginManifest>>>,
    app_store: Arc<crate::plugins::PluginStore>,
) -> Result<Value> {
    let id = args["id"].as_str().ok_or_else(|| anyhow!("missing 'id'"))?;

    // Find manifest in the hot store.
    let manifest = {
        let manifests = hot_manifests.read().await;
        manifests.iter().find(|m| m.id == id).cloned()
    };

    let manifest = match manifest {
        Some(m) => m,
        None => load_and_hot_reload_from_disk(id, Arc::clone(&hot_manifests)).await?,
    };

    // Call the lifecycle install.
    let record = crate::plugins::lifecycle::install_app(&app_store, &manifest)
        .await
        .with_context(|| format!("install failed for '{id}'"))?;

    Ok(json!({
        "success": true,
        "app_id": id,
        "record": serde_json::to_value(&record).unwrap_or_default(),
        "message": format!("App '{id}' v{} installed (disabled). Enable via POST /api/apps/{id}/enable.", manifest.version)
    }))
}

/// Load a manifest from `<plugins>/<id>/` (the canonical `manifest.json`,
/// falling back to the loader's legacy `plugin.json` / `ryu.json` names),
/// hydrate any `code_file` bodies against the plugin's own directory, and
/// hot-load it into the shared store. Shared by `install_app_tool` and
/// `install_tool` so the ordering never drifts.
pub(super) async fn load_and_hot_reload_from_disk(
    id: &str,
    hot_manifests: Arc<RwLock<Vec<PluginManifest>>>,
) -> Result<PluginManifest> {
    let app_dir = validate_write_target(id)?;
    let manifest_path = crate::plugin_manifest::resolve_native_manifest_path(&app_dir)
        .unwrap_or_else(|| app_dir.join(crate::plugin_manifest::MANIFEST_FILE_NAME));
    let raw = std::fs::read_to_string(&manifest_path).with_context(|| {
        format!(
            "plugin '{id}' not found in memory or at {}; scaffold or write it first",
            manifest_path.display()
        )
    })?;
    let mut m: PluginManifest = serde_json::from_str(&raw)
        .with_context(|| format!("invalid plugin manifest for '{id}'"))?;
    crate::plugin_manifest::hydrate_manifest_code_files(&mut m, Some(&app_dir))
        .map_err(|e| anyhow!("{e}"))?;
    hot_reload_manifest(m.clone(), Arc::clone(&hot_manifests)).await;
    Ok(m)
}

// ── write_ryu_json ────────────────────────────────────────────────────────────

pub(super) async fn write_ryu_json(
    args: Value,
    hot_manifests: Arc<RwLock<Vec<PluginManifest>>>,
) -> Result<Value> {
    let app_id = args["app_id"]
        .as_str()
        .ok_or_else(|| anyhow!("missing 'app_id'"))?;
    let manifest_val = args["manifest"]
        .as_object()
        .ok_or_else(|| anyhow!("'manifest' must be a JSON object"))?;

    // Validate that the manifest.id matches app_id (prevent id drift).
    let manifest_id = manifest_val
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("manifest.id is required"))?;
    if manifest_id != app_id {
        return Err(anyhow!(
            "manifest.id '{manifest_id}' must match app_id '{app_id}'"
        ));
    }

    // Check grant before writing.
    check_self_build_grant(app_id).await?;

    // Deserialize and validate as a full PluginManifest.
    let manifest: PluginManifest = serde_json::from_value(Value::Object(manifest_val.clone()))
        .with_context(|| "manifest is not a valid PluginManifest")?;

    // Deserialization only checks the Rust shape. The live loader also enforces
    // plugin-id/path/code-source/capability invariants; hot-replacing a manifest
    // before that canonical validation would create an unvalidated executable
    // surface until restart.
    manifest
        .validate()
        .map_err(|error| anyhow!("manifest validation failed: {error}"))?;

    // Validate semver.
    semver::Version::parse(&manifest.version).with_context(|| {
        format!(
            "manifest.version '{}' is not valid semver",
            manifest.version
        )
    })?;

    // Write to disk and hot-reload. Hydration happens AFTER the write and against
    // the written directory: a self-built manifest may reference its sandbox JS by
    // `code_file`, and those files can only be resolved once the plugin dir exists.
    // Hot-reloading the un-hydrated manifest would put a hook with an empty body into
    // the live registry, which no read site can distinguish from a hook that chose to
    // do nothing.
    let app_dir = write_manifest_to_disk(&manifest).await?;
    let mut hydrated = manifest.clone();
    crate::plugin_manifest::hydrate_manifest_code_files(&mut hydrated, Some(&app_dir))
        .map_err(|e| anyhow!("{e}"))?;
    hot_reload_manifest(hydrated, hot_manifests).await;

    tracing::info!(
        app_id,
        app_dir = %app_dir.display(),
        "self-build: write_ryu_json completed"
    );

    Ok(json!({
        "success": true,
        "app_id": app_id,
        "path": app_dir.to_string_lossy(),
        "message": format!("Manifest written and hot-installed. App '{app_id}' appears in GET /api/apps immediately.")
    }))
}
