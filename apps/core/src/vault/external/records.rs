//! External-store schema, input validation, and row mapping.
//!
//! Split out of [`super`], which re-exports the public items at their
//! original paths.
//!
//! test-exempt: code moved verbatim out of `mod.rs`; exercised by vault/external/tests.rs (store_input_is_validated) and the k8s_origin_tests.

use super::*;

/// Create the external-store tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_external_stores (
             id                    TEXT PRIMARY KEY,
             name                  TEXT NOT NULL UNIQUE,
             kind                  TEXT NOT NULL,
             address               TEXT NOT NULL,
             namespace             TEXT,
             auth_method           TEXT NOT NULL,
             auth_mount            TEXT,
             role                  TEXT,
             mount                 TEXT NOT NULL DEFAULT '',
             path_prefix           TEXT NOT NULL DEFAULT '',
             kv_version            INTEGER NOT NULL DEFAULT 2,
             project_id            TEXT NOT NULL DEFAULT '',
             infisical_environment TEXT NOT NULL DEFAULT '',
             secret_path           TEXT NOT NULL DEFAULT '/',
             nonce                 BLOB NOT NULL,
             ciphertext            BLOB NOT NULL,
             key_version           INTEGER NOT NULL DEFAULT 0,
             created_at            INTEGER NOT NULL,
             updated_at            INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_external_sources (
             id                  TEXT PRIMARY KEY,
             store_id            TEXT NOT NULL,
             environment         TEXT NOT NULL,
             path                TEXT NOT NULL,
             remote_path         TEXT NOT NULL DEFAULT '',
             mode                TEXT NOT NULL,
             scope_id            TEXT NOT NULL,
             cache_ttl_secs      INTEGER NOT NULL,
             stale_if_error_secs INTEGER NOT NULL DEFAULT 0,
             sync_interval_secs  INTEGER NOT NULL,
             last_sync_at        INTEGER,
             last_status         TEXT,
             last_error          TEXT,
             last_count          INTEGER NOT NULL DEFAULT 0,
             created_at          INTEGER NOT NULL,
             UNIQUE (scope_id, environment, path)
         );
         CREATE TABLE IF NOT EXISTS vault_external_destinations (
             id            TEXT PRIMARY KEY,
             store_id      TEXT NOT NULL,
             environment   TEXT NOT NULL,
             path          TEXT NOT NULL,
             remote_path   TEXT NOT NULL DEFAULT '',
             scope_id      TEXT NOT NULL,
             interval_secs INTEGER NOT NULL,
             dirty         INTEGER NOT NULL DEFAULT 1,
             last_push_at  INTEGER,
             last_status   TEXT,
             last_error    TEXT,
             last_count    INTEGER NOT NULL DEFAULT 0,
             failures      INTEGER NOT NULL DEFAULT 0,
             created_at    INTEGER NOT NULL,
             UNIQUE (store_id, remote_path)
         );",
    )
    .context("initializing external-store schema")
}

// ── Validation ────────────────────────────────────────────────────────────

/// Store names: `^[a-z0-9][a-z0-9_-]{0,63}$`.
pub fn is_valid_store_name(name: &str) -> bool {
    crate::vault::transit::is_valid_key_name(name)
}

pub(super) fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

pub(super) fn bounded(value: Option<String>, field: &str) -> Result<Option<String>> {
    match value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
        Some(v) if v.len() > MAX_FIELD_LEN || v.chars().any(char::is_control) => {
            Err(invalid(format!("`{field}` is invalid")))
        }
        other => Ok(other),
    }
}

/// Normalize a remote path (`a/b`), validating every segment.
pub(super) fn normalize_remote(value: &str) -> Result<String> {
    client::join_remote_path(&[value])
        .map(|segments| segments.join("/"))
        .map_err(|error| invalid(error.to_string()))
}

