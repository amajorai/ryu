//! Evals stage — extracted to the `ryu-gw-evals` crate (decomposition W6).
//!
//! This module is now a thin re-export shim: the built-in [`EvalsRunner`], the
//! swappable [`EvalsBackend`] trait + [`EvalsRegistry`], and the pure dataset
//! scorers ([`score_case`], [`aggregate_scores`], [`Assertion`], the judge
//! helpers, …) all live in the `ryu-gw-evals` crate. Keeping `crate::evals::…`
//! paths working means the extraction is invisible to every consumer
//! (`state.rs`, `pipeline`, `api::evals`, `evaluators`) — zero call-site churn.
//!
//! The [`EvalsConfig`] value-type also lives in the crate and is re-exported
//! from [`crate::config`], so `GatewayConfig` still embeds `evals` unchanged.

pub use ryu_gw_evals::*;
