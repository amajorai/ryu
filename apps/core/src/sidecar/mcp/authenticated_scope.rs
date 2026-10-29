//! Verified authority for an awaited non-chat tool dispatch. This scope is never
//! deserialized from arguments and is not inherited by spawned background tasks.
use super::ToolPrincipal;
use crate::identity_verify::VerifiedCaller;

tokio::task_local! {
    static VERIFIED_TOOL_PRINCIPAL: ToolPrincipal;
}

pub(super) fn current_principal() -> Option<ToolPrincipal> {
    VERIFIED_TOOL_PRINCIPAL.try_with(Clone::clone).ok()
}

pub(crate) async fn with_verified_tool_caller<T>(
    caller: &VerifiedCaller,
    future: impl std::future::Future<Output = T>,
) -> T {
    VERIFIED_TOOL_PRINCIPAL
        .scope(
            ToolPrincipal::Owned {
                user_id: caller.user_id.clone(),
                org_id: caller.org_id.clone(),
            },
            future,
        )
        .await
}

/// Run `future` with an arbitrary principal in scope. Tests only: it lets
/// registry tests reach the `ToolPrincipal::Unresolved` refusals, which otherwise
/// need an org-bound node that a unit test cannot register.
#[cfg(test)]
pub(super) async fn with_principal_for_tests<T>(
    principal: ToolPrincipal,
    future: impl std::future::Future<Output = T>,
) -> T {
    VERIFIED_TOOL_PRINCIPAL.scope(principal, future).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("workspace".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        }
    }

    #[tokio::test]
    async fn concurrent_visitors_keep_separate_authority() {
        let alice = caller("alice");
        let bob = caller("bob");
        async fn resolve() -> Option<ToolPrincipal> {
            tokio::task::yield_now().await;
            current_principal()
        }
        let (first, second) = tokio::join!(
            with_verified_tool_caller(&alice, resolve()),
            with_verified_tool_caller(&bob, resolve()),
        );
        assert_eq!(
            first,
            Some(ToolPrincipal::Owned {
                user_id: "alice".to_owned(),
                org_id: Some("workspace".to_owned())
            })
        );
        assert_eq!(
            second,
            Some(ToolPrincipal::Owned {
                user_id: "bob".to_owned(),
                org_id: Some("workspace".to_owned())
            })
        );
        assert!(current_principal().is_none());
    }

    #[tokio::test]
    async fn background_tasks_do_not_inherit_visitor_authority() {
        with_verified_tool_caller(&caller("alice"), async {
            assert!(current_principal().is_some());
            assert!(tokio::spawn(async { current_principal().is_none() })
                .await
                .unwrap());
        })
        .await;
    }

    #[tokio::test]
    async fn nested_scope_restores_the_original_visitor() {
        with_verified_tool_caller(&caller("alice"), async {
            with_verified_tool_caller(&caller("bob"), async {
                assert!(matches!(current_principal(), Some(ToolPrincipal::Owned { user_id, .. }) if user_id == "bob"));
            }).await;
            assert!(matches!(current_principal(), Some(ToolPrincipal::Owned { user_id, .. }) if user_id == "alice"));
        }).await;
        assert!(current_principal().is_none());
    }
}
