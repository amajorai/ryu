// apps/core/src/connections/mod.rs
//
// Connected-client presence registry (the "who's on this node" surface).
//
// THIS IS ATTRIBUTION, NOT VERIFIED AUTHENTICATION. Core authenticates the
// *connection* with the shared `RYU_TOKEN` (a machine secret); everyone past
// that boundary is equally trusted and — because the data model is single-tenant
// (conversations/memory carry no `user_id`) — sees the same data. The identity a
// client declares (`x-ryu-user-id`/`x-ryu-user-name`/`x-ryu-client-id`/…) is a
// self-asserted display label so a node operator can SEE who is connected. It
// carries no privilege and grants no isolation. A truly *verified* tier would
// have to verify a token against the control plane on every request, which would
// break Core's local-first / headless-first principle — so it is deliberately
// out of scope here (see CLAUDE.md §1).
//
// The registry is in-memory and TTL-based: every authenticated request `touch`es
// the caller's entry with the current time, and `list_active` returns entries
// seen within the TTL window (pruning the rest). No persistence — presence is a
// live view, not history.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Seconds after a client's last request before it is considered disconnected.
/// Clients poll/chat well within this window; a closed app simply ages out.
pub const DEFAULT_TTL_SECS: u64 = 90;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Identity a client self-declares on each request, parsed from headers. All
/// fields are trusted self-assertions behind the shared token (see module docs).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallerIdentity {
    /// Stable per-user id (the desktop sends the control-plane email).
    pub user_id: Option<String>,
    /// Human display name.
    pub user_name: Option<String>,
    /// Stable per-install id (random, persisted client-side). The dedup key.
    pub client_id: String,
    /// Short device label, e.g. "Desktop", "CLI", "Phone".
    pub client_label: Option<String>,
    /// Surface kind, e.g. "desktop" | "cli" | "mobile" | "extension".
    pub surface: Option<String>,
}

impl CallerIdentity {
    /// Whether this identity is trackable (a client must declare a `client_id`).
    pub fn is_trackable(&self) -> bool {
        !self.client_id.trim().is_empty()
    }
}

/// A currently-connected client, as returned by `GET /api/connections`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ConnectedClient {
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub client_id: String,
    pub client_label: Option<String>,
    pub surface: Option<String>,
    /// Unix seconds of the first request seen from this client.
    pub first_seen: u64,
    /// Unix seconds of the most recent request seen from this client.
    pub last_seen: u64,
}

/// Dedup key: a single user may have several clients (desktop + phone), and an
/// anonymous client (no `user_id`) is keyed by its `client_id` alone.
type Key = (Option<String>, String);

/// In-memory presence registry. Cheap to clone (wraps an `Arc`), so it lives in
/// `ServerState` and is also handed to the tracking middleware as its state.
#[derive(Clone, Default)]
pub struct ConnectionRegistry {
    inner: Arc<Mutex<HashMap<Key, ConnectedClient>>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record activity for a caller. No-op when the identity is not trackable.
    pub fn touch(&self, id: &CallerIdentity) {
        self.touch_at(id, now_secs());
    }

    /// Active clients (last seen within `ttl`), pruning stale entries. Newest
    /// first.
    pub fn list_active(&self, ttl: u64) -> Vec<ConnectedClient> {
        self.list_active_at(now_secs(), ttl)
    }

    // ── Time-injectable cores (deterministic for tests) ──────────────────────

    fn touch_at(&self, id: &CallerIdentity, now: u64) {
        if !id.is_trackable() {
            return;
        }
        let key = (id.user_id.clone(), id.client_id.clone());
        let mut map = self.inner.lock().expect("connections registry poisoned");
        let entry = map.entry(key).or_insert_with(|| ConnectedClient {
            user_id: id.user_id.clone(),
            user_name: id.user_name.clone(),
            client_id: id.client_id.clone(),
            client_label: id.client_label.clone(),
            surface: id.surface.clone(),
            first_seen: now,
            last_seen: now,
        });
        entry.last_seen = now;
        // Refresh the mutable display fields — a client may rename or relabel
        // mid-session, and we always want the latest for the panel.
        if id.user_name.is_some() {
            entry.user_name = id.user_name.clone();
        }
        if id.client_label.is_some() {
            entry.client_label = id.client_label.clone();
        }
        if id.surface.is_some() {
            entry.surface = id.surface.clone();
        }
    }