pub(super) fn validate_store(input: StoreInput) -> Result<(StoreRecord, StoreCredentials)> {
    if !is_valid_store_name(&input.name) {
        return Err(invalid("invalid store name"));
    }
    if input.address.len() > MAX_ADDRESS_LEN {
        return Err(invalid("address is too long"));
    }
    let address = net::validate_address(&input.address, net::Egress::from_env())
        .map_err(|error| invalid(error.to_string()))?;
    let infisical = input.kind == StoreKind::Infisical;
    let allowed = if infisical {
        matches!(
            input.auth_method,
            AuthMethod::Token | AuthMethod::UniversalAuth
        )
    } else {
        matches!(
            input.auth_method,
            AuthMethod::Token | AuthMethod::Approle | AuthMethod::Kubernetes
        )
    };
    if !allowed {
        return Err(invalid(format!(
            "{} does not support {} auth",
            input.kind.as_str(),
            input.auth_method.as_str()
        )));
    }
    let credentials = input.credentials;
    let complete = match input.auth_method {
        AuthMethod::Token => filled(&credentials.token),
        AuthMethod::Approle => filled(&credentials.role_id) && filled(&credentials.secret_id),
        AuthMethod::UniversalAuth => {
            filled(&credentials.client_id) && filled(&credentials.client_secret)
        }
        AuthMethod::Kubernetes => filled(&input.role),
    };
    if !complete {
        return Err(invalid(format!(
            "{} auth is missing its credentials",
            input.auth_method.as_str()
        )));
    }
    if filled(&input.jwt_path) {
        return Err(invalid(format!(
            "`jwtPath` is not accepted; set {} on the Core host instead",
            client::ENV_K8S_JWT_PATH
        )));
    }
    if input.auth_method == AuthMethod::Kubernetes {
        k8s_origin::check(&address).map_err(|error| invalid(error.to_string()))?;
    }
    let namespace = bounded(input.namespace, "namespace")?;
    if let Some(ns) = &namespace {
        normalize_remote(ns)?;
    }
    let auth_mount = bounded(input.auth_mount, "authMount")?
        .map(|mount| normalize_remote(&mount))
        .transpose()?;
    let kv_version = input.kv_version.unwrap_or(2);
    if !matches!(kv_version, 1 | 2) {
        return Err(invalid("`kvVersion` must be 1 or 2"));
    }
    let mount = normalize_remote(input.mount.as_deref().unwrap_or("secret"))?;
    if !infisical && mount.is_empty() {
        return Err(invalid("`mount` is required"));
    }
    let project_id = bounded(input.project_id, "projectId")?.unwrap_or_default();
    let infisical_environment =
        bounded(input.infisical_environment, "infisicalEnvironment")?.unwrap_or_default();
    if infisical && (project_id.is_empty() || infisical_environment.is_empty()) {
        return Err(invalid(
            "Infisical stores need `projectId` and `infisicalEnvironment`",
        ));
    }
    let now = now_millis();
    Ok((
        StoreRecord {
            id: format!("xs_{}", uuid::Uuid::new_v4().simple()),
            name: input.name,
            kind: input.kind,
            address: address.as_str().trim_end_matches('/').to_owned(),
            namespace,
            auth_method: input.auth_method,
            auth_mount,
            role: bounded(input.role, "role")?,
            mount,
            path_prefix: normalize_remote(input.path_prefix.as_deref().unwrap_or(""))?,
            kv_version,
            project_id,
            infisical_environment,
            secret_path: normalize_remote(input.secret_path.as_deref().unwrap_or("/"))?,
            created_at: now,
            updated_at: now,
        },
        credentials,
    ))
}

pub(super) fn folder(environment: &str, path: &str) -> Result<(String, String)> {
    if !is_valid_environment(environment) {
        return Err(invalid("invalid environment"));
    }
    let path = normalize_path(path).ok_or_else(|| invalid("invalid folder path"))?;
    Ok((environment.to_owned(), path))
}

pub(super) fn in_range(
    value: Option<i64>,
    default: i64,
    min: i64,
    max: i64,
    field: &str,
) -> Result<i64> {
    let value = value.unwrap_or(default);
    if value < min || value > max {
        return Err(invalid(format!(
            "`{field}` must be between {min} and {max}"
        )));
    }
    Ok(value)
}

// ── Rows ──────────────────────────────────────────────────────────────────

pub(super) const STORE_COLUMNS: &str =
    "id, name, kind, address, namespace, auth_method, auth_mount, role,
    mount, path_prefix, kv_version, project_id, infisical_environment, secret_path,
    created_at, updated_at";

pub(super) fn store_from_row(row: &Row<'_>) -> rusqlite::Result<Option<StoreRecord>> {
    let (Some(kind), Some(auth_method)) = (
        StoreKind::parse(&row.get::<_, String>(2)?),
        AuthMethod::parse(&row.get::<_, String>(5)?),
    ) else {
        return Ok(None);
    };
    Ok(Some(StoreRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        kind,
        address: row.get(3)?,
        namespace: row.get(4)?,
        auth_method,
        auth_mount: row.get(6)?,
        role: row.get(7)?,
        mount: row.get(8)?,
        path_prefix: row.get(9)?,
        kv_version: row.get(10)?,
        project_id: row.get(11)?,
        infisical_environment: row.get(12)?,
        secret_path: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    }))
}

