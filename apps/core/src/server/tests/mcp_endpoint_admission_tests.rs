use crate::server::{
    mcp_admission, mcp_batch_refusal, mcp_principal_resolves, signed_agent_binding_allows,
};
use axum::http::StatusCode;
use serde_json::json;

/// The full `ServerState` (~40 fields, real stores, real sidecar managers) is
/// not constructible in a unit test, so the admission decision lives in a pure
/// function and is tested there. These assert the DECISION, not the routing:
/// `mcp_http_inner` is three lines of plumbing over this function, and the
/// route registration is asserted by the compiler.

/// The agent principal is required and must resolve. `agent_id` is the only
/// thing that pins a call to one agent's allowlist, capabilities,
/// `approval_tools`, skill scoping and vault bindings; a caller free to invent
/// one is authorized as nobody, which is the value that means *unrestricted*
/// downstream.
#[test]
fn mcp_endpoint_requires_a_known_agent_id() {
    // Empty (a client that POSTed the bare base URL) → 400, not 403: nothing
    // was claimed, so nothing was rejected — the request is malformed.
    let (status, message) = mcp_admission(true, "", false).expect("empty id is refused");
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        message.contains("/mcp/<agent_id>"),
        "the 400 must show the shape that works: {message}"
    );

    // Named but unknown → 403. The node bearer was valid; the principal was not.
    let (status, message) =
        mcp_admission(true, "ghost-agent", false).expect("unknown id is refused");
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(message.contains("ghost-agent"), "{message}");

    // Known → admitted.
    assert!(
        mcp_admission(true, "ryu", true).is_none(),
        "a resolvable agent on a tokened node proceeds"
    );
}

#[test]
fn signed_tool_delegation_cannot_select_another_agent() {
    assert!(signed_agent_binding_allows(None, "agent-b"));
    assert!(signed_agent_binding_allows(Some("agent-a"), "agent-a"));
    assert!(!signed_agent_binding_allows(Some("agent-a"), "agent-b"));
}

/// THE route-specific rule. `require_auth` short-circuits to `next.run(req)`
/// when no node token is configured, so on a stock loopback dev node every
/// protected route is open — and `/mcp` must not be, because it dispatches
/// registry tools for whoever can POST to it. This is the one route that
/// refuses where the shared middleware would admit.
#[test]
fn mcp_endpoint_refuses_when_no_node_token_is_configured() {
    // Refused even with a perfectly good agent id: the missing token is
    // checked FIRST, so no principal can buy past it.
    let (status, message) =
        mcp_admission(false, "ryu", true).expect("a tokenless node refuses /mcp");
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        message.contains("RYU_TOKEN"),
        "the refusal must say how to configure the node: {message}"
    );

    // And with no agent either — still 401, never the 400. The order matters:
    // reporting "name an agent" on an unauthenticated node would tell an
    // anonymous caller the endpoint exists and what to send next.
    let (status, _) = mcp_admission(false, "", false).expect("refused");
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // The same request on a tokened node is admitted — proving the refusal is
    // the token check and not something else in the guard.
    assert!(mcp_admission(true, "ryu", true).is_none());
}

/// The principal must be EXACT. `AcpAgentRegistry::find_by_prefix` — the
/// resolver this route deliberately does not use — matches when
/// `agent_id.starts_with(&entry.id)`, so under it a caller chooses which
/// agent's allowlist, capabilities, `approval_tools` and vault bindings it is
/// judged against simply by picking a string. That is a forged principal, and
/// it makes the route's own security claim false.
#[test]
fn mcp_endpoint_refuses_a_prefix_of_a_known_agent_id() {
    const REGISTRY: [&str; 2] = ["claude", "ryu"];

    // Exact ids resolve.
    for id in REGISTRY {
        assert!(
            mcp_principal_resolves(id, false, REGISTRY.into_iter()),
            "{id} is a registry entry and must resolve"
        );
    }

    // A PREFIX of a known id does not — this is the finding.
    for forged in ["c", "cl", "clau", "r", "ry"] {
        assert!(
            !mcp_principal_resolves(forged, false, REGISTRY.into_iter()),
            "{forged:?} is a prefix of a known agent, not an agent"
        );
        let (status, _) = mcp_admission(true, forged, false)
            .expect("a prefix must be refused, not admitted as what it matched");
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    // Nor does an EXTENSION of a known id, which is the direction
    // `find_by_prefix` actually matches in: `ryu-anything` starts with `ryu`,
    // so that resolver would admit it as the flagship agent.
    assert!(
        !mcp_principal_resolves("ryu-anything", false, REGISTRY.into_iter()),
        "an id that merely starts with a known id is a different id"
    );

    // A user-created agent resolves through the store instead, still exactly.
    assert!(mcp_principal_resolves(
        "my-own-agent",
        true,
        REGISTRY.into_iter()
    ));
    // …and an empty id resolves through neither, whatever the store says.
    assert!(!mcp_principal_resolves("", true, REGISTRY.into_iter()));
}

/// The endpoint advertises MCP revision `2025-06-18`, which REMOVED JSON-RPC
/// batching — so an array is refused rather than served. That is both spec
/// conformance and the fix for an amplification lever: one authenticated
/// request must fan out into one tool dispatch, not N with no element cap and
/// no whole-batch deadline.
#[test]
fn mcp_endpoint_refuses_a_json_rpc_batch() {
    let batch = json!([
        { "jsonrpc": "2.0", "id": 1, "method": "tools/list" },
        { "jsonrpc": "2.0", "id": 2, "method": "tools/list" },
    ]);
    let refusal = mcp_batch_refusal(&batch).expect("an array must be refused");
    // A JSON-RPC error object, not an HTTP 4xx body: the client speaks JSON-RPC.
    assert_eq!(refusal["jsonrpc"], "2.0");
    assert!(
        refusal["id"].is_null(),
        "a batch has no single id to answer"
    );
    assert_eq!(refusal["error"]["code"], -32_600);
    let message = refusal["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("2025-06-18"),
        "the refusal must say which revision removed batching: {message}"
    );

    // An empty array is still an array — refusing only non-empty ones would
    // leave the loop reachable.
    assert!(mcp_batch_refusal(&json!([])).is_some());

    // A single message is untouched.
    assert!(
        mcp_batch_refusal(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).is_none()
    );
}

/// Caller-supplied text on its way into a log line and a response body is
/// bounded and stripped of control characters. Unauthenticated input becomes a
/// forged log row otherwise, and a megabyte-long "id" is not a diagnostic.
#[test]
fn an_unknown_principal_is_echoed_bounded_and_sanitized() {
    let (_, message) = mcp_admission(true, "ghost\nagent", false).expect("refused");
    assert!(
        !message.contains('\n'),
        "a newline in caller input must not reach the log line: {message:?}"
    );
    assert!(message.contains("ghostagent"), "{message}");

    let long = "a".repeat(500);
    let (_, message) = mcp_admission(true, &long, false).expect("refused");
    assert!(
        message.len() < 200,
        "the echoed principal must be bounded: {} chars",
        message.len()
    );
    assert!(
        message.contains('…'),
        "truncation must be visible: {message}"
    );
}
