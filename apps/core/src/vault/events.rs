//! Vault event notifications.
//!
//! A process-wide broadcast bus that tells consumers (the Desktop vault page,
//! `ryu secrets run --watch`, agent sandboxes) that something changed without
//! polling. Events are derived from successfully appended audit rows, so every
//! audited write path (KV writes and deletes, rotation, lease issue, renew,
//! revoke and expiry, seal changes, change-request decisions) emits one with
//! no extra call sites, and nothing reaches the bus that the audit chain did
//! not record.
//!
//! An event carries coordinates only: type, environment, path, name, version,
//! and lease id. It never carries a value, ciphertext, token, or key. The
//! subscription routes authorize each event separately against the caller's
//! `list` capability on the event's policy key. `list` is the metadata-only
//! capability, which is exactly what an event reveals.

use std::sync::OnceLock;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

use super::audit::AuditRow;
use super::{policy_key, ROOT_PATH, SYS_PREFIX};

/// Bounded buffer per subscriber; a slow subscriber skips ahead (lagged)
/// rather than holding memory.
const BUS_CAPACITY: usize = 1024;

/// One vault event. Never carries a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEvent {
    /// Audit sequence number of the row this event was derived from.
    pub seq: i64,
    /// RFC 3339 time of the change.
    pub at: String,
    /// Event type, e.g. `kv-write`, `kv-delete`, `key-rotate`, `lease-revoke`.
    #[serde(rename = "type")]
    pub kind: String,
    /// The audited action the event was derived from.
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    /// Owning scope (`user`, `node`, `team`, `org`) for per-event
    /// authorization; not serialized.
    #[serde(skip)]
    pub scope: Option<String>,
    /// Owning scope id for per-event authorization; not serialized.
    #[serde(skip)]
    pub scope_id: Option<String>,
    /// The `sys/...` key the matching admin route checks, for events that do
    /// not name a secret; not serialized. See [`sys_key`].
    #[serde(skip)]
    pub sys_key: Option<String>,
}

impl VaultEvent {
    /// The policy key a subscriber needs `list` on: `ENV/folder/NAME` for a
    /// secret, otherwise the `sys/...` key the route that makes the change
    /// checks (for example `sys/policies` or `sys/transit/<key>`).
    pub fn policy_key(&self) -> String {
        match (&self.environment, &self.name) {
            (Some(environment), Some(name)) => {
                policy_key(environment, self.path.as_deref().unwrap_or(ROOT_PATH), name)
            }
            _ => self
                .sys_key
                .clone()
                .unwrap_or_else(|| format!("{SYS_PREFIX}/vault")),
        }
    }
}

/// The policy key of a non-secret event, mirroring the key its admin route
/// checks. Secret-addressed events (`secret.*`, `change.*`) use the secret's
/// own key instead and never reach this.
pub fn sys_key(row: &AuditRow) -> String {
    let detail = |key: &str| {
        row.details
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let action = row.action.as_str();
    let family = action.split('.').next().unwrap_or_default();
    match family {
        "policy" => format!("{SYS_PREFIX}/policies"),
        "environment" => match row.environment.as_deref() {
            Some(environment) => format!("{SYS_PREFIX}/environments/{environment}"),
            None => format!("{SYS_PREFIX}/environments"),
        },
        "import" => format!("{SYS_PREFIX}/imports"),
        "sys" => format!("{SYS_PREFIX}/seal"),
        "transit" => match detail("key").or_else(|| detail("name")) {
            Some(key) => format!("{SYS_PREFIX}/transit/{key}"),
            None => format!("{SYS_PREFIX}/transit"),
        },
        "lease" | "dynamic" => match detail("role") {
            Some(role) => format!("{SYS_PREFIX}/dynamic/{role}"),
            None => format!("{SYS_PREFIX}/leases"),
        },
        "pki" if action == "pki.revoke" => format!("{SYS_PREFIX}/pki/revoke"),
        "machine" | "token" => format!("{SYS_PREFIX}/machines"),
        "audit" => format!("{SYS_PREFIX}/audit"),
        "bootstrap" => format!("{SYS_PREFIX}/init"),
        // Bulk import markers carry no single secret; each imported secret
        // also emits its own `kv-write` on its own key.
        "vault" => format!("{SYS_PREFIX}/import"),
        _ => format!("{SYS_PREFIX}/{family}"),
    }
}

/// Map an audited action onto an event type. `None` for reads, uses, and
/// failed or denied operations, which change nothing.
fn event_type(action: &str) -> Option<&'static str> {
    Some(match action {
        "secret.create" | "secret.update" | "secret.metadata" | "secret.restore" => "kv-write",
        "secret.rollback" => "kv-write",
        "secret.delete" => "kv-delete",
        "secret.destroy" => "kv-destroy",
        "vault.import" | "vault.snapshot.import" => "kv-import",
        "environment.put" | "environment.delete" => "environment-change",
        "import.add" | "import.remove" => "import-change",
        "policy.put" | "policy.delete" | "policy.bind" | "policy.unbind" => "policy-change",
        "change.request" => "change-request",
        "change.approve" | "change.reject" | "change.cancel" => "change-decision",
        "change.apply" => "change-applied",
        "lease.create" | "dynamic.issue" => "lease-create",
        "lease.renew" => "lease-renew",
        "lease.revoke" => "lease-revoke",
        "transit.rotate" | "sys.rotate" | "sys.rewrap" => "key-rotate",
        "transit.create" | "transit.configure" | "transit.delete" => "transit-change",
        "sys.seal" => "seal",
        "sys.unseal" => "unseal",
        "machine.create" | "machine.update" | "machine.delete" => "machine-change",
        "token.revoke" | "machine.secret_id.revoke" => "credential-revoke",
        "pki.revoke" => "certificate-revoke",
        "audit.device.put" | "audit.device.delete" => "audit-device-change",
        "bootstrap.apply" => "bootstrap-apply",
        _ => return None,
    })
}

