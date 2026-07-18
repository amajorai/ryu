//! Per-provider quota / rate-limit tracking — re-exported from the
//! `ryu-gw-providers` crate (decomposition W6). The `ProviderQuotas` sink and
//! `RateLimitInfo` moved to the providers crate (providers write into the sink
//! on every completion); this shim keeps existing `crate::quota::…` paths
//! byte-unchanged.

// `RateLimitInfo` flows in via the provider helpers so it is not named in the
// gateway proper; the re-export keeps its `crate::quota::RateLimitInfo` path valid.
#[allow(unused_imports)]
pub use ryu_gw_providers::quota::{ProviderQuotas, RateLimitInfo};
