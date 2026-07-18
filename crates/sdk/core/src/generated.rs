//! OpenAPI-generated gateway client (compiled only with `--features codegen`).
//!
//! The contents are produced by `build.rs` from `specs/gateway-openapi.yaml`
//! and written to `OUT_DIR/gateway_client.rs`. See the crate docs and `build.rs`
//! for why this is opt-in (the vendored spec is OpenAPI 3.1).
include!(concat!(env!("OUT_DIR"), "/gateway_client.rs"));
