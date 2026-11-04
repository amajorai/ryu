use crate::server::validate_mcp_http_request;
use axum::http::{HeaderMap, HeaderValue};
use serde_json::json;

fn modern_headers(method: &'static str, name: Option<&'static str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "MCP-Protocol-Version",
        HeaderValue::from_static("2026-07-28"),
    );
    headers.insert("Mcp-Method", HeaderValue::from_static(method));
    if let Some(name) = name {
        headers.insert("Mcp-Name", HeaderValue::from_static(name));
    }
    headers
}

fn modern_call() -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "threads.list_threads",
            "arguments": {},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {}
            }
        }
    })
}

#[test]
fn modern_http_requires_per_request_metadata_and_matching_routing_headers() {
    let request = modern_call();
    assert_eq!(
        validate_mcp_http_request(
            "tools/call",
            &request,
            &modern_headers("tools/call", Some("threads.list_threads"))
        )
        .unwrap(),
        (true, Some("2026-07-28"))
    );

    let mut encoded_name_request = request.clone();
    encoded_name_request["params"]["name"] = json!("Hello, 世界");
    assert_eq!(
        validate_mcp_http_request(
            "tools/call",
            &encoded_name_request,
            &modern_headers("tools/call", Some("=?base64?SGVsbG8sIOS4lueVjA==?="))
        )
        .unwrap(),
        (true, Some("2026-07-28"))
    );

    let mut mismatched = modern_headers("tools/list", Some("threads.list_threads"));
    assert_eq!(
        validate_mcp_http_request("tools/call", &request, &mismatched).unwrap_err()["error"]
            ["code"],
        json!(-32_020)
    );
    mismatched = modern_headers("tools/call", Some("threads.read_thread"));
    assert_eq!(
        validate_mcp_http_request("tools/call", &request, &mismatched).unwrap_err()["error"]
            ["message"],
        json!("Mcp-Name must match a named tool, resource, or prompt request")
    );

    let mut missing_method = modern_headers("tools/call", Some("threads.list_threads"));
    missing_method.remove("Mcp-Method");
    assert_eq!(
        validate_mcp_http_request("tools/call", &request, &missing_method).unwrap_err()["error"]
            ["code"],
        json!(-32_020)
    );

    let mut mismatched_version = request.clone();
    mismatched_version["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] =
        json!("2025-11-25");
    assert_eq!(
        validate_mcp_http_request(
            "tools/call",
            &mismatched_version,
            &modern_headers("tools/call", Some("threads.list_threads"))
        )
        .unwrap_err()["error"]["code"],
        json!(-32_020)
    );

    let mut missing_capabilities = request.clone();
    missing_capabilities["params"]["_meta"]
        .as_object_mut()
        .unwrap()
        .remove("io.modelcontextprotocol/clientCapabilities");
    assert_eq!(
        validate_mcp_http_request(
            "tools/call",
            &missing_capabilities,
            &modern_headers("tools/call", Some("threads.list_threads"))
        )
        .unwrap_err()["error"]["code"],
        json!(-32_600)
    );

    let task_get = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tasks/get",
        "params": {
            "taskId": "task-123",
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {
                    "extensions": { "io.modelcontextprotocol/tasks": {} }
                }
            }
        }
    });
    assert_eq!(
        validate_mcp_http_request(
            "tasks/get",
            &task_get,
            &modern_headers("tasks/get", Some("task-123"))
        )
        .unwrap(),
        (true, Some("2026-07-28"))
    );
    assert_eq!(
        validate_mcp_http_request(
            "tasks/get",
            &task_get,
            &modern_headers("tasks/get", Some("wrong-task"))
        )
        .unwrap_err()["error"]["code"],
        json!(-32_020)
    );
}

#[test]
fn unsupported_versions_return_the_supported_version_list_and_legacy_initialize_survives() {
    let request = modern_call();
    let mut headers = modern_headers("tools/call", Some("threads.list_threads"));
    headers.insert(
        "MCP-Protocol-Version",
        HeaderValue::from_static("1900-01-01"),
    );
    let error = validate_mcp_http_request("tools/call", &request, &headers).unwrap_err();
    assert_eq!(error["error"]["code"], json!(-32_022));
    assert_eq!(error["error"]["data"]["requested"], json!("1900-01-01"));
    assert_eq!(error["error"]["data"]["supported"][0], json!("2026-07-28"));

    let legacy = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} });
    assert_eq!(
        validate_mcp_http_request("initialize", &legacy, &HeaderMap::new()).unwrap(),
        (false, None)
    );
    assert_eq!(
        validate_mcp_http_request(
            "tools/list",
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            &HeaderMap::new()
        )
        .unwrap_err()["error"]["code"],
        json!(-32_020)
    );
}
