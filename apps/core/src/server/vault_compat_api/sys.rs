//! `/v1/sys/*`: health, seal status, leader, and mount discovery for
//! `vault kv`.
//!
//! `health`, `seal-status`, and `leader` are unauthenticated, as in Vault,
//! and reveal only what Vault reveals there (no cluster ids, storage type, or
//! key versions). A Ryu node is a single active node: it is never a standby,
//! performance standby, or DR secondary, so those status codes are accepted
//! as query overrides but never chosen. A node whose vault store is not
//! installed reports itself uninitialized.

use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};

use super::*;
use crate::server::no_store_response;
use crate::vault::keyring::SealStatus;

/// The version reported where Vault reports its own.
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// What the unauthenticated routes may say about the vault.
struct SealView {
    initialized: bool,
    sealed: bool,
    status: Option<SealStatus>,
}

fn seal_view(state: &CompatState) -> SealView {
    match state.installed() {
        Some(store) => {
            let status = store.keyring.status();
            SealView {
                initialized: true,
                sealed: status.sealed,
                status: Some(status),
            }
        }
        None => SealView {
            initialized: false,
            sealed: true,
            status: None,
        },
    }
}

/// `sys/health` status codes, after query overrides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct HealthCodes {
    pub(super) active: StatusCode,
    pub(super) sealed: StatusCode,
    pub(super) uninit: StatusCode,
}

/// Go's `strconv.ParseBool`, which Vault uses for `standbyok`.
fn go_bool(value: &str) -> Option<bool> {
    match value {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

/// Parse `sys/health`'s query. The first value of each parameter wins, as in
/// Vault; a code that is not an integer HTTP status, or a `standbyok` /
/// `perfstandbyok` that is not a boolean, is a 400. Codes for states a Ryu
/// node never enters (`standbycode`, `drsecondarycode`,
/// `performancestandbycode`, `haunhealthycode`, `removedcode`) are validated
/// and otherwise unused.
pub(super) fn health_codes(query: Option<&str>) -> Result<HealthCodes, ()> {
    let mut codes = HealthCodes {
        active: StatusCode::OK,
        sealed: StatusCode::SERVICE_UNAVAILABLE,
        uninit: StatusCode::NOT_IMPLEMENTED,
    };
    let mut seen = std::collections::BTreeSet::new();
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        if !seen.insert(key.to_string()) {
            continue;
        }
        let code = || {
            value
                .parse::<u16>()
                .ok()
                .and_then(|code| StatusCode::from_u16(code).ok())
                .ok_or(())
        };
        match key.as_ref() {
            "standbyok" | "perfstandbyok" => {
                go_bool(&value).ok_or(())?;
            }
            "activecode" => codes.active = code()?,
            "sealedcode" => codes.sealed = code()?,
            "uninitcode" => codes.uninit = code()?,
            "standbycode"
            | "drsecondarycode"
            | "performancestandbycode"
            | "haunhealthycode"
            | "removedcode" => {
                code()?;
            }
            _ => {}
        }
    }
    Ok(codes)
}

/// Vault's precedence: uninitialized, then sealed, then active.
pub(super) fn health_status(initialized: bool, sealed: bool, codes: HealthCodes) -> StatusCode {
    if !initialized {
        codes.uninit
    } else if sealed {
        codes.sealed
    } else {
        codes.active
    }
}

/// GET|HEAD /v1/sys/health.
#[utoipa::path(get, path = "/v1/sys/health", tag = "Vault",
    operation_id = "vault_compat_sys_health",
    summary = "Vault-compatible health check (unauthenticated; HEAD returns the status only)",
    params(
        ("activecode" = Option<u16>, Query, description = "Status when active and unsealed (default 200)"),
        ("sealedcode" = Option<u16>, Query, description = "Status when sealed (default 503)"),
        ("uninitcode" = Option<u16>, Query, description = "Status when the vault store is not installed (default 501)"),
        ("standbyok" = Option<bool>, Query, description = "Accepted; a Ryu node is never a standby"),
        ("perfstandbyok" = Option<bool>, Query, description = "Accepted; a Ryu node is never a performance standby"),
        ("standbycode" = Option<u16>, Query, description = "Validated; never used (default 429)"),
        ("drsecondarycode" = Option<u16>, Query, description = "Validated; never used (default 472)"),
        ("performancestandbycode" = Option<u16>, Query, description = "Validated; never used (default 473)"),
    ),
    responses(
        (status = 200, description = "Initialized, unsealed, and active", body = serde_json::Value),
        (status = 400, description = "Malformed status-code override", body = serde_json::Value),
        (status = 501, description = "Not initialized (no vault store)", body = serde_json::Value),
        (status = 503, description = "Sealed", body = serde_json::Value),
    ))]
