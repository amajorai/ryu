//! App lifecycle operations: install, enable, disable, update.
//!
//! Each operation maps to an HTTP handler in `server/mod.rs`.
//!
//! ## Core-vs-Gateway boundary (strict)
//!
//! - **Core** (this module): decides *what runs* (install/enable/disable/update
//!   state transitions, semver compare, persisting lifecycle state).
//! - **Gateway**: decides *what is allowed*. [`enable_app`] calls the Gateway's
//!   `/v1/grants/validate` for each declared grant in the manifest. Core stores
//!   the result but applies **no inline policy** — if the Gateway is unreachable
//!   the enable fails closed (app stays disabled) rather than silently allowing.
//!
//! ## Gateway stub
//!
//! The Gateway-side grant storage/registry is its own Gateway concern. Until the
//! Gateway endpoint is available it can be stubbed to allow-all by setting the
//! env var `RYU_STUB_GRANT_VALIDATION=1`. This keeps the seam explicit so
//! reviewers know exactly where the real Gateway call will land.

use anyhow::Result;
use serde_json::json;

use super::{GrantValidationResult, PluginRecord, PluginStore};
use crate::plugin_manifest::PluginManifest;

/// Env var that stubs the Gateway grant-validation call to "allow all". Set to
/// `1` or `true` in environments where the Gateway is not yet available.
const ENV_STUB_GRANTS: &str = "RYU_STUB_GRANT_VALIDATION";

/// Error returned when an enable fails because the Gateway denied a grant or
/// was unreachable (fail-closed).
#[derive(Debug)]
pub enum EnableError {
    /// The Gateway denied one or more grants. The app stays disabled.
    GrantsDenied { denied: Vec<String> },
    /// The Gateway was unreachable. The app stays disabled (fail-closed).
    GatewayUnreachable { reason: String },
    /// A store or manifest error.
    Other(anyhow::Error),
}

impl std::fmt::Display for EnableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GrantsDenied { denied } => {
                write!(f, "Gateway denied grants: {}", denied.join(", "))
            }
            Self::GatewayUnreachable { reason } => {
                write!(f, "Gateway unreachable (fail-closed): {reason}")
            }
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<anyhow::Error> for EnableError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e)
    }
}

/// Error returned when an update is refused due to a downgrade attempt.
#[derive(Debug)]
pub enum UpdateError {
    /// The new version is older than the installed version and `force = false`.
    Downgrade {
        installed: String,
        requested: String,
    },
    /// A store or semver error.
    Other(anyhow::Error),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Downgrade {
                installed,
                requested,
            } => {
                write!(
                    f,
                    "refusing downgrade from {installed} to {requested}; \
                     pass force=true to override"
                )
            }
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<anyhow::Error> for UpdateError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e)
    }
}

// ── Operations ────────────────────────────────────────────────────────────────

/// Install an app: create a new [`PluginRecord`] with `enabled = false`.
///
/// Fails if the app is already installed. Callers that want idempotent
/// install-or-update should call [`install_app`] then [`update_app`] on
/// `AlreadyExists`.
pub async fn install_app(store: &PluginStore, manifest: &PluginManifest) -> Result<PluginRecord> {
    // Validate semver before persisting (the loader validates it too, but we
    // re-check here so the endpoint never persists a bad version).
    semver::Version::parse(&manifest.version).map_err(|e| {
        anyhow::anyhow!(
            "manifest version '{}' is not valid semver: {e}",
            manifest.version
        )
    })?;

    store
        .insert(&manifest.id, &manifest.version)
        .await
        .map_err(|e| anyhow::anyhow!("install failed: {e}"))
}

/// Enable an app: validate grants via the Gateway, then flip `enabled = true`.
///
/// Fails closed on Gateway errors — the app stays disabled with a clear error.
pub async fn enable_app(
    store: &PluginStore,
    manifest: &PluginManifest,
    gateway_base_url: &str,
    gateway_token: Option<&str>,
    http_client: &reqwest::Client,
) -> Result<PluginRecord, EnableError> {
    // Check that the app is installed.
    let _record = store
        .get(&manifest.id)
        .await
        .map_err(|e| EnableError::Other(e))?
        .ok_or_else(|| {
            EnableError::Other(anyhow::anyhow!("app '{}' is not installed", manifest.id))
        })?;

    // Validate grants via the Gateway (or stub).
    let grants: Vec<String> = manifest.permission_grants.clone();
    let validation = validate_grants_via_gateway(
        &grants,
        &manifest.id,
        gateway_base_url,
        gateway_token,
        http_client,
    )
    .await?;

    if !validation.all_approved {
        return Err(EnableError::GrantsDenied {
            denied: validation.denied,
        });
    }

    store
        .set_enabled(&manifest.id, &validation.approved)
        .await
        .map_err(|e| EnableError::Other(e))?
        .ok_or_else(|| {
            EnableError::Other(anyhow::anyhow!(
                "app '{}' disappeared during enable",
                manifest.id
            ))
        })
}

