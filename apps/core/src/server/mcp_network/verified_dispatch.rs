//! Binds the verified bearer's caller around a network MCP dispatch.
//!
//! `/mcp/:agent_id` has no host conversation, so without this scope the org tool
//! policy resolves the principal as `Unresolved` and applies only the node
//! layer: a member-level deny or member-assigned guardrail never binds the
//! member's own calls. The REST `/api/mcp/tools/call` path binds the same scope.
//! The caller comes only from the verified bearer, never from the request body;
//! owner-token requests (no caller) keep the node-level behavior.

use crate::identity_verify::VerifiedCaller;

pub(in crate::server) async fn dispatch_as_verified_caller<T>(
    caller: Option<&VerifiedCaller>,
    dispatch: impl std::future::Future<Output = T>,
) -> T {
    match caller {
        Some(caller) => crate::sidecar::mcp::with_verified_tool_caller(caller, dispatch).await,
        None => dispatch.await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::mcp::ToolPrincipal;

    fn member(id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("acme".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        }
    }

    /// Regression: the org tool policy resolves its principal through
    /// `ToolPrincipal::resolve_optional` with no store or conversation on the
    /// network transport. Inside the dispatch it must see the verified member,
    /// so the member policy layer (keyed by `user_id`) is fetched and applied.
    #[tokio::test]
    async fn network_dispatch_resolves_the_verified_member() {
        let bob = member("bob");
        let principal = dispatch_as_verified_caller(Some(&bob), async {
            ToolPrincipal::resolve_optional(None, None).await
        })
        .await;
        assert_eq!(
            principal,
            ToolPrincipal::Owned {
                user_id: "bob".to_owned(),
                org_id: Some("acme".to_owned()),
            }
        );
    }

    #[tokio::test]
    async fn owner_token_dispatch_keeps_node_level_resolution() {
        let inside = dispatch_as_verified_caller(None, async {
            ToolPrincipal::resolve_optional(None, None).await
        })
        .await;
        let outside = ToolPrincipal::resolve_optional(None, None).await;
        assert_eq!(inside, outside);
        assert!(!matches!(inside, ToolPrincipal::Owned { .. }));
    }

    #[tokio::test]
    async fn the_scope_ends_with_the_dispatch() {
        let bob = member("bob");
        dispatch_as_verified_caller(Some(&bob), async {}).await;
        assert!(!matches!(
            ToolPrincipal::resolve_optional(None, None).await,
            ToolPrincipal::Owned { .. }
        ));
    }
}
