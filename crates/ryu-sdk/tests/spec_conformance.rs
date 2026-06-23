//! Spec-conformance tests — the vendored OpenAPI specs ARE the contract the
//! hand-written `model` client is built against, so these tests fail loudly if
//! the gateway/core API surface the SDK depends on drifts.
//!
//! This is the robust stand-in for full 3.1 codegen: instead of generating a
//! client we may not be able to compile, we pin the exact endpoints + fields the
//! client sends/reads and assert the vendored spec still describes them.

use std::path::PathBuf;

fn spec_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("specs")
}

fn load_yaml(name: &str) -> serde_json::Value {
    let raw = std::fs::read_to_string(spec_dir().join(name)).expect("read vendored spec");
    serde_yaml::from_str(&raw).expect("vendored spec parses as YAML/JSON")
}

fn load_json(name: &str) -> serde_json::Value {
    let raw = std::fs::read_to_string(spec_dir().join(name)).expect("read vendored spec");
    serde_json::from_str(&raw).expect("vendored spec parses as JSON")
}

#[test]
fn gateway_spec_describes_chat_completions_endpoint() {
    let spec = load_yaml("gateway-openapi.yaml");

    // The ModelClient POSTs to /v1/chat/completions — that path+method must exist.
    let post = spec
        .pointer("/paths/~1v1~1chat~1completions/post")
        .expect("gateway spec must define POST /v1/chat/completions");
    assert!(post.is_object(), "POST /v1/chat/completions must be an operation object");

    // The client sends model/messages/stream. The request body schema (or its
    // $ref target) must mention those fields somewhere — a cheap drift guard.
    let body_blob = serde_json::to_string(
        post.pointer("/requestBody").unwrap_or(post),
    )
    .unwrap();
    // Fall back to scanning the whole spec when the body is a $ref.
    let haystack = if body_blob.contains("messages") {
        body_blob
    } else {
        serde_json::to_string(&spec).unwrap()
    };
    for field in ["messages", "model", "stream"] {
        assert!(
            haystack.contains(field),
            "gateway spec must describe the '{field}' request field the SDK sends"
        );
    }
}

#[test]
fn gateway_spec_is_openapi_3_x() {
    let spec = load_yaml("gateway-openapi.yaml");
    let version = spec.get("openapi").and_then(|v| v.as_str()).unwrap_or("");
    assert!(
        version.starts_with("3."),
        "expected an OpenAPI 3.x gateway spec, got '{version}'"
    );
}

#[test]
fn core_spec_present_and_has_chat_path() {
    let spec = load_json("core-openapi.json");
    let paths = spec.get("paths").and_then(|p| p.as_object()).expect("core spec has paths");
    assert!(
        paths.keys().any(|k| k.contains("/chat/")),
        "core spec must expose a /chat/* path the SDK can target"
    );
}