pub(crate) async fn sys_health(
    State(state): State<CompatState>,
    RawQuery(query): RawQuery,
) -> Response {
    let Ok(codes) = health_codes(query.as_deref()) else {
        return errors(StatusCode::BAD_REQUEST, "");
    };
    let view = seal_view(&state);
    let status = health_status(view.initialized, view.sealed, codes);
    let body = json!({
        "initialized": view.initialized,
        "sealed": view.sealed,
        // Vault reports a node that is not serving (sealed or uninitialized)
        // as a standby.
        "standby": view.sealed,
        "performance_standby": false,
        "replication_performance_mode": "disabled",
        "replication_dr_mode": "disabled",
        "server_time_utc": Utc::now().timestamp(),
        "version": VERSION,
        "enterprise": false,
    });
    no_store_response((status, Json(body)).into_response())
}

/// GET /v1/sys/seal-status.
#[utoipa::path(get, path = "/v1/sys/seal-status", tag = "Vault",
    operation_id = "vault_compat_sys_seal_status",
    summary = "Vault-compatible seal status (unauthenticated)",
    responses((status = 200, description = "Seal status", body = serde_json::Value)))]
pub(crate) async fn seal_status(State(state): State<CompatState>) -> Response {
    let view = seal_view(&state);
    let (mode, threshold, shares, progress) =
        view.status
            .as_ref()
            .map_or((Value::from("shamir"), 0, 0, 0), |status| {
                (
                    serde_json::to_value(status.mode).unwrap_or_default(),
                    status.threshold,
                    status.shares,
                    status.progress,
                )
            });
    no_store_response(
        Json(json!({
            "type": mode,
            "initialized": view.initialized,
            "sealed": view.sealed,
            "t": threshold,
            "n": shares,
            "progress": progress,
            "nonce": "",
            "version": VERSION,
            "migration": false,
            "recovery_seal": false,
        }))
        .into_response(),
    )
}

/// GET /v1/sys/leader: a Ryu node runs without HA, which `vault status`
/// needs to read after the seal status.
#[utoipa::path(get, path = "/v1/sys/leader", tag = "Vault",
    operation_id = "vault_compat_sys_leader",
    summary = "Vault-compatible HA leader status (unauthenticated; HA is never enabled)",
    responses(
        (status = 200, description = "Leader status", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn leader(State(state): State<CompatState>) -> Response {
    tri!(state.store());
    no_store_response(
        Json(json!({
            "ha_enabled": false,
            "is_self": false,
            "active_time": "0001-01-01T00:00:00Z",
            "leader_address": "",
            "leader_cluster_address": "",
            "performance_standby": false,
            "performance_standby_last_remote_wal": 0,
        }))
        .into_response(),
    )
}

/// GET /v1/sys/internal/ui/mounts/{path}: mount discovery used by `vault kv`.
#[utoipa::path(get, path = "/v1/sys/internal/ui/mounts/{path}", tag = "Vault",
    operation_id = "vault_compat_ui_mount",
    summary = "Report the `secret/` KV v2 mount so `vault kv` picks the v2 format",
    params(("path" = String, Path, description = "Mount and secret path, e.g. `secret/app/db`")),
    responses(
        (status = 200, description = "Mount description", body = serde_json::Value),
        (status = 403, description = "permission denied (or not the `secret/` mount)", body = serde_json::Value),
    ))]
pub(crate) async fn ui_mount(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Response {
    tri!(caller(&state, &headers).await);
    let mount = path.trim_start_matches('/').split('/').next().unwrap_or("");
    if mount != KV_MOUNT {
        return permission_denied();
    }
    envelope(
        Some(json!({
            "path": format!("{KV_MOUNT}/"),
            "type": "kv",
            "description": "Ryu secret vault (KV v2 compatible)",
            "options": { "version": "2" },
        })),
        None,
    )
}
