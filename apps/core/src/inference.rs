//! Core's kernel side of the extracted [`ryu_engines`] seam (re-export shim).
//!
//! The engine-agnostic inference *configuration* surface — [`Engine`],
//! [`SamplingConfig`] (per-request generation knobs) and [`LaunchConfig`]
//! (per-launch flags, including the llama.cpp continuous-batching defaults) —
//! now lives in the `ryu-engines` crate. This module is a pure path alias so the
//! ~16 in-crate consumers keep their `crate::inference::…` imports unchanged
//! (>15 sites → re-export shim, per the extraction pattern). No business logic
//! lives here.
//!
//! What did NOT move (documented so the next agent does not re-hunt it):
//! - the provider **launch lifecycle** (`sidecar/providers/*`) stays in Core —
//!   each provider implements the sidecar-manager kernel's `Sidecar` trait and
//!   reaches its download/path/version internals;
//! - the **embed** surface (`Embedder`/`Reranker` in `server/retrieval.rs`) is
//!   deferred to the `ryu-rag` wave (per-space embedder instance seam);
//! - the runtime **priority-admission queue** for continuous batching is blocked
//!   on `ryu-queue` (not yet extracted). This crate owns the batching *config
//!   flags*, not the admission runtime.

pub use ryu_engines::*;