fn bus() -> &'static broadcast::Sender<VaultEvent> {
    static BUS: OnceLock<broadcast::Sender<VaultEvent>> = OnceLock::new();
    BUS.get_or_init(|| broadcast::channel(BUS_CAPACITY).0)
}

/// Subscribe to every future vault event.
pub fn subscribe() -> broadcast::Receiver<VaultEvent> {
    bus().subscribe()
}

/// Derive the event for one appended audit row, if it describes a change.
pub fn from_row(row: &AuditRow) -> Option<VaultEvent> {
    if row.outcome != "ok" {
        return None;
    }
    let detail_str = |key: &str| {
        row.details
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    // The reaper records lease expiry as a revoke with reason `expired`.
    let kind = match row.action.as_str() {
        "lease.revoke" if detail_str("reason").as_deref() == Some("expired") => "lease-expire",
        action => event_type(action)?,
    };
    Some(VaultEvent {
        seq: row.seq,
        at: row.at.clone(),
        kind: kind.to_owned(),
        action: row.action.clone(),
        environment: row.environment.clone(),
        path: row.path.clone(),
        name: row.name.clone(),
        version: row.details.get("version").and_then(Value::as_i64),
        lease_id: detail_str("leaseId").or_else(|| detail_str("lease_id")),
        scope: row.scope.clone(),
        scope_id: row.scope_id.clone(),
        sys_key: Some(sys_key(row)),
    })
}

/// Publish the event for an appended row. Never blocks; with no subscribers
/// the event is dropped.
pub fn publish_row(row: &AuditRow) {
    if let Some(event) = from_row(row) {
        let _ = bus().send(event);
    }
}

/// Publish a ready-made event, for stream tests.
#[cfg(test)]
pub(crate) fn publish_for_test(event: VaultEvent) {
    let _ = bus().send(event);
}

/// Subscription filter from the route query string.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFilter {
    /// Comma-separated event types; all when absent.
    #[serde(default)]
    pub types: Option<String>,
    #[serde(default)]
    pub environment: Option<String>,
    /// Policy-key glob such as `prod/payments/*`.
    #[serde(default)]
    pub path: Option<String>,
}

