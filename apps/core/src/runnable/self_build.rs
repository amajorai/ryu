//! Self-building agent tools: scaffold_runnable, write_ryu_json, install_app.
//!
//! These tools let an agent in chat author or modify a Runnable or App manifest
//! and hot-install it via the loader so it appears in `GET /api/apps` without
//! restart. They are exposed through the MCP registry using the same in-process
//! built-in pattern as the Shadow provider.
//!
//! # Core-vs-Gateway placement
//!
//! Deciding *what runs* (scaffold, write, install) is Core. Deciding *whether an
//! agent is allowed* to write a new Runnable is a Gateway grant — mirrors the
//! `enable_app` pattern where Core calls `/v1/grants/validate`. Until the
//! Gateway endpoint exists, the grant check is stubbed behind
//! `RYU_STUB_SELF_BUILD_GRANTS=1` (same pattern as `RYU_STUB_GRANT_VALIDATION`).
//!
//! # Write confinement
//!
//! All writes are canonicalized and confined to the Ryu apps dir (resolved via
//! `PluginManifestLoader::plugins_dir()`). Any path that escapes confinement (traversal,
//! absolute ids, symlink escape) is rejected with a 403-equivalent error. See
//! `validate_write_target` for the exact checks.
//!
//! # Spike AC#2 finding (ACP tool-loop integration)
//!
//! See `docs/spikes/0171-self-building-agents.md` for the full validation.
//! Short form: the MCP bridge (`sidecar/adapters/mcp_bridge.rs`) successfully
//! injects these tools into ACP sessions via `with_mcp_server`. The ACP agent
//! calls them through the standard `SessionUpdate::ToolCall` / `ToolCallUpdate`
//! path — `call_tool` here is invoked from `McpRegistry::call_tool` which is
//! invoked by the bridge's `call_tool` handler. The round-trip (call → execute →
//! result → continue) works provided the ACP agent chooses to call an injected
//! tool rather than a built-in. The remaining gap (#17) is that ACP agents may
//! prefer their own native tools; surfacing self-build tools in agent instructions
//! is a UX concern, not a wiring gap.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::plugin_manifest::{PluginManifest, PluginManifestLoader};
use crate::sidecar::mcp::RegistryTool;

/// Reserved server name for the self-build tool provider. Must not contain
/// `__` (the tool-id separator). A user MCP config entry with this name
/// would collide, so the registry treats it as reserved.
pub const SERVER_NAME: &str = "ryu_self_build";

/// Env var that stubs the Gateway grant check for self-build operations.
/// Set to `1` or `true` in environments where the Gateway is not yet available.
const ENV_STUB_GRANTS: &str = "RYU_STUB_SELF_BUILD_GRANTS";

// ── Tool definitions ──────────────────────────────────────────────────────────

/// The tools exposed through the self-build provider. Each maps to a
/// `dispatch` branch below.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: "ryu_self_build__scaffold_runnable".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "scaffold_runnable".to_owned(),
            description: Some(
                "Scaffold a new Runnable (agent, workflow, skill, tool) and write its \
                 ryu.json manifest to the Ryu apps directory. The manifest is hot-installed \
                 so it appears in GET /api/apps without restarting Core. \
                 Required: id (reverse-domain, e.g. com.example.my-agent), name, kind \
                 (agent|workflow|skill|tool|companion|channel|engine|policy), version (semver). \
                 Optional: description, permission_grants (list of grant strings)."
                    .to_owned(),
            ),
            input_schema: Some(scaffold_runnable_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: "ryu_self_build__install_app".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "install_app".to_owned(),
            description: Some(
                "Install (register as installed) a Runnable app that has already been \
                 scaffolded via scaffold_runnable. Creates a lifecycle record so the app \
                 appears as installed in GET /api/apps. Requires the app to exist as a \
                 ryu.json in the apps directory. Required: id (the app's reverse-domain id)."
                    .to_owned(),
            ),
            input_schema: Some(install_app_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: "ryu_self_build__write_ryu_json".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "write_ryu_json".to_owned(),
            description: Some(
                "Write an arbitrary ryu.json manifest object to a named app directory \
                 under the Ryu apps dir and hot-reload it. Use this for advanced manifests \
                 that scaffold_runnable cannot express (e.g. multi-runnable bundles, companions). \
                 The id field in the manifest must match the app_id parameter. \
                 Required: app_id (reverse-domain, used as the directory name), manifest (JSON object)."
                    .to_owned(),
            ),
            input_schema: Some(write_ryu_json_schema()),
            ..Default::default()
        },
    ]
}

