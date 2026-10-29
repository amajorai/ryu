//! Bounded, in-memory state for Responses API continuation IDs.
//!
//! This store contains conversation messages only. It never writes prompts or
//! response state to disk, and each ID is bound to the credential and caller
//! identity that created it.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::pipeline::RequestContext;

const MAX_ENTRIES: usize = 256;
const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
/// One tenant's share of the process-wide store, applied only when the store is
/// full. The store is shared by every org a hosted gateway serves, so evicting
/// the global oldest entry would let one tenant's traffic push out every other
/// tenant's continuations. A tenant at or over its share evicts its own oldest
/// entry instead; a single-tenant node still uses the whole store.
const MAX_ENTRIES_PER_TENANT: usize = MAX_ENTRIES / 4;
const MAX_BYTES_PER_TENANT: usize = MAX_TOTAL_BYTES / 4;
const RESPONSE_TTL: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResponseOwner {
    owner_binding: String,
    org_id: Option<String>,
    user_id: Option<String>,
    agent_id: Option<String>,
}

impl ResponseOwner {
    /// The org for resolved tenants, else the credential binding.
    fn tenant(&self) -> &str {
        self.org_id.as_deref().unwrap_or(&self.owner_binding)
    }
}

impl From<&RequestContext> for ResponseOwner {
    fn from(context: &RequestContext) -> Self {
        Self {
            owner_binding: context.owner_binding.clone(),
            org_id: context.org_id.clone(),
            user_id: context.user_id.clone(),
            agent_id: context.agent_id.clone(),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct ResponsesStore {
    inner: Arc<Mutex<StoreInner>>,
}

#[derive(Default)]
struct StoreInner {
    entries: HashMap<String, StoredResponse>,
    insertion_order: VecDeque<(String, Instant)>,
    total_bytes: usize,
    /// Live `(entries, bytes)` per tenant, for the per-tenant share.
    tenant_usage: HashMap<String, (usize, usize)>,
}

struct StoredResponse {
    owner: ResponseOwner,
    messages: Vec<Value>,
    inserted_at: Instant,
    serialized_bytes: usize,
}

impl ResponsesStore {
    /// Return a continuation only to the exact caller identity that created it.
    /// Expired IDs and IDs owned by another principal are intentionally
    /// indistinguishable to the caller.
    pub(crate) fn get(&self, id: &str, owner: &ResponseOwner) -> Option<Vec<Value>> {
        let mut inner = self.lock();
        inner.prune_expired(Instant::now());
        let entry = inner.entries.get(id)?;
        (entry.owner == *owner).then(|| entry.messages.clone())
    }

    /// Save a conversation snapshot if it fits the process-wide memory budget.
    /// `false` means the response itself can still be returned, but its ID will
    /// not be usable for a later `previous_response_id` continuation.
    pub(crate) fn insert(&self, id: String, owner: ResponseOwner, messages: Vec<Value>) -> bool {
        let Ok(serialized) = serde_json::to_vec(&messages) else {
            return false;
        };
        let serialized_bytes = serialized.len();
        if serialized_bytes > MAX_ENTRY_BYTES {
            return false;
        }

        let now = Instant::now();
        let mut inner = self.lock();
        inner.prune_expired(now);
        inner.remove(&id);

        let tenant = owner.tenant().to_owned();
        while inner.entries.len() >= MAX_ENTRIES
            || inner.total_bytes.saturating_add(serialized_bytes) > MAX_TOTAL_BYTES
        {
            let over_share = inner
                .tenant_usage
                .get(&tenant)
                .is_some_and(|(entries, bytes)| {
                    *entries >= MAX_ENTRIES_PER_TENANT
                        || bytes.saturating_add(serialized_bytes) > MAX_BYTES_PER_TENANT
                });
            let evicted = if over_share {
                inner.evict_oldest_of(&tenant)
            } else {
                inner.evict_oldest()
            };
            if !evicted {
                return false;
            }
        }

        inner.total_bytes += serialized_bytes;
        let usage = inner.tenant_usage.entry(tenant).or_default();
        usage.0 += 1;
        usage.1 += serialized_bytes;
        inner.insertion_order.push_back((id.clone(), now));
        inner.entries.insert(
            id,
            StoredResponse {
                owner,
                messages,
                inserted_at: now,
                serialized_bytes,
            },
        );
        true
    }

    fn lock(&self) -> MutexGuard<'_, StoreInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl StoreInner {
    fn prune_expired(&mut self, now: Instant) {
        loop {
            let Some((id, inserted_at)) = self.insertion_order.front() else {
                return;
            };
            if now.duration_since(*inserted_at) < RESPONSE_TTL {
                return;
            }
            let id = id.clone();
            let inserted_at = *inserted_at;
            self.insertion_order.pop_front();
            if self
                .entries
                .get(&id)
                .is_some_and(|entry| entry.inserted_at == inserted_at)
            {
                self.remove(&id);
            }
        }
    }

    fn evict_oldest(&mut self) -> bool {
        while let Some((id, inserted_at)) = self.insertion_order.pop_front() {
            if self
                .entries
                .get(&id)
                .is_some_and(|entry| entry.inserted_at == inserted_at)
            {
                self.remove(&id);
                return true;
            }
        }
        false
    }

    /// Evict the oldest live entry owned by `tenant`.
    fn evict_oldest_of(&mut self, tenant: &str) -> bool {
        let position = self.insertion_order.iter().position(|(id, inserted_at)| {
            self.entries.get(id).is_some_and(|entry| {
                entry.inserted_at == *inserted_at && entry.owner.tenant() == tenant
            })
        });
        let Some((id, _)) = position.and_then(|index| self.insertion_order.remove(index)) else {
            return false;
        };
        self.remove(&id);
        true
    }

    fn remove(&mut self, id: &str) {
        if let Some(entry) = self.entries.remove(id) {
            self.total_bytes = self.total_bytes.saturating_sub(entry.serialized_bytes);
            let tenant = entry.owner.tenant();
            if let Some(usage) = self.tenant_usage.get_mut(tenant) {
                usage.0 = usage.0.saturating_sub(1);
                usage.1 = usage.1.saturating_sub(entry.serialized_bytes);
                if usage.0 == 0 {
                    self.tenant_usage.remove(tenant);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ResponseOwner, ResponsesStore, MAX_ENTRIES, MAX_ENTRY_BYTES};

    fn owner(binding: &str, user_id: Option<&str>) -> ResponseOwner {
        ResponseOwner {
            owner_binding: binding.to_owned(),
            org_id: Some("org-a".to_owned()),
            user_id: user_id.map(str::to_owned),
            agent_id: None,
        }
    }

    #[test]
    fn continuation_is_scoped_to_credential_and_identity() {
        let store = ResponsesStore::default();
        let creator = owner("credential-a", Some("user-a"));
        let messages = vec![json!({ "role": "user", "content": "private" })];
        assert!(store.insert("resp_test".to_owned(), creator.clone(), messages.clone()));

        assert_eq!(store.get("resp_test", &creator), Some(messages));
        assert!(store
            .get("resp_test", &owner("credential-b", Some("user-a")))
            .is_none());
        assert!(store
            .get("resp_test", &owner("credential-a", Some("user-b")))
            .is_none());
    }

    #[test]
    fn oversized_history_is_not_retained() {
        let store = ResponsesStore::default();
        let oversized = vec![json!({
            "role": "user",
            "content": "x".repeat(MAX_ENTRY_BYTES + 1),
        })];

        assert!(!store.insert("resp_large".to_owned(), owner("key", None), oversized));
        assert!(store.get("resp_large", &owner("key", None)).is_none());
    }

    fn org_owner(org: &str) -> ResponseOwner {
        ResponseOwner {
            owner_binding: format!("credential-{org}"),
            org_id: Some(org.to_owned()),
            user_id: None,
            agent_id: None,
        }
    }

    #[test]
    fn one_tenant_cannot_evict_another_tenants_continuations() {
        let store = ResponsesStore::default();
        let victim = org_owner("org-paid");
        let messages = vec![json!({ "role": "user", "content": "keep me" })];
        assert!(store.insert("resp_victim".to_owned(), victim.clone(), messages.clone()));

        // A noisy tenant fills far past the whole store's capacity.
        let noisy = org_owner("org-free");
        for index in 0..MAX_ENTRIES * 2 {
            assert!(store.insert(
                format!("resp_noisy_{index}"),
                noisy.clone(),
                messages.clone()
            ));
        }

        assert_eq!(store.get("resp_victim", &victim), Some(messages.clone()));
        // Under pressure the noisy tenant recycles its own oldest entries.
        let newest = format!("resp_noisy_{}", MAX_ENTRIES * 2 - 1);
        assert!(store.get(&newest, &noisy).is_some());
        let oldest_kept = MAX_ENTRIES * 2 - (MAX_ENTRIES - 1);
        assert!(store
            .get(&format!("resp_noisy_{oldest_kept}"), &noisy)
            .is_some());
        assert!(store
            .get(&format!("resp_noisy_{}", oldest_kept - 1), &noisy)
            .is_none());
    }

    #[test]
    fn a_tenant_under_its_share_reclaims_space_from_the_global_oldest() {
        let store = ResponsesStore::default();
        let messages = vec![json!({ "role": "user", "content": "x" })];
        let heavy = org_owner("org-heavy");
        for index in 0..MAX_ENTRIES {
            assert!(store.insert(
                format!("resp_heavy_{index}"),
                heavy.clone(),
                messages.clone()
            ));
        }
        // A newcomer is under its share, so the heavy tenant's oldest makes room.
        let newcomer = org_owner("org-new");
        assert!(store.insert("resp_new".to_owned(), newcomer.clone(), messages.clone()));
        assert!(store.get("resp_new", &newcomer).is_some());
        assert!(store.get("resp_heavy_0", &heavy).is_none());
    }
}
