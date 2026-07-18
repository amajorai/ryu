//! Exact-match cache stage — extracted to the `ryu-gw-cache` crate (decomposition W6).
//!
//! This module is now a thin re-export shim: the built-in [`Cache`], the
//! swappable [`CacheBackend`] trait + [`CacheRegistry`], and the [`CacheConfig`]
//! value-type all live in the `ryu-gw-cache` crate (`exact` module). Keeping
//! `crate::cache::…` paths working (pipeline `make_key` / cache get+insert,
//! `state.rs` wiring + its `StubCache` test) means the extraction is invisible
//! to every consumer — zero call-site churn. `CacheConfig` is also re-exported
//! from [`crate::config`], so `GatewayConfig` still embeds `cache` unchanged.

pub use ryu_gw_cache::exact::*;
