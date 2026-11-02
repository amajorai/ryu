//! What a tool call reaching Core over HTTP may do with the node owner's authority.
//!
//! On an unbound (personal) node two tool paths run as the node owner whoever
//! asked: the self-API (`ryu_api.*`) and derived app-API (`ryu_ext.*`) tools
//! loop back into Core with the owner token, and a named host conversation lets
//! the approval gate consume the "Allow for this chat" grants the owner gave in
//! that conversation. A paired device or other scoped credential holding only
//! `tools:exec` must not reach either: it would read owner-only routes its grant
//! denies, or replay the owner's in-chat consent with its own arguments.
//!
//! The auth middleware records, for every authenticated request, whether it was
//! admitted with the owner token ([`super::REQUEST_PRESENTS_OWNER_TOKEN`]). Work
//! outside an HTTP request (in-process agent turns, the ACP broker routes that
//! authenticate their own session capability) has no such scope and is
//! unaffected.

/// Whether the HTTP request being served was admitted with a credential other
/// than the node owner token. False outside an authenticated HTTP request.
pub(crate) fn request_admitted_without_owner_token() -> bool {
    super::REQUEST_PRESENTS_OWNER_TOKEN
        .try_with(|owner| !*owner)
        .unwrap_or(false)
}

/// Why `tool_id`, a loopback tool that would run with the node owner's
/// authority, is refused for the request being served; `None` when allowed.
pub(crate) fn owner_loopback_refusal(tool_id: &str) -> Option<String> {
    request_admitted_without_owner_token().then(|| {
        format!(
            "`{tool_id}` runs with the node owner's authority, so it is available only \
             to the owner or to the node's own agents; this request used a scoped \
             credential"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    async fn as_request<T>(owner_token: bool, future: impl std::future::Future<Output = T>) -> T {
        super::super::REQUEST_PRESENTS_OWNER_TOKEN
            .scope(owner_token, future)
            .await
    }

    #[tokio::test]
    async fn only_a_non_owner_http_request_is_restricted() {
        assert!(!request_admitted_without_owner_token());
        assert!(owner_loopback_refusal("ryu_api.get_api_conversations").is_none());
        assert!(!as_request(true, async { request_admitted_without_owner_token() }).await);
        assert!(as_request(false, async { request_admitted_without_owner_token() }).await);
        let refusal = as_request(false, async {
            owner_loopback_refusal("ryu_api.get_api_conversations")
        })
        .await
        .expect("a scoped credential is refused");
        assert!(refusal.contains("ryu_api.get_api_conversations"));
    }

    /// A paired `tools:exec` client on an unbound node must not name the owner's
    /// conversation without the forwarder proof: that would let it consume the
    /// owner's in-chat grants with its own arguments.
    #[tokio::test]
    async fn a_scoped_credential_needs_the_forwarder_proof_to_name_a_host_conversation() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let authorize = |proof: Option<String>| {
            let state = state.clone();
            async move {
                super::super::authorize_tool_host_conversation(
                    &state,
                    None,
                    Some("owner-chat"),
                    proof.as_deref(),
                )
                .await
            }
        };

        let refused = as_request(false, authorize(None))
            .await
            .expect_err("a scoped credential cannot name a host conversation");
        assert_eq!(refused.0, StatusCode::FORBIDDEN);

        let proof = super::super::host_conversation_proof("owner-chat");
        assert_eq!(
            as_request(false, authorize(Some(proof))).await.unwrap(),
            Some("owner-chat".to_owned())
        );
        assert_eq!(
            as_request(true, authorize(None)).await.unwrap(),
            Some("owner-chat".to_owned())
        );
        // In-process callers (no HTTP request) keep the personal-node behaviour.
        assert_eq!(
            authorize(None).await.unwrap(),
            Some("owner-chat".to_owned())
        );
    }

    /// The self-API and app-API loopbacks run as the node owner, so a scoped
    /// credential's request must not reach them, directly or through another tool.
    #[tokio::test]
    async fn a_scoped_credential_cannot_run_owner_loopback_tools() {
        let registry = crate::sidecar::mcp::McpRegistry::empty();
        let call = |tool: &'static str| {
            let registry = &registry;
            async move {
                registry
                    .call_tool_with_identity_no_gate_scoped(
                        None,
                        tool,
                        serde_json::json!({ "id": "acp:claude" }),
                        None,
                        None,
                        &[],
                        None,
                        None,
                        None,
                        None,
                        false,
                    )
                    .await
            }
        };
        for tool in [
            "ryu_api.get_api_agents_id_acp_settings",
            "ryu_api.get_api_conversations",
        ] {
            let error = as_request(false, call(tool))
                .await
                .expect_err("a scoped credential is refused");
            assert!(
                error.to_string().contains("node owner's authority"),
                "{tool}: {error}"
            );
            // The owner token is not refused by this check (the loopback itself
            // may still fail in a test without a listener).
            if let Err(error) = as_request(true, call(tool)).await {
                assert!(
                    !error.to_string().contains("node owner's authority"),
                    "{tool}: {error}"
                );
            }
        }
    }
}
