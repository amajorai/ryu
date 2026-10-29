//! Segment keys and the per-replica segment score cache (spec 02.8, screener
//! addendum section 7.3).
//!
//! The key is `HMAC(org_scope_key, class || NFKC(text))`, joined with the
//! backend's `cache_scope` (`backend_id@model@weights_sha256[0..8]#template`).
//! A segment classified with context binds that context into its key
//! ([`SegmentKey::for_text_in_context`]), so a score is reused only beside
//! the context that produced it: a new combination of cached segments is
//! classified again as a whole, and an append-only later turn still hits on
//! its earlier segments.
//! The value is per-code scores, never a decision, so floor and tenant changes
//! apply without a flush. No text and no image bytes are stored. Degraded
//! verdicts never reach this cache: the chain inserts only answers a backend
//! actually returned.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use lru::LruCache;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::backend::{CodeSet, ConfidenceSource, ItemVerdict, LeafClass, ModelSignal, TaxonomyId};

type HmacSha256 = Hmac<Sha256>;

/// Default capacity (spec 02.8: 200k entries).
pub const DEFAULT_CAPACITY: usize = 200_000;
/// Default time to live (spec 02.8: 24 h).
pub const DEFAULT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// A keyed segment hash. Never reversible to text without the scope key.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SegmentKey(pub [u8; 32]);

impl std::fmt::Debug for SegmentKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SegmentKey({})", &hex::encode(self.0)[..12])
    }
}

impl SegmentKey {
    /// `HMAC-SHA256(scope_key, class || 0x1f || NFKC(text))`. Org-scoped
    /// callers pass the org scope key; a `Definition` segment read with no
    /// context uses a global one.
    pub fn for_text(scope_key: &[u8], class: LeafClass, text: &str) -> Self {
        let normalized: String = text.nfkc().collect();
        Self::mac(scope_key, class, b"t", normalized.as_bytes())
    }

    /// [`Self::for_text`] bound to the context the segment is classified
    /// with. A backend that reads context scores the segment and its context
    /// together, so a score is only reusable beside the same context: the same
    /// text after a new conversation prefix is a cache miss and is classified
    /// again (spec 02.8, combination verdict). `None` is exactly
    /// [`Self::for_text`].
    pub fn for_text_in_context(
        scope_key: &[u8],
        class: LeafClass,
        text: &str,
        context: Option<&str>,
    ) -> Self {
        let Some(context) = context else {
            return Self::for_text(scope_key, class, text);
        };
        let normalized: String = text.nfkc().collect();
        let context: String = context.nfkc().collect();
        let mut mac = HmacSha256::new_from_slice(scope_key).expect("HMAC accepts any key length");
        mac.update(class.as_str().as_bytes());
        mac.update(&[0x1f]);
        mac.update(b"c");
        mac.update(&[0x1f]);
        mac.update(&(context.len() as u64).to_be_bytes());
        mac.update(context.as_bytes());
        mac.update(&[0x1f]);
        mac.update(normalized.as_bytes());
        Self(mac.finalize().into_bytes().into())
    }

    /// The key for an image: the keyed hash of its sha256, never its bytes.
    pub fn for_image(scope_key: &[u8], class: LeafClass, sha256: &[u8; 32]) -> Self {
        Self::mac(scope_key, class, b"i", sha256)
    }

    fn mac(scope_key: &[u8], class: LeafClass, tag: &[u8], body: &[u8]) -> Self {
        let mut mac = HmacSha256::new_from_slice(scope_key).expect("HMAC accepts any key length");
        mac.update(class.as_str().as_bytes());
        mac.update(&[0x1f]);
        mac.update(tag);
        mac.update(&[0x1f]);
        mac.update(body);
        Self(mac.finalize().into_bytes().into())
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

/// The request-level combination key: a hash of the ordered segment keys, so
/// a new combination is classified as a whole even when every segment hits.
pub fn combination_key(segments: &[SegmentKey]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for segment in segments {
        hasher.update(segment.0);
    }
    hasher.finalize().into()
}

/// A cache key: one segment under one backend build.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub segment: SegmentKey,
    pub scope: Arc<str>,
}

impl CacheKey {
    pub fn new(segment: SegmentKey, scope: impl Into<Arc<str>>) -> Self {
        Self {
            segment,
            scope: scope.into(),
        }
    }
}

/// Cached scores for one segment from one backend build.
#[derive(Debug, Clone, PartialEq)]
pub struct CachedScores {
    pub scores: Vec<(TaxonomyId, f32)>,
    pub covered: CodeSet,
    pub model_signal: ModelSignal,
    pub confidence: ConfidenceSource,
}

impl CachedScores {
    pub fn from_verdict(verdict: &ItemVerdict) -> Self {
        Self {
            scores: verdict.scores.clone(),
            covered: verdict.covered.clone(),
            model_signal: verdict.model_signal,
            confidence: verdict.confidence,
        }
    }

    pub fn into_verdict(self, key: SegmentKey) -> ItemVerdict {
        ItemVerdict {
            key,
            scores: self.scores,
            covered: self.covered,
            model_signal: self.model_signal,
            confidence: self.confidence,
        }
    }
}

/// Hit and miss counters, for the status route and SG-11.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub entries: usize,
}

/// A bounded LRU with a time to live per entry.
pub struct SegmentCache {
    inner: Mutex<LruCache<CacheKey, (Instant, CachedScores)>>,
    ttl: Duration,
    hits: AtomicU64,
    misses: AtomicU64,
}

impl Default for SegmentCache {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY, DEFAULT_TTL)
    }
}