impl EventFilter {
    /// Whether `event` passes the caller-supplied filter (authorization is
    /// separate).
    pub fn matches(&self, event: &VaultEvent) -> bool {
        if let Some(types) = self.types.as_deref().filter(|t| !t.trim().is_empty()) {
            if !types.split(',').any(|t| t.trim() == event.kind) {
                return false;
            }
        }
        if let Some(environment) = &self.environment {
            if event.environment.as_deref() != Some(environment.as_str()) {
                return false;
            }
        }
        if let Some(pattern) = &self.path {
            if !super::policy::glob_matches(pattern, &event.policy_key()) {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::audit::AuditActor;
    use serde_json::json;

    fn row(action: &str, outcome: &str) -> AuditRow {
        AuditRow {
            seq: 7,
            at: "2026-01-01T00:00:00Z".into(),
            actor: AuditActor::new("user", Some("u1")),
            action: action.into(),
            outcome: outcome.into(),
            scope: Some("user".into()),
            scope_id: Some("u1".into()),
            environment: Some("prod".into()),
            path: Some("/payments".into()),
            name: Some("STRIPE_KEY".into()),
            details: json!({ "version": 3, "leaseId": "vl_1" }),
            request_id: None,
        }
    }

    #[test]
    fn writes_map_to_events_without_values() {
        let event = from_row(&row("secret.update", "ok")).unwrap();
        assert_eq!(event.kind, "kv-write");
        assert_eq!(event.version, Some(3));
        assert_eq!(event.policy_key(), "prod/payments/STRIPE_KEY");
        let wire = serde_json::to_value(&event).unwrap();
        assert_eq!(wire["type"], "kv-write");
        assert!(wire.get("scopeId").is_none());
        assert!(wire.get("value").is_none());
    }

    #[test]
    fn reads_uses_and_failures_emit_nothing() {
        assert!(from_row(&row("secret.read", "ok")).is_none());
        assert!(from_row(&row("secret.use", "ok")).is_none());
        assert!(from_row(&row("secret.update", "denied")).is_none());
    }

    #[test]
    fn expired_revokes_are_lease_expiry() {
        let mut expired = row("lease.revoke", "ok");
        expired.details = json!({ "leaseId": "vl_1", "reason": "expired" });
        let event = from_row(&expired).unwrap();
        assert_eq!(event.kind, "lease-expire");
        assert_eq!(event.lease_id.as_deref(), Some("vl_1"));
        let revoked = from_row(&row("lease.revoke", "ok")).unwrap();
        assert_eq!(revoked.kind, "lease-revoke");
        assert!(from_row(&row("lease.revoke", "error")).is_none());
    }

    fn sys_event_key(action: &str, environment: Option<&str>, details: Value) -> String {
        let mut r = row(action, "ok");
        r.environment = environment.map(str::to_owned);
        r.name = None;
        r.details = details;
        from_row(&r).unwrap().policy_key()
    }

    #[test]
    fn non_secret_events_use_the_route_policy_key() {
        let none = json!({});
        assert_eq!(
            sys_event_key("policy.put", None, none.clone()),
            "sys/policies"
        );
        assert_eq!(
            sys_event_key("policy.unbind", None, none.clone()),
            "sys/policies"
        );
        assert_eq!(
            sys_event_key("environment.put", Some("prod"), none.clone()),
            "sys/environments/prod"
        );
        assert_eq!(
            sys_event_key("import.add", None, none.clone()),
            "sys/imports"
        );
        assert_eq!(sys_event_key("sys.seal", None, none.clone()), "sys/seal");
        assert_eq!(sys_event_key("sys.rewrap", None, none.clone()), "sys/seal");
        assert_eq!(
            sys_event_key("transit.rotate", None, json!({ "key": "payments" })),
            "sys/transit/payments"
        );
        assert_eq!(
            sys_event_key("lease.create", None, json!({ "role": "db" })),
            "sys/dynamic/db"
        );
        assert_eq!(
            sys_event_key("lease.renew", None, none.clone()),
            "sys/leases"
        );
        assert_eq!(
            sys_event_key("pki.revoke", None, none.clone()),
            "sys/pki/revoke"
        );
        assert_eq!(
            sys_event_key("machine.update", None, none.clone()),
            "sys/machines"
        );
        assert_eq!(
            sys_event_key("token.revoke", None, none.clone()),
            "sys/machines"
        );
        assert_eq!(
            sys_event_key("audit.device.put", None, none.clone()),
            "sys/audit"
        );
        assert_eq!(sys_event_key("bootstrap.apply", None, none), "sys/init");
        // A `sys/transit/*` grant covers per-key transit events.
        assert!(crate::vault::policy::glob_matches(
            "sys/transit/*",
            "sys/transit/payments"
        ));
    }

    #[test]
    fn change_events_use_the_secret_key() {
        let event = from_row(&row("change.approve", "ok")).unwrap();
        assert_eq!(event.kind, "change-decision");
        assert_eq!(event.policy_key(), "prod/payments/STRIPE_KEY");
    }

    #[test]
    fn filters_select_by_type_environment_and_path() {
        let event = from_row(&row("secret.update", "ok")).unwrap();
        let filter = EventFilter {
            types: Some("kv-delete, kv-write".into()),
            environment: Some("prod".into()),
            path: Some("prod/payments/*".into()),
        };
        assert!(filter.matches(&event));
        let other = EventFilter {
            environment: Some("dev".into()),
            ..Default::default()
        };
        assert!(!other.matches(&event));
    }

    #[tokio::test]
    async fn published_rows_reach_subscribers() {
        let mut rx = subscribe();
        let mut r = row("secret.delete", "ok");
        r.name = Some("EVENTS_BUS_TEST".into());
        publish_row(&r);
        loop {
            let event = rx.recv().await.unwrap();
            if event.name.as_deref() == Some("EVENTS_BUS_TEST") {
                assert_eq!(event.kind, "kv-delete");
                break;
            }
        }
    }
}
