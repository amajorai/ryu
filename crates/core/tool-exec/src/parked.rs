//! The bounded store of **parked** (suspended, awaiting-`resume`) executions.
//!
//! A parked entry pins a real blocked subprocess waiting for the user to
//! complete a Composio connect/consent step. Left unbounded these would
//! accumulate, so the store enforces two hard limits (security HIGH):
//!   - **cap** [`super::MAX_PARKED`] — when full, the oldest entry is evicted to
//!     make room (its subprocess handle is dropped → killed);
//!   - **TTL** [`super::PARKED_TTL`] — entries older than the TTL are swept on
//!     every access.
//!
//! Generic over the handle type `H` so the cap/TTL/eviction logic is unit-
//! testable with a trivial dummy handle — no live subprocess required.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// One parked execution: an opaque handle plus the time it was parked.
struct Parked<H> {
    handle: H,
    parked_at: Instant,
}

/// A bounded, TTL-swept map of parked executions keyed by execution id.
pub struct ParkedStore<H> {
    entries: HashMap<String, Parked<H>>,
    cap: usize,
    ttl: Duration,
}

impl<H> ParkedStore<H> {
    /// Create a store with an explicit cap + TTL (the production constructor
    /// passes [`super::MAX_PARKED`] / [`super::PARKED_TTL`]).
    pub fn new(cap: usize, ttl: Duration) -> Self {
        Self {
            entries: HashMap::new(),
            cap: cap.max(1),
            ttl,
        }
    }

    /// Park a handle under `id`. Returns any handles evicted to make room (TTL
    /// sweep + over-cap eviction of the oldest) so the caller can kill their
    /// subprocesses. Re-parking an existing id replaces it.
    pub fn insert(&mut self, id: String, handle: H) -> Vec<H> {
        let mut evicted = self.sweep_expired();
        // If at/over cap (and this id is new), drop the oldest to make room.
        while self.entries.len() >= self.cap && !self.entries.contains_key(&id) {
            if let Some(old) = self.pop_oldest() {
                evicted.push(old);
            } else {
                break;
            }
        }
        self.entries.insert(
            id,
            Parked {
                handle,
                parked_at: Instant::now(),
            },
        );
        evicted
    }

    /// Remove and return the handle for `id`, if present and not expired. An
    /// expired entry is treated as absent (and its handle returned as evicted
    /// via [`sweep_expired`] on the next mutating call). Returns `None` for an
    /// unknown id → the route maps that to `404 execution_not_found`.
    pub fn take(&mut self, id: &str) -> Option<H> {
        if let Some(p) = self.entries.get(id) {
            if p.parked_at.elapsed() >= self.ttl {
                // Expired: remove without returning as a live resume target.
                self.entries.remove(id);
                return None;
            }
        }
        self.entries.remove(id).map(|p| p.handle)
    }

    /// Number of currently-parked entries (after no implicit sweep).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Remove every entry older than the TTL, returning their handles.
    pub fn sweep_expired(&mut self) -> Vec<H> {
        let ttl = self.ttl;
        let expired: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, p)| p.parked_at.elapsed() >= ttl)
            .map(|(k, _)| k.clone())
            .collect();
        expired
            .into_iter()
            .filter_map(|k| self.entries.remove(&k).map(|p| p.handle))
            .collect()
    }

    /// Remove and return the oldest entry's handle.
    fn pop_oldest(&mut self) -> Option<H> {
        let oldest = self
            .entries
            .iter()
            .min_by_key(|(_, p)| p.parked_at)
            .map(|(k, _)| k.clone())?;
        self.entries.remove(&oldest).map(|p| p.handle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_take_roundtrip() {
        let mut store: ParkedStore<u32> = ParkedStore::new(4, Duration::from_secs(60));
        assert!(store.insert("a".into(), 1).is_empty());
        assert_eq!(store.len(), 1);
        assert_eq!(store.take("a"), Some(1));
        assert!(store.is_empty());
    }

    #[test]
    fn take_unknown_id_is_none() {
        let mut store: ParkedStore<u32> = ParkedStore::new(4, Duration::from_secs(60));
        assert_eq!(store.take("missing"), None);
    }

    #[test]
    fn cap_evicts_oldest() {
        let mut store: ParkedStore<u32> = ParkedStore::new(2, Duration::from_secs(60));
        store.insert("a".into(), 1);
        std::thread::sleep(Duration::from_millis(2));
        store.insert("b".into(), 2);
        std::thread::sleep(Duration::from_millis(2));
        // Third insert is over cap → oldest ("a") evicted and returned.
        let evicted = store.insert("c".into(), 3);
        assert_eq!(evicted, vec![1]);
        assert_eq!(store.len(), 2);
        // "a" is gone; "b" and "c" remain.
        assert_eq!(store.take("a"), None);
        assert_eq!(store.take("b"), Some(2));
        assert_eq!(store.take("c"), Some(3));
    }

    #[test]
    fn ttl_expires_entries() {
        let mut store: ParkedStore<u32> = ParkedStore::new(4, Duration::from_millis(5));
        store.insert("a".into(), 1);
        std::thread::sleep(Duration::from_millis(10));
        // A take after the TTL returns None (expired, not a live resume target).
        assert_eq!(store.take("a"), None);
    }

    #[test]
    fn ttl_sweep_on_insert_returns_expired_handles() {
        let mut store: ParkedStore<u32> = ParkedStore::new(4, Duration::from_millis(5));
        store.insert("a".into(), 1);
        std::thread::sleep(Duration::from_millis(10));
        // Inserting a fresh entry sweeps the expired one and hands its handle back.
        let evicted = store.insert("b".into(), 2);
        assert_eq!(evicted, vec![1]);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn reinserting_same_id_does_not_evict() {
        let mut store: ParkedStore<u32> = ParkedStore::new(1, Duration::from_secs(60));
        store.insert("a".into(), 1);
        // Re-parking the same id replaces in place; cap of 1 not exceeded.
        let evicted = store.insert("a".into(), 9);
        assert!(evicted.is_empty());
        assert_eq!(store.len(), 1);
        assert_eq!(store.take("a"), Some(9));
    }
}
