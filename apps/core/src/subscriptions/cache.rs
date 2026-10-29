//! Full-snapshot cache for per-account subscription usage.
//!
//! This is deliberately separate from the routing observation map in
//! `server::oauth_pool_usage`. That map keeps only normalized percentages and
//! drops an account's entry whenever a read fails, so a failed reading can never
//! look like headroom to the pool selector. Owner surfaces need the opposite:
//! a `rate_limited` or `error` reading must be remembered for a while, or every
//! UI poll after a failure would call the vendor again. Both caches are keyed by
//! the sealed credential revision, so a reading never outlives its login.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};

/// Upper bound for any cached reading.
pub(crate) const READING_TTL: Duration = Duration::from_secs(5 * 60);
/// Failed vendor reads are retried sooner than successful ones.
pub(crate) const ERROR_TTL: Duration = Duration::from_secs(60);
const MAX_ENTRIES: usize = 1_000;

type Key = (String, String);

/// A reading served from the cache.
#[derive(Clone, Debug)]
pub(crate) struct Hit {
    pub snapshot: ryu_usage::UsageSnapshot,
    pub observed_at: DateTime<Utc>,
}

/// How fresh a cached reading must be to count as a hit.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Freshness {
    /// Observed no longer than this ago (and still inside its own TTL).
    MaxAge(Duration),
    /// Read started at or after this instant. A forced read that waited behind
    /// another caller's in-flight read accepts that read's result.
    StartedAfter(Instant),
}

struct Entry {
    revision: Vec<u8>,
    read_started_at: Instant,
    stored_at: Instant,
    observed_at: DateTime<Utc>,
    ttl: Duration,
    snapshot: ryu_usage::UsageSnapshot,
}

impl Entry {
    fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.stored_at) >= self.ttl
    }
}

/// How long one reading may be served. Rate-limited readings expire when the
/// vendor said to retry (capped at the normal TTL); other failures after
/// [`ERROR_TTL`].
pub(crate) fn ttl_for(snapshot: &ryu_usage::UsageSnapshot) -> Duration {
    match snapshot.reason {
        Some(ryu_usage::UsageUnavailable::RateLimited) => snapshot
            .retry_after_seconds
            .and_then(|seconds| u64::try_from(seconds).ok())
            // Floored at ERROR_TTL: a `Retry-After: 0` must not make every
            // call a fresh vendor read.
            .map_or(READING_TTL, |seconds| {
                Duration::from_secs(seconds).clamp(ERROR_TTL, READING_TTL)
            }),
        Some(ryu_usage::UsageUnavailable::Error) => ERROR_TTL,
        _ => READING_TTL,
    }
}

#[derive(Default)]
pub(crate) struct Cache {
    entries: Mutex<HashMap<Key, Entry>>,
    flights: Mutex<HashMap<Key, Weak<tokio::sync::Mutex<()>>>>,
}

impl Cache {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Store a reading taken under `revision`. A read that started before the
    /// stored one never replaces it, whichever finished first.
    pub(crate) fn record(
        &self,
        provider_id: &str,
        account_id: &str,
        revision: &[u8],
        started_at: Instant,
        snapshot: &ryu_usage::UsageSnapshot,
    ) {
        let key = (provider_id.to_owned(), account_id.to_owned());
        let mut entries = self.entries();
        if entries
            .get(&key)
            .is_some_and(|entry| entry.read_started_at > started_at)
        {
            return;
        }
        let now = Instant::now();
        entries.retain(|_, entry| !entry.expired(now));
        if entries.len() >= MAX_ENTRIES && !entries.contains_key(&key) {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.stored_at)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            key,
            Entry {
                revision: revision.to_vec(),
                read_started_at: started_at,
                stored_at: now,
                observed_at: Utc::now(),
                ttl: ttl_for(snapshot),
                snapshot: snapshot.clone(),
            },
        );
    }

    /// A fresh reading for this exact credential revision. An expired entry is
    /// a miss and evicts the entry. A revision mismatch is a miss but leaves the
    /// entry alone: the caller's revision may be the stale one, and evicting
    /// would drop a newer reading recorded under the rotated credential.
    pub(crate) fn lookup(
        &self,
        provider_id: &str,
        account_id: &str,
        revision: &[u8],
        freshness: Freshness,
    ) -> Option<Hit> {
        let key = (provider_id.to_owned(), account_id.to_owned());
        let mut entries = self.entries();
        let entry = entries.get(&key)?;
        let now = Instant::now();
        if entry.expired(now) {
            entries.remove(&key);
            return None;
        }
        if entry.revision != revision {
            return None;
        }
        let fresh = match freshness {
            Freshness::MaxAge(max_age) => now.duration_since(entry.stored_at) < max_age,
            Freshness::StartedAfter(instant) => entry.read_started_at >= instant,
        };
        fresh.then(|| Hit {
            snapshot: entry.snapshot.clone(),
            observed_at: entry.observed_at,
        })
    }

    /// Drop the entry for `revision` unless a newer read has replaced it.
    pub(crate) fn remove_if_revision(
        &self,
        provider_id: &str,
        account_id: &str,
        revision: &[u8],
        started_at: Instant,
    ) {
        let key = (provider_id.to_owned(), account_id.to_owned());
        let mut entries = self.entries();
        if entries
            .get(&key)
            .is_some_and(|entry| entry.revision == revision && entry.read_started_at <= started_at)
        {
            entries.remove(&key);
        }
    }

    /// The single-flight lock for one account. Callers hold it across the
    /// vendor read so concurrent readers of the same account share one fetch.
    pub(crate) fn flight(
        &self,
        provider_id: &str,
        account_id: &str,
    ) -> Arc<tokio::sync::Mutex<()>> {
        let key = (provider_id.to_owned(), account_id.to_owned());
        let mut flights = self
            .flights
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(flight) = flights.get(&key).and_then(Weak::upgrade) {
            return flight;
        }
        flights.retain(|_, flight| flight.strong_count() > 0);
        let flight = Arc::new(tokio::sync::Mutex::new(()));
        flights.insert(key, Arc::downgrade(&flight));
        flight
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries().len()
    }
}

