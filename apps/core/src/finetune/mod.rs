//! Fine-tuning feature (Unsloth integration).
//!
//! Core owns *what runs* (a fine-tune job on this node's GPU, or — Unit 5 — a
//! remote Ryu Cloud GPU node) and the durable job record; the actual training
//! happens in the Python sidecar (`crate::sidecar::providers::unsloth`). The HTTP
//! surface lives in [`crate::server::finetune`]; this module owns the persisted
//! [`store::FinetuneStore`].

pub mod adapters;
pub mod store;

pub use store::{FinetuneJob, FinetuneStore};
