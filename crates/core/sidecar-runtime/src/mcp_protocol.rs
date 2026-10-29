//! The MCP protocol negotiation every stdio app server speaks: legacy
//! `initialize` clients and modern clients that send `protocolVersion` and
//! `clientCapabilities` in each request's `_meta`.
//!
//! Each server keeps its own serve loop and tool dispatch; it calls
//! [`request_is_modern`] per frame, answers refusals with [`protocol_error`],
//! answers `server/discover` with [`discover_result`], and passes every
//! response through [`finalize_response`].

use serde_json::{json, Value};

/// The legacy (`initialize`-handshake) MCP protocol version.
pub const PROTOCOL_VERSION: &str = "2024-11-05";
/// The modern (per-request `_meta`) MCP protocol version.
pub const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";
const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
/// The result `_meta` key that carries the server name and version.
pub const SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

/// A JSON-RPC protocol error for a request the server will not dispatch.
#[derive(Debug)]
pub struct ProtocolError {
    pub code: i64,
    pub message: &'static str,
    pub data: Option<Value>,
}

fn invalid_modern_params() -> ProtocolError {
    ProtocolError {
        code: -32602,
        message:
            "modern MCP requests require protocolVersion and clientCapabilities in params._meta",
        data: None,
    }
}

/// Whether `frame` is a modern request (validated `_meta`), a legacy one (after
/// `initialize`), or must be refused.
pub fn request_is_modern(
    frame: &Value,
    method: &str,
    legacy_initialized: bool,
) -> Result<bool, ProtocolError> {
    let metadata = frame.get("params").and_then(|params| params.get("_meta"));

    if metadata.is_none() {
        if method == "server/discover" {
            return Err(invalid_modern_params());
        }
        return if method == "initialize" || legacy_initialized {
            Ok(false)
        } else {
            Err(invalid_modern_params())
        };
    }
    let Some(metadata) = metadata.and_then(Value::as_object) else {
        return Err(invalid_modern_params());
    };

    let is_modern = method == "server/discover"
        || metadata.contains_key(META_PROTOCOL_VERSION)
        || metadata.contains_key(META_CLIENT_CAPABILITIES);
    if !is_modern {
        return if method == "initialize" || legacy_initialized {
            Ok(false)
        } else {
            Err(invalid_modern_params())
        };
    }

    let version = metadata
        .get(META_PROTOCOL_VERSION)
        .and_then(Value::as_str)
        .ok_or_else(invalid_modern_params)?;
    if metadata
        .get(META_CLIENT_CAPABILITIES)
        .and_then(Value::as_object)
        .is_none()
    {
        return Err(invalid_modern_params());
    }
    if let Some(client_info) = metadata.get(META_CLIENT_INFO) {
        let valid_client_info = client_info.as_object().is_some_and(|info| {
            info.get("name").and_then(Value::as_str).is_some()
                && info.get("version").and_then(Value::as_str).is_some()
        });
        if !valid_client_info {
            return Err(invalid_modern_params());
        }
    }
    if version != MODERN_PROTOCOL_VERSION {
        return Err(ProtocolError {
            code: -32022,
            message: "Unsupported protocol version",
            data: Some(json!({
                "supported": [MODERN_PROTOCOL_VERSION],
                "requested": version,
            })),
        });
    }
    Ok(true)
}

/// The JSON-RPC error response for a refused request.
pub fn protocol_error(id: Value, error: ProtocolError) -> Value {
    let mut details = json!({ "code": error.code, "message": error.message });
    if let Some(data) = error.data {
        details["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": details })
}

/// Stamp a modern response's result with `resultType`, the `tools/list` cache
/// hints and the server info; legacy responses pass through unchanged.
pub fn finalize_response(
    mut response: Value,
    modern: bool,
    method: &str,
    server_name: &str,
    server_version: &str,
) -> Value {
    if !modern {
        return response;
    }
    let Some(result) = response.get_mut("result").and_then(Value::as_object_mut) else {
        return response;
    };
    result
        .entry("resultType".to_owned())
        .or_insert_with(|| json!("complete"));
    if method == "tools/list" {
        result
            .entry("ttlMs".to_owned())
            .or_insert_with(|| json!(300_000));
        result
            .entry("cacheScope".to_owned())
            .or_insert_with(|| json!("public"));
    }
    result.insert(
        "_meta".to_owned(),
        json!({ (SERVER_INFO): { "name": server_name, "version": server_version } }),
    );
    response
}

/// The `server/discover` result.
pub fn discover_result() -> Value {
    json!({
        "supportedVersions": [MODERN_PROTOCOL_VERSION],
        "capabilities": { "tools": {} },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(version: &str) -> Value {
        json!({
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
        })
    }

    fn request(method: &str, meta: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": { "_meta": meta },
        })
    }

    #[test]
    fn modern_metadata_is_checked_without_downgrading_malformed_meta() {
        let modern = request("tools/list", metadata(MODERN_PROTOCOL_VERSION));
        assert!(request_is_modern(&modern, "tools/list", false).unwrap());

        let malformed = json!({
            "method": "tools/list",
            "params": { "_meta": "malformed" },
        });
        let error = request_is_modern(&malformed, "tools/list", true).unwrap_err();
        assert_eq!(error.code, -32602);

        let unsupported = request("tools/list", metadata("2025-11-25"));
        let error = request_is_modern(&unsupported, "tools/list", false).unwrap_err();
        assert_eq!(error.code, -32022);
        assert_eq!(
            error.data.as_ref().unwrap()["supported"][0],
            MODERN_PROTOCOL_VERSION
        );
        assert_eq!(error.data.as_ref().unwrap()["requested"], "2025-11-25");
    }

    #[test]
    fn discovery_has_result_metadata_but_only_list_results_have_cache_hints() {
        let discover = finalize_response(
            json!({ "jsonrpc": "2.0", "id": 1, "result": discover_result() }),
            true,
            "server/discover",
            "test-server",
            "0.0.0-test",
        );
        assert_eq!(discover["result"]["resultType"], "complete");
        assert!(discover["result"].get("ttlMs").is_none());
        assert!(discover["result"].get("cacheScope").is_none());
        assert_eq!(
            discover["result"]["_meta"][SERVER_INFO]["name"],
            "test-server"
        );
        assert_eq!(
            discover["result"]["_meta"][SERVER_INFO]["version"],
            "0.0.0-test"
        );

        let list = finalize_response(
            json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": [] } }),
            true,
            "tools/list",
            "test-server",
            "0.0.0-test",
        );
        assert_eq!(list["result"]["resultType"], "complete");
        assert_eq!(list["result"]["ttlMs"], 300_000);
        assert_eq!(list["result"]["cacheScope"], "public");
    }

    #[test]
    fn initialize_clients_keep_the_legacy_wire_shape() {
        let initialize = json!({
            "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" },
        });
        assert!(!request_is_modern(&initialize, "initialize", false).unwrap());

        let legacy = finalize_response(
            json!({ "jsonrpc": "2.0", "id": 2, "result": { "tools": [] } }),
            false,
            "tools/list",
            "test-server",
            "0.0.0-test",
        );
        assert_eq!(legacy["result"]["tools"], json!([]));
        assert!(legacy["result"].get("resultType").is_none());
        assert!(legacy["result"].get("ttlMs").is_none());
        assert!(legacy["result"].get("_meta").is_none());
    }
}
