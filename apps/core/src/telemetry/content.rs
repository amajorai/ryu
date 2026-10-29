//! GenAI content helpers for content-mode OTLP export.
//!
//! The message format and per-span byte cap are shared with the Gateway, so they
//! are defined once in `ryu_channel_contracts::gen_ai_content`; this module keeps
//! the `telemetry::content` path for Core's call sites.

pub use ryu_channel_contracts::gen_ai_content::*;
