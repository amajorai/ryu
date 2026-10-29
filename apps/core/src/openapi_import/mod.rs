//! OpenAPI → tool descriptors (Slice 2c of the integrations.sh install-abstraction).
//!
//! The pure transform lives in the `ryu-openapi-import` crate
//! (`crates/core/openapi-import`), so its rules are shared with Ryu's generated
//! tool catalog tier (`tools/tool-catalog-generate/`, Treg parity C1) through
//! one golden case file and are tested without building Core. This module keeps
//! the `crate::openapi_import` path every Core caller already uses.

pub use ryu_openapi_import::*;
