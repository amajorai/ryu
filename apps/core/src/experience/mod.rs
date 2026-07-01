//! Experience buffer for the continual-learning loop.
//!
//! See [`store`] for the durable record and
//! `docs/continual-learning-metaclaw-spec.md` for the overall design. The
//! learning logic (sweep, PRM scoring, skill synthesis, retrain cycle) lives in
//! [`crate::learning`]; this module owns only the storage.

pub mod store;

pub use store::{Experience, ExperienceStore};