fn scaffold_runnable_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "Reverse-domain app id (e.g. com.example.my-agent). Used as the directory name."
            },
            "name": { "type": "string", "description": "Human-readable display name." },
            "kind": {
                "type": "string",
                "enum": ["agent", "workflow", "skill", "tool", "companion", "channel", "engine", "policy"],
                "description": "Runnable kind."
            },
            "version": {
                "type": "string",
                "description": "Semver version string (e.g. 1.0.0)."
            },
            "description": {
                "type": "string",
                "description": "Optional human-readable description of what this Runnable does."
            },
            "permission_grants": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Optional list of permission grant strings the app declares it needs."
            }
        },
        "required": ["id", "name", "kind", "version"]
    })
}

fn install_app_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "The reverse-domain app id to install (must have a ryu.json on disk)."
            }
        },
        "required": ["id"]
    })
}

fn write_ryu_json_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "app_id": {
                "type": "string",
                "description": "Reverse-domain app id (used as the subdirectory name). Must match manifest.id."
            },
            "manifest": {
                "type": "object",
                "description": "Full ryu.json manifest object. Must include id, name, version, runnables."
            }
        },
        "required": ["app_id", "manifest"]
    })
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/// Dispatch a tool call from the MCP registry to the correct self-build handler.
///
/// `hot_manifests` is the shared mutable manifest store — mutations here are
/// immediately visible to `GET /api/apps` without restarting Core.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    hot_manifests: Arc<RwLock<Vec<PluginManifest>>>,
    app_store: Arc<crate::plugins::PluginStore>,
) -> Result<Value> {
    match tool {
        "scaffold_runnable" => scaffold_runnable(arguments, hot_manifests).await,
        "install_app" => install_app_tool(arguments, hot_manifests, app_store).await,
        "write_ryu_json" => write_ryu_json(arguments, hot_manifests).await,
        other => Err(anyhow!("unknown self-build tool: '{other}'")),
    }
}

// ── scaffold_runnable ─────────────────────────────────────────────────────────

