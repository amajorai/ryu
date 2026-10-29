//! Ryu Gateway hazard screener backends (managed guardrails Phase 2,
//! screener addendum sections 3, 4 and 7.3).
//!
//! This crate holds the pluggable `ScreenerBackend` abstraction and
//! everything with no dependency on gateway types:
//!
//! - [`backend`]: the trait, request and verdict types, and the error set.
//! - [`chain`]: role composition. Local backends run concurrently, remote
//!   processors are fallback-only, the score per code is the maximum across
//!   backends, hard codes need a matching qualification, and every call is
//!   bounded by the surface deadline.
//! - [`safety_client`]: the isolated HTTP client (no redirects, 64 KiB cap,
//!   pinned endpoint, never the router or a provider slot).
//! - [`cache`]: keyed segment hashes and the per-replica score cache.
//! - [`backends`]: the closed-choice decision model on the `systemone` wire
//!   (local, the primary screener; remote Jev, opt-in), guard models (Llama
//!   Guard and Qwen3Guard dialects), the LLM-judge inspector adapter, and the
//!   sentinel `TestBackend`.
//!
//! The admission glue (floor parsing, the fail rules of section 6, receipts,
//! violation events) stays in `apps/gateway/src/screening/`.

pub mod backend;
pub mod backends;
pub mod cache;
pub mod chain;
pub mod safety_client;
#[cfg(any(test, feature = "test-backends"))]
pub mod testing;

pub use backend::{
    context_tail, estimate_tokens, estimate_tokens_chars, BackendDescriptor, BackendError,
    BackendHealth, BackendKind, BackendRef, BackendVerdict, CodeSet, ConfidenceSource, Direction,
    ItemVerdict, LeafClass, Locality, ModelSignal, ScreenImage, ScreenItem, ScreenRequest,
    ScreenTier, ScreenerBackend, TaxonomyId,
};
pub use cache::{combination_key, CacheKey, SegmentCache, SegmentKey};
pub use chain::{
    BackendOutcome, ChainPolicy, ChainVerdict, ComposedItem, CoverageError, FairShareKey,
    QualificationRecord, RemoteMode, Role, ScreenerChain,
};
pub use safety_client::{Endpoint, EndpointError, SafetyClient};

#[cfg(test)]
mod coverage_probe_tests;

#[cfg(test)]
mod release_guard {
    /// Spec SC-3 at the source level: no `RYU_TEST` string outside the
    /// test-gated modules and the testdata fixture.
    #[test]
    fn ungated_sources_carry_no_test_sentinel() {
        let ungated = [
            include_str!("backend.rs"),
            include_str!("cache.rs"),
            include_str!("safety_client.rs"),
            include_str!("backends/mod.rs"),
            include_str!("backends/guard_model.rs"),
            include_str!("backends/decision.rs"),
            include_str!("backends/inspector.rs"),
        ];
        let needle = concat!("RYU", "_TEST");
        for source in ungated {
            assert!(!source.contains(needle));
        }
    }
}