/// The process-wide reading cache.
pub(crate) fn global() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Cache::default)
}

/// Record a reading only when the credential revision did not change while the
/// vendor call was in flight. A reading that straddles a rotation belongs to
/// neither login, so it is dropped and the old entry is invalidated.
pub(crate) fn guarded_record(
    cache: &Cache,
    provider_id: &str,
    account_id: &str,
    revision_before: Option<&[u8]>,
    revision_after: Option<&[u8]>,
    started_at: Instant,
    snapshot: &ryu_usage::UsageSnapshot,
) {
    match (revision_before, revision_after) {
        (Some(before), Some(after)) if before == after => {
            cache.record(provider_id, account_id, after, started_at, snapshot);
        }
        (Some(before), _) => {
            cache.remove_if_revision(provider_id, account_id, before, started_at);
        }
        (None, _) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(
        reason: Option<ryu_usage::UsageUnavailable>,
        retry_after_seconds: Option<i64>,
    ) -> ryu_usage::UsageSnapshot {
        ryu_usage::UsageSnapshot {
            agent_id: "claude-pro-max".to_owned(),
            engine: "claude".to_owned(),
            available: reason.is_none(),
            reason,
            retry_after_seconds,
            ..Default::default()
        }
    }

    const FRESH: Freshness = Freshness::MaxAge(READING_TTL);

    #[test]
    fn revision_guard_drops_a_reading_that_straddles_a_rotation() {
        let cache = Cache::default();
        let started = Instant::now();
        cache.record("p", "a", b"old", started, &snapshot(None, None));
        guarded_record(
            &cache,
            "p",
            "a",
            Some(b"old"),
            Some(b"new"),
            Instant::now(),
            &snapshot(None, None),
        );
        assert!(cache.lookup("p", "a", b"old", FRESH).is_none());
        assert!(cache.lookup("p", "a", b"new", FRESH).is_none());
        assert_eq!(cache.len(), 0);

        guarded_record(
            &cache,
            "p",
            "a",
            Some(b"new"),
            Some(b"new"),
            Instant::now(),
            &snapshot(None, None),
        );
        assert!(cache.lookup("p", "a", b"new", FRESH).is_some());
    }

    #[test]
    fn revision_mismatch_is_a_miss_that_keeps_the_newer_entry() {
        let cache = Cache::default();
        cache.record("p", "a", b"new", Instant::now(), &snapshot(None, None));
        // A caller still holding the pre-rotation revision misses...
        assert!(cache.lookup("p", "a", b"old", FRESH).is_none());
        // ...without evicting the reading recorded under the rotated one.
        assert!(cache.lookup("p", "a", b"new", FRESH).is_some());
    }

    #[test]
    fn failed_readings_are_cached_with_a_shorter_ttl() {
        let cache = Cache::default();
        let error = snapshot(Some(ryu_usage::UsageUnavailable::Error), None);
        cache.record("p", "a", b"r", Instant::now(), &error);
        let hit = cache
            .lookup("p", "a", b"r", FRESH)
            .expect("error reading cached");
        assert!(!hit.snapshot.available);
        assert_eq!(ttl_for(&error), ERROR_TTL);
    }

    #[test]
    fn rate_limited_is_cached_only_until_retry_after() {
        let limited = snapshot(Some(ryu_usage::UsageUnavailable::RateLimited), Some(120));
        assert_eq!(ttl_for(&limited), Duration::from_secs(120));
        let long = snapshot(Some(ryu_usage::UsageUnavailable::RateLimited), Some(86_400));
        assert_eq!(ttl_for(&long), READING_TTL);

        let cache = Cache::default();
        cache.record("p", "a", b"r", Instant::now(), &limited);
        assert!(cache.lookup("p", "a", b"r", FRESH).is_some());

        // `Retry-After: 0` is floored, so a vendor that keeps answering it is
        // not re-read on every call.
        let elapsed = snapshot(Some(ryu_usage::UsageUnavailable::RateLimited), Some(0));
        assert_eq!(ttl_for(&elapsed), ERROR_TTL);
        cache.record("p", "a", b"r", Instant::now(), &elapsed);
        assert!(cache.lookup("p", "a", b"r", FRESH).is_some());
    }

    #[test]
    fn older_read_cannot_replace_a_newer_one() {
        let cache = Cache::default();
        let older = Instant::now();
        let newer = older + Duration::from_millis(5);
        cache.record("p", "a", b"r", newer, &snapshot(None, None));
        cache.record(
            "p",
            "a",
            b"r",
            older,
            &snapshot(Some(ryu_usage::UsageUnavailable::Error), None),
        );
        let hit = cache
            .lookup("p", "a", b"r", FRESH)
            .expect("newer entry kept");
        assert!(hit.snapshot.available);
    }

    #[test]
    fn max_age_and_started_after_bound_freshness() {
        let cache = Cache::default();
        let started = Instant::now();
        cache.record("p", "a", b"r", started, &snapshot(None, None));
        assert!(cache
            .lookup("p", "a", b"r", Freshness::MaxAge(Duration::ZERO))
            .is_none());
        assert!(cache
            .lookup("p", "a", b"r", Freshness::StartedAfter(started))
            .is_some());
        assert!(cache
            .lookup(
                "p",
                "a",
                b"r",
                Freshness::StartedAfter(started + Duration::from_secs(1))
            )
            .is_none());
    }
}