    fn list_active_at(&self, now: u64, ttl: u64) -> Vec<ConnectedClient> {
        let mut map = self.inner.lock().expect("connections registry poisoned");
        map.retain(|_, c| now.saturating_sub(c.last_seen) <= ttl);
        let mut out: Vec<ConnectedClient> = map.values().cloned().collect();
        // Newest activity first; tie-break on client_id for a stable order.
        out.sort_by(|a, b| {
            b.last_seen
                .cmp(&a.last_seen)
                .then_with(|| a.client_id.cmp(&b.client_id))
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ident(client_id: &str, user: Option<&str>) -> CallerIdentity {
        CallerIdentity {
            user_id: user.map(str::to_owned),
            user_name: user.map(|u| format!("{u} name")),
            client_id: client_id.to_owned(),
            client_label: Some("Desktop".to_owned()),
            surface: Some("desktop".to_owned()),
        }
    }

    #[test]
    fn untrackable_without_client_id_is_ignored() {
        let reg = ConnectionRegistry::new();
        reg.touch_at(&ident("", Some("a@x.com")), 100);
        assert!(reg.list_active_at(100, DEFAULT_TTL_SECS).is_empty());
    }

    #[test]
    fn touch_then_list_returns_client() {
        let reg = ConnectionRegistry::new();
        reg.touch_at(&ident("c1", Some("a@x.com")), 100);
        let active = reg.list_active_at(120, DEFAULT_TTL_SECS);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].client_id, "c1");
        assert_eq!(active[0].user_id.as_deref(), Some("a@x.com"));
        assert_eq!(active[0].first_seen, 100);
        assert_eq!(active[0].last_seen, 100);
    }

    #[test]
    fn re_touch_updates_last_seen_not_first_seen() {
        let reg = ConnectionRegistry::new();
        reg.touch_at(&ident("c1", Some("a@x.com")), 100);
        reg.touch_at(&ident("c1", Some("a@x.com")), 150);
        let active = reg.list_active_at(150, DEFAULT_TTL_SECS);
        assert_eq!(active.len(), 1, "same (user, client) dedups to one entry");
        assert_eq!(active[0].first_seen, 100);
        assert_eq!(active[0].last_seen, 150);
    }

    #[test]
    fn stale_clients_are_pruned() {
        let reg = ConnectionRegistry::new();
        reg.touch_at(&ident("old", Some("a@x.com")), 0);
        reg.touch_at(&ident("new", Some("a@x.com")), 100);
        // At t=100 with a 90s TTL, "old" (last_seen 0) is 100s stale → pruned.
        let active = reg.list_active_at(100, DEFAULT_TTL_SECS);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].client_id, "new");
    }

    #[test]
    fn two_clients_one_user_both_listed_newest_first() {
        let reg = ConnectionRegistry::new();
        reg.touch_at(&ident("desktop", Some("a@x.com")), 100);
        reg.touch_at(&ident("phone", Some("a@x.com")), 110);
        let active = reg.list_active_at(120, DEFAULT_TTL_SECS);
        assert_eq!(active.len(), 2);
        assert_eq!(active[0].client_id, "phone", "newest activity first");
        assert_eq!(active[1].client_id, "desktop");
    }

    #[test]
    fn anonymous_and_identified_clients_coexist() {
        let reg = ConnectionRegistry::new();
        reg.touch_at(&ident("anon", None), 100);
        reg.touch_at(&ident("known", Some("a@x.com")), 100);
        assert_eq!(reg.list_active_at(100, DEFAULT_TTL_SECS).len(), 2);
    }
}