pub(super) const SOURCE_COLUMNS: &str =
    "id, store_id, environment, path, remote_path, mode, scope_id,
    cache_ttl_secs, stale_if_error_secs, sync_interval_secs, last_sync_at, last_status,
    last_error, last_count, created_at";

pub(super) fn source_from_row(row: &Row<'_>) -> rusqlite::Result<SourceRecord> {
    let mode: String = row.get(5)?;
    Ok(SourceRecord {
        id: row.get(0)?,
        store_id: row.get(1)?,
        environment: row.get(2)?,
        path: row.get(3)?,
        remote_path: row.get(4)?,
        mode: if mode == "sync" {
            SourceMode::Sync
        } else {
            SourceMode::Live
        },
        scope_id: row.get(6)?,
        cache_ttl_secs: row.get(7)?,
        stale_if_error_secs: row.get(8)?,
        sync_interval_secs: row.get(9)?,
        last_sync_at: row.get(10)?,
        last_status: row.get(11)?,
        last_error: row.get(12)?,
        last_count: row.get(13)?,
        created_at: row.get(14)?,
    })
}

pub(super) const DESTINATION_COLUMNS: &str =
    "id, store_id, environment, path, remote_path, scope_id,
    interval_secs, dirty, last_push_at, last_status, last_error, last_count, created_at,
    failures";

pub(super) fn destination_from_row(row: &Row<'_>) -> rusqlite::Result<DestinationRecord> {
    Ok(DestinationRecord {
        id: row.get(0)?,
        store_id: row.get(1)?,
        environment: row.get(2)?,
        path: row.get(3)?,
        remote_path: row.get(4)?,
        scope_id: row.get(5)?,
        interval_secs: row.get(6)?,
        dirty: row.get::<_, i64>(7)? != 0,
        last_push_at: row.get(8)?,
        last_status: row.get(9)?,
        last_error: row.get(10)?,
        last_count: row.get(11)?,
        created_at: row.get(12)?,
        failures: row.get(13)?,
    })
}

/// Milliseconds to wait before retrying a destination after `failures`
/// consecutive failures: one loop tick, doubling, capped at its interval.
pub(super) fn retry_backoff_ms(failures: i64, interval_secs: i64) -> i64 {
    let tick_ms = LOOP_TICK.as_millis() as i64;
    let exponent = (failures - 1).clamp(0, 20) as u32;
    tick_ms
        .saturating_mul(1_i64 << exponent)
        .min(interval_secs.saturating_mul(1000))
}

/// Whether the loop should push `destination` at `now`.
pub(super) fn destination_due(destination: &DestinationRecord, now: i64) -> bool {
    let Some(at) = destination.last_push_at else {
        return true;
    };
    let elapsed = now - at;
    if destination.failures > 0 {
        return elapsed >= retry_backoff_ms(destination.failures, destination.interval_secs);
    }
    destination.dirty || elapsed >= destination.interval_secs * 1000
}

pub(super) fn store_locked(conn: &Connection, id: &str) -> Result<StoreRecord> {
    conn.query_row(
        &format!("SELECT {STORE_COLUMNS} FROM vault_external_stores WHERE id = ?1"),
        params![id],
        store_from_row,
    )
    .optional()?
    .flatten()
    .ok_or_else(|| VaultError::NotFound(format!("external store `{id}`")).into())
}

pub(super) fn source_locked(conn: &Connection, id: &str) -> Result<SourceRecord> {
    conn.query_row(
        &format!("SELECT {SOURCE_COLUMNS} FROM vault_external_sources WHERE id = ?1"),
        params![id],
        source_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("external source `{id}`")).into())
}

pub(super) fn destination_locked(conn: &Connection, id: &str) -> Result<DestinationRecord> {
    conn.query_row(
        &format!("SELECT {DESTINATION_COLUMNS} FROM vault_external_destinations WHERE id = ?1"),
        params![id],
        destination_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("external destination `{id}`")).into())
}

pub(super) fn collect<T>(
    conn: &Connection,
    sql: &str,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], map)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