impl SegmentCache {
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        let capacity = NonZeroUsize::new(capacity).unwrap_or(NonZeroUsize::MIN);
        Self {
            inner: Mutex::new(LruCache::new(capacity)),
            ttl,
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &CacheKey) -> Option<CachedScores> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let found = match inner.get(key) {
            Some((at, scores)) if at.elapsed() < self.ttl => Some(scores.clone()),
            Some(_) => {
                inner.pop(key);
                None
            }
            None => None,
        };
        drop(inner);
        if found.is_some() {
            self.hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.misses.fetch_add(1, Ordering::Relaxed);
        }
        found
    }

    pub fn insert(&self, key: CacheKey, scores: CachedScores) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.put(key, (Instant::now(), scores));
    }

    pub fn stats(&self) -> CacheStats {
        let entries = self.inner.lock().unwrap_or_else(|e| e.into_inner()).len();
        CacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            entries,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scores(v: f32) -> CachedScores {
        CachedScores {
            scores: vec![(TaxonomyId::S9, v)],
            covered: CodeSet::from([TaxonomyId::S9]),
            model_signal: ModelSignal::Allow,
            confidence: ConfidenceSource::Fixed,
        }
    }

    #[test]
    fn segment_key_is_keyed_scoped_and_class_bound() {
        let a = SegmentKey::for_text(b"org-a", LeafClass::User, "hello");
        assert_eq!(a, SegmentKey::for_text(b"org-a", LeafClass::User, "hello"));
        assert_ne!(a, SegmentKey::for_text(b"org-b", LeafClass::User, "hello"));
        assert_ne!(
            a,
            SegmentKey::for_text(b"org-a", LeafClass::System, "hello")
        );
        assert_ne!(a, SegmentKey::for_text(b"org-a", LeafClass::User, "hello!"));
        // Not a plain sha256 of the text.
        let plain: [u8; 32] = Sha256::digest(b"hello").into();
        assert_ne!(a.0, plain);
    }

    #[test]
    fn segment_key_is_bound_to_its_context() {
        let bare = SegmentKey::for_text(b"k", LeafClass::User, "tail");
        assert_eq!(
            SegmentKey::for_text_in_context(b"k", LeafClass::User, "tail", None),
            bare
        );
        let a = SegmentKey::for_text_in_context(b"k", LeafClass::User, "tail", Some("prefix a"));
        let b = SegmentKey::for_text_in_context(b"k", LeafClass::User, "tail", Some("prefix b"));
        assert_ne!(a, bare);
        assert_ne!(a, b);
        assert_eq!(
            a,
            SegmentKey::for_text_in_context(b"k", LeafClass::User, "tail", Some("prefix a"))
        );
        // The boundary between context and text is part of the key.
        assert_ne!(
            SegmentKey::for_text_in_context(b"k", LeafClass::User, "bc", Some("a")),
            SegmentKey::for_text_in_context(b"k", LeafClass::User, "c", Some("ab"))
        );
    }

    #[test]
    fn segment_key_normalizes_nfkc() {
        // U+FB01 LATIN SMALL LIGATURE FI and fullwidth letters fold to ASCII.
        let folded = SegmentKey::for_text(b"k", LeafClass::User, "\u{FB01}le \u{FF21}");
        assert_eq!(
            folded,
            SegmentKey::for_text(b"k", LeafClass::User, "file A")
        );
    }

    #[test]
    fn image_and_text_keys_never_collide() {
        let sha = [7u8; 32];
        let image = SegmentKey::for_image(b"k", LeafClass::User, &sha);
        let text = SegmentKey::for_text(b"k", LeafClass::User, &String::from_utf8_lossy(&sha));
        assert_ne!(image, text);
    }

    #[test]
    fn combination_key_depends_on_order() {
        let a = SegmentKey::for_text(b"k", LeafClass::User, "a");
        let b = SegmentKey::for_text(b"k", LeafClass::User, "b");
        assert_ne!(combination_key(&[a, b]), combination_key(&[b, a]));
        assert_eq!(combination_key(&[a, b]), combination_key(&[a, b]));
    }

    #[test]
    fn cache_key_includes_backend_scope() {
        let cache = SegmentCache::new(16, DEFAULT_TTL);
        let seg = SegmentKey::for_text(b"k", LeafClass::User, "x");
        cache.insert(CacheKey::new(seg, "guard_text@m@01234567#1"), scores(0.4));
        assert_eq!(
            cache.get(&CacheKey::new(seg, "guard_text@m@01234567#1")),
            Some(scores(0.4))
        );
        // A template bump is a different key (SG-11).
        assert_eq!(
            cache.get(&CacheKey::new(seg, "guard_text@m@01234567#2")),
            None
        );
        let stats = cache.stats();
        assert_eq!((stats.hits, stats.misses, stats.entries), (1, 1, 1));
    }

    #[test]
    fn entries_expire_and_capacity_evicts() {
        let cache = SegmentCache::new(2, Duration::from_millis(0));
        let seg = SegmentKey::for_text(b"k", LeafClass::User, "x");
        cache.insert(CacheKey::new(seg, "s"), scores(0.1));
        assert_eq!(
            cache.get(&CacheKey::new(seg, "s")),
            None,
            "zero ttl expires"
        );

        let cache = SegmentCache::new(2, DEFAULT_TTL);
        for text in ["a", "b", "c"] {
            let seg = SegmentKey::for_text(b"k", LeafClass::User, text);
            cache.insert(CacheKey::new(seg, "s"), scores(0.1));
        }
        let first = SegmentKey::for_text(b"k", LeafClass::User, "a");
        assert_eq!(
            cache.get(&CacheKey::new(first, "s")),
            None,
            "oldest evicted"
        );
        assert_eq!(cache.stats().entries, 2);
    }
}