/// Disable an app: flip `enabled = false` and clear approved grants.
pub async fn disable_app(store: &PluginStore, id: &str) -> Result<PluginRecord> {
    store
        .set_disabled(id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app '{id}' is not installed"))
}

/// Update an app to a new manifest version.
///
/// Refuses a downgrade (new version < installed version) unless `force = true`.
/// Does NOT re-enable a disabled app; the caller must call [`enable_app`] after
/// updating if they want the app active.
pub async fn update_app(
    store: &PluginStore,
    manifest: &PluginManifest,
    force: bool,
) -> Result<PluginRecord, UpdateError> {
    let record = store
        .get(&manifest.id)
        .await
        .map_err(UpdateError::Other)?
        .ok_or_else(|| {
            UpdateError::Other(anyhow::anyhow!("app '{}' is not installed", manifest.id))
        })?;

    let installed_ver = semver::Version::parse(&record.version).map_err(|e| {
        UpdateError::Other(anyhow::anyhow!(
            "installed version '{}' is not valid semver: {e}",
            record.version
        ))
    })?;
    let new_ver = semver::Version::parse(&manifest.version).map_err(|e| {
        UpdateError::Other(anyhow::anyhow!(
            "new version '{}' is not valid semver: {e}",
            manifest.version
        ))
    })?;

    if !force && new_ver < installed_ver {
        return Err(UpdateError::Downgrade {
            installed: record.version.clone(),
            requested: manifest.version.clone(),
        });
    }

    // Same version: no-op, return current record.
    if new_ver == installed_ver {
        return Ok(record);
    }

    store
        .set_version(&manifest.id, &manifest.version)
        .await
        .map_err(UpdateError::Other)?
        .ok_or_else(|| {
            UpdateError::Other(anyhow::anyhow!(
                "app '{}' disappeared during update",
                manifest.id
            ))
        })
}

// ── Gateway grant validation ──────────────────────────────────────────────────

/// Call the Gateway's `/v1/grants/validate` to authorise the grants declared
/// in the manifest.
///
/// ## Stub mode
///
/// When `RYU_STUB_GRANT_VALIDATION=1` is set (or the Gateway endpoint does not
/// yet exist), this function returns an allow-all result. The stub is explicit
/// and logged so it is visible in tests and operator logs. This is the noted
/// seam: full Gateway-side storage is the Gateway's concern.
async fn validate_grants_via_gateway(
    grants: &[String],
    app_id: &str,
    gateway_base_url: &str,
    gateway_token: Option<&str>,
    http_client: &reqwest::Client,
) -> Result<GrantValidationResult, EnableError> {
    // Empty grant list — nothing to validate, always allow.
    if grants.is_empty() {
        return Ok(GrantValidationResult {
            approved: vec![],
            denied: vec![],
            all_approved: true,
        });
    }

    // Stub mode: opt-in allow-all for environments where the Gateway endpoint
    // is not yet available. Always logged at WARN so it is visible.
    if is_stub_mode() {
        tracing::warn!(
            app_id,
            grants = ?grants,
            "grant validation: RYU_STUB_GRANT_VALIDATION=1 — allowing all grants without Gateway check (stub seam)"
        );
        return Ok(GrantValidationResult {
            approved: grants.to_vec(),
            denied: vec![],
            all_approved: true,
        });
    }

    let url = format!(
        "{}/v1/grants/validate",
        gateway_base_url.trim_end_matches('/')
    );

    let body = json!({
        "app_id": app_id,
        "grants": grants,
    });

    let mut req = http_client
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&body);
    if let Some(token) = gateway_token {
        req = req.bearer_auth(token);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| EnableError::GatewayUnreachable {
            reason: e.to_string(),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(EnableError::GatewayUnreachable {
            reason: format!("Gateway returned {status}: {body_text}"),
        });
    }

    let result: serde_json::Value =
        resp.json()
            .await
            .map_err(|e| EnableError::GatewayUnreachable {
                reason: format!("invalid JSON from Gateway: {e}"),
            })?;

    // Parse Gateway response. Expected shape:
    // { "approved": [...], "denied": [...] }
    let approved: Vec<String> = result
        .get("approved")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let denied: Vec<String> = result
        .get("denied")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let all_approved = denied.is_empty();

    Ok(GrantValidationResult {
        approved,
        denied,
        all_approved,
    })
}

fn is_stub_mode() -> bool {
    match std::env::var(ENV_STUB_GRANTS) {
        Ok(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::schema::RunnableEntry;
    use crate::plugin_manifest::PluginManifest;
    use crate::runnable::RunnableKind;

    fn make_manifest(id: &str, version: &str, grants: Vec<&str>) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: "Test App".to_owned(),
            version: version.to_owned(),
            runnables: vec![RunnableEntry {
                id: "agent-x".to_owned(),
                name: "Agent X".to_owned(),
                kind: RunnableKind::Agent,
                config: None,
            }],
            permission_grants: grants.into_iter().map(str::to_owned).collect(),
            companion: None,
            ..Default::default()
        }
    }

    fn store() -> PluginStore {
        PluginStore::open_in_memory().unwrap()
    }

    // ── install ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn install_creates_disabled_record() {
        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec![]);
        let rec = install_app(&s, &m).await.unwrap();
        assert_eq!(rec.id, "com.test.app");
        assert_eq!(rec.version, "1.0.0");
        assert!(!rec.enabled);
    }

    #[tokio::test]
    async fn install_rejects_invalid_semver() {
        let s = store();
        let m = make_manifest("com.test.app", "not-semver", vec![]);
        assert!(install_app(&s, &m).await.is_err());
    }

    // ── enable (stub mode) ─────────────────────────────────────────────────────

    /// Serialize the tests that mutate the process-global `RYU_STUB_GRANT_VALIDATION`
    /// env var. Rust runs tests in parallel, so without this they clobber each
    /// other's save/restore and one sees the var cleared mid-flight — falling
    /// through to a real Gateway call (127.0.0.1:7981) that is not running. The
    /// function-local `static` is a single shared lock; hold the guard for the
    /// whole test body (fine under the current-thread `#[tokio::test]` runtime).
    fn stub_grants_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[tokio::test]
    async fn enable_in_stub_mode_allows_all_grants() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec!["mcp:web_search"]);
        install_app(&s, &m).await.unwrap();

        let client = reqwest::Client::new();
        let rec = enable_app(&s, &m, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();
        assert!(rec.enabled);
        assert_eq!(rec.approved_grants, vec!["mcp:web_search"]);

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    #[tokio::test]
    async fn enable_uninstalled_app_fails() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec![]);
        let client = reqwest::Client::new();
        let result = enable_app(&s, &m, "http://127.0.0.1:7981", None, &client).await;
        assert!(result.is_err(), "enable of uninstalled app should fail");

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    // ── disable ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn disable_clears_state() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec!["mcp:web_search"]);
        install_app(&s, &m).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(&s, &m, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();

        let rec = disable_app(&s, "com.test.app").await.unwrap();
        assert!(!rec.enabled);
        assert!(rec.approved_grants.is_empty());

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    // ── update / semver ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn update_same_version_is_noop() {
        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec![]);
        install_app(&s, &m).await.unwrap();
        let rec = update_app(&s, &m, false).await.unwrap();
        assert_eq!(rec.version, "1.0.0");
    }

    #[tokio::test]
    async fn update_newer_version_succeeds() {
        let s = store();
        install_app(&s, &make_manifest("com.test.app", "1.0.0", vec![]))
            .await
            .unwrap();
        let m2 = make_manifest("com.test.app", "2.0.0", vec![]);
        let rec = update_app(&s, &m2, false).await.unwrap();
        assert_eq!(rec.version, "2.0.0");
    }

    #[tokio::test]
    async fn update_older_version_refused_without_force() {
        let s = store();
        install_app(&s, &make_manifest("com.test.app", "2.0.0", vec![]))
            .await
            .unwrap();
        let m_old = make_manifest("com.test.app", "1.0.0", vec![]);
        let result = update_app(&s, &m_old, false).await;
        assert!(
            matches!(result, Err(UpdateError::Downgrade { .. })),
            "should refuse downgrade without force"
        );
    }

    #[tokio::test]
    async fn update_older_version_allowed_with_force() {
        let s = store();
        install_app(&s, &make_manifest("com.test.app", "2.0.0", vec![]))
            .await
            .unwrap();
        let m_old = make_manifest("com.test.app", "1.0.0", vec![]);
        let rec = update_app(&s, &m_old, true).await.unwrap();
        assert_eq!(rec.version, "1.0.0");
    }
}