async fn scaffold_runnable(
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

async fn install_app_tool(
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
        None => {
            // Try loading from disk as fallback. Prefer the canonical
            // `manifest.json`, fall back to the legacy `plugin.json` / `ryu.json`.
            // The ordering is shared with the loader — do NOT re-spell it here.
            let app_dir = validate_write_target(id)?;
            let manifest_path = crate::plugin_manifest::MANIFEST_FILE_NAMES
                .iter()
                .map(|name| app_dir.join(name))
                .find(|p| p.exists())
                .unwrap_or_else(|| app_dir.join(crate::plugin_manifest::MANIFEST_FILE_NAME));
            let raw = std::fs::read_to_string(&manifest_path).with_context(|| {
                format!(
                    "plugin '{id}' not found in memory or at {}; scaffold it first",
                    manifest_path.display()
                )
            })?;
            let m: PluginManifest = serde_json::from_str(&raw)
                .with_context(|| format!("invalid plugin manifest for '{id}'"))?;
            // Hot-load into memory.
            hot_reload_manifest(m.clone(), Arc::clone(&hot_manifests)).await;
            m
        }
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

// ── write_ryu_json ────────────────────────────────────────────────────────────

async fn write_ryu_json(
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

    // Validate semver.
    semver::Version::parse(&manifest.version).with_context(|| {
        format!(
            "manifest.version '{}' is not valid semver",
            manifest.version
        )
    })?;

    // Write to disk and hot-reload.
    let app_dir = write_manifest_to_disk(&manifest).await?;
    hot_reload_manifest(manifest.clone(), hot_manifests).await;

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

// ── Write confinement ─────────────────────────────────────────────────────────

/// Validate and return the write target directory for an app id.
///
/// Confinement rules:
/// 1. `id` must not be empty.
/// 2. `id` must not be an absolute path or contain path separators.
/// 3. The canonical target must be a subdirectory of `apps_dir()`.
/// 4. Symlinks that escape the apps dir are rejected.
///
/// On success returns the (not-yet-created) `<apps_dir>/<id>` path.
pub fn validate_write_target(id: &str) -> Result<PathBuf> {
    if id.is_empty() {
        return Err(anyhow!("app id must not be empty"));
    }

    // Reject absolute paths and path-separator characters to prevent traversal.
    if id.starts_with('/') || id.starts_with('\\') || id.starts_with('.') {
        return Err(anyhow!(
            "app id '{id}' must not start with a path separator or dot"
        ));
    }
    if id.contains('/') || id.contains('\\') {
        return Err(anyhow!("app id '{id}' must not contain path separators"));
    }
    if id.contains("..") {
        return Err(anyhow!("app id '{id}' must not contain '..'"));
    }

    let apps_dir = PluginManifestLoader::plugins_dir();
    let target = apps_dir.join(id);

    // If the apps_dir itself doesn't exist yet, we'll create it during write;
    // but the path join is sufficient for confinement checks as long as the id
    // has no traversal components (checked above).
    //
    // If the target already exists, canonicalize and verify confinement.
    if target.exists() {
        let canonical_apps = apps_dir.canonicalize().unwrap_or_else(|_| apps_dir.clone());
        let canonical_target = target.canonicalize().unwrap_or_else(|_| target.clone());
        if !canonical_target.starts_with(&canonical_apps) {
            return Err(anyhow!(
                "app id '{id}' resolves outside the Ryu apps directory (traversal rejected)"
            ));
        }
    }

    Ok(target)
}

// ── Disk write ────────────────────────────────────────────────────────────────

/// Write a manifest to `<plugins_dir>/<manifest.id>/manifest.json` atomically.
/// Creates the directory if it does not exist.
/// Returns the `<plugins_dir>/<manifest.id>` directory path.
async fn write_manifest_to_disk(manifest: &PluginManifest) -> Result<PathBuf> {
    let app_dir = validate_write_target(&manifest.id)?;
    let manifest_path = app_dir.join(crate::plugin_manifest::MANIFEST_FILE_NAME);

    let json_bytes = serde_json::to_vec_pretty(manifest).context("serializing manifest to JSON")?;

    // Atomic write: tmp file then rename. Uses write_secret_file for 0o600 on Unix.
    let tmp_path = app_dir.with_extension("ryu.json.tmp");
    tokio::task::spawn_blocking({
        let app_dir = app_dir.clone();
        let tmp_path = tmp_path.clone();
        let manifest_path = manifest_path.clone();
        move || {
            std::fs::create_dir_all(&app_dir)
                .with_context(|| format!("creating app dir {}", app_dir.display()))?;
            write_secret_file(&tmp_path, &json_bytes)?;
            std::fs::rename(&tmp_path, &manifest_path)
                .with_context(|| format!("renaming tmp to {}", manifest_path.display()))?;
            Ok::<_, anyhow::Error>(())
        }
    })
    .await
    .context("write task panicked")??;

    Ok(app_dir)
}

/// Write `data` to `path` with 0o600 permissions on Unix, or plain write on Windows.
fn write_secret_file(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write as _;

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .with_context(|| format!("opening {} for write", path.display()))?;
    f.write_all(data)
        .with_context(|| format!("writing to {}", path.display()))?;
    f.sync_all()
        .with_context(|| format!("syncing {}", path.display()))?;
    Ok(())
}

// ── Hot-reload ────────────────────────────────────────────────────────────────

/// Insert or replace the manifest in the shared hot store. A manifest with the
/// same `id` is replaced; a new id is appended.
async fn hot_reload_manifest(manifest: PluginManifest, store: Arc<RwLock<Vec<PluginManifest>>>) {
    let mut manifests = store.write().await;
    if let Some(pos) = manifests.iter().position(|m| m.id == manifest.id) {
        manifests[pos] = manifest;
    } else {
        manifests.push(manifest);
    }
}

// ── Grant check ──────────────────────────────────────────────────────────────

/// Check that the calling agent has the `self_build:write` grant. In stub mode
/// (`RYU_STUB_SELF_BUILD_GRANTS=1`) this always succeeds (logged at WARN).
async fn check_self_build_grant(app_id: &str) -> Result<()> {
    if is_stub_mode() {
        tracing::warn!(
            app_id,
            "self-build grant check: RYU_STUB_SELF_BUILD_GRANTS=1 — \
             bypassing Gateway grant validation (stub seam; \
             real grant: 'self_build:write' via /v1/grants/validate)"
        );
        return Ok(());
    }

    // Real grant validation: call the Gateway just like enable_app does.
    // The grant required is "self_build:write". Until the Gateway ships
    // this endpoint, set RYU_STUB_SELF_BUILD_GRANTS=1 to bypass.
    let gateway_url =
        std::env::var("RYU_GATEWAY_URL").unwrap_or_else(|_| "http://127.0.0.1:9090".to_owned());

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{gateway_url}/v1/grants/validate"))
        .timeout(std::time::Duration::from_secs(5))
        .json(&json!({
            "app_id": app_id,
            "grants": ["self_build:write"]
        }))
        .send()
        .await
        .map_err(|e| {
            anyhow!(
                "Gateway unreachable for self_build grant check (fail-closed): {e}. \
                 Set RYU_STUB_SELF_BUILD_GRANTS=1 to bypass in dev."
            )
        })?;

    if !resp.status().is_success() {
        return Err(anyhow!(
            "Gateway denied self_build:write grant (HTTP {}). \
             The agent must be granted 'self_build:write' before scaffolding.",
            resp.status()
        ));
    }

    Ok(())
}

fn is_stub_mode() -> bool {
    match std::env::var(ENV_STUB_GRANTS) {
        Ok(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        Err(_) => false,
    }
}

// ── Kind parsing ──────────────────────────────────────────────────────────────

fn parse_runnable_kind(s: &str) -> Result<crate::runnable::RunnableKind> {
    use crate::runnable::RunnableKind;
    match s {
        "agent" => Ok(RunnableKind::Agent),
        "workflow" => Ok(RunnableKind::Workflow),
        "tool" => Ok(RunnableKind::Tool),
        "skill" => Ok(RunnableKind::Skill),
        "companion" => Ok(RunnableKind::Companion),
        "channel" => Ok(RunnableKind::Channel),
        "engine" => Ok(RunnableKind::Engine),
        "policy" => Ok(RunnableKind::Policy),
        other => Err(anyhow!(
            "unknown runnable kind '{other}'; valid: agent, workflow, tool, skill, companion, channel, engine, policy"
        )),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_write_target_rejects_traversal() {
        assert!(validate_write_target("../escape").is_err());
        assert!(validate_write_target("/absolute").is_err());
        assert!(validate_write_target("a/b").is_err());
        assert!(validate_write_target("a\\b").is_err());
        assert!(validate_write_target("").is_err());
        assert!(validate_write_target("..").is_err());
    }

    #[test]
    fn validate_write_target_accepts_valid_id() {
        let result = validate_write_target("com.example.my-agent");
        assert!(result.is_ok(), "valid id should be accepted: {result:?}");
        let path = result.unwrap();
        assert!(path.ends_with("com.example.my-agent"));
    }

    #[test]
    fn parse_runnable_kind_round_trips() {
        use crate::runnable::RunnableKind;
        assert!(matches!(
            parse_runnable_kind("agent"),
            Ok(RunnableKind::Agent)
        ));
        assert!(matches!(
            parse_runnable_kind("workflow"),
            Ok(RunnableKind::Workflow)
        ));
        assert!(parse_runnable_kind("unknown").is_err());
    }

    #[test]
    fn tools_are_listed_with_correct_server() {
        let ts = tools();
        assert_eq!(ts.len(), 3);
        for t in &ts {
            assert_eq!(t.server, SERVER_NAME);
            assert!(t.id.starts_with("ryu_self_build__"));
        }
    }

    #[tokio::test]
    async fn hot_reload_inserts_and_replaces() {
        let store = Arc::new(RwLock::new(vec![]));
        let m1 = PluginManifest {
            id: "com.test.app".into(),
            name: "Test".into(),
            version: "1.0.0".into(),
            runnables: vec![],
            permission_grants: vec![],
            companion: None,
            ..Default::default()
        };
        hot_reload_manifest(m1.clone(), Arc::clone(&store)).await;
        {
            let r = store.read().await;
            assert_eq!(r.len(), 1);
        }

        let m2 = PluginManifest {
            id: "com.test.app".into(),
            name: "Test v2".into(),
            version: "2.0.0".into(),
            runnables: vec![],
            permission_grants: vec![],
            companion: None,
            ..Default::default()
        };
        hot_reload_manifest(m2, Arc::clone(&store)).await;
        {
            let r = store.read().await;
            assert_eq!(r.len(), 1);
            assert_eq!(r[0].version, "2.0.0");
        }
    }
}
