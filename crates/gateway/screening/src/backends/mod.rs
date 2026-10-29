//! Screener backend adapters (screener addendum section 4).

pub mod decision;
pub mod guard_model;
pub mod inspector;
#[cfg(any(test, feature = "test-backends"))]
pub mod test;
