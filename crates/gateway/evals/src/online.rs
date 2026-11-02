//! Online evals: score a sampled fraction of production traffic with catalog
//! evaluators, asynchronously and off the request hot path.
//!
//! This module owns the transport-free half of online evaluation so it can be
//! unit-tested without a provider:
//!
//! * [`OnlineEvalsConfig`] — the `[evals.online]` config block, opt-in
//!   (`enabled = false` by default) with per-tenant overrides;
//! * [`OnlineEvalsConfig::resolve`] — the per-tenant effective policy;
//! * [`sampled`] — deterministic, request-id-keyed sampling, so a request's
//!   inclusion does not depend on unrelated traffic interleaving;
//! * [`OnlineEvals`] — the bounded hand-off queue (`try_send`, never awaits on
//!   the request path), the per-tenant judge-call budget, the bounded result
//!   store, and the counters the evals API reports.
//!
//! The Gateway owns the worker that drains the queue (it needs the pipeline to
//! run LLM-judge evaluators through the governed provider path), so judge
//! calls are budgeted, firewalled, and audited like any other model call.
//!
//! The config and sampling live in `config`, the job and record shapes in
//! `record`, and the shared state in `store`; every item is re-exported here
//! so callers keep naming `ryu_gw_evals::online::<item>`.

mod config;
mod record;
mod store;

pub use config::{
    clip_text, sampled, trace_id_from_traceparent, OnlineEvalsConfig, OnlineTenantConfig,
    OnlineTenantPolicy, LOCAL_TENANT,
};
pub use record::{OnlineEvalJob, OnlineEvalQuery, OnlineEvalRecord};
pub use store::{OfferOutcome, OnlineEvalStats, OnlineEvals};
