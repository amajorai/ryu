//! GenAI content helpers for content-mode OTLP export.
//!
//! The message format and per-span byte cap are shared with Core, so they are
//! defined once in `ryu_gw_contracts::gen_ai_content`; this module keeps the
//! `telemetry::content` path for the Gateway's call sites.

pub use ryu_gw_contracts::gen_ai_content::*;
