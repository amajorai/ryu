//! Verified authority for an awaited non-chat tool dispatch. This scope is never
//! deserialized from arguments and is not inherited by spawned background tasks.
use super::ToolPrincipal;
use crate::identity_verify::VerifiedCaller;

/// The principal in scope plus, when it came from a verified bearer, that exact
/// caller. A tool that must apply the same read filter as the REST plane (team
/// memberships included) needs the caller, not just the principal derived from it.
#[derive(Clone)]
struct VerifiedToolScope {
    principal: ToolPrincipal,
    caller: Option<VerifiedCaller>,
}

tokio::task_local! {
    static VERIFIED_TOOL_SCOPE: VerifiedToolScope;
    /// The verified human who sent the live chat turn this dispatch serves.
    /// Kept apart from `VERIFIED_TOOL_SCOPE` so it never changes the principal
    /// or the vault's secret owner; it only feeds a principal-matched read
    /// filter (`search_conversations` team visibility).
    static TURN_SENDER: VerifiedCaller;
}

/// Run `future` knowing who sent the turn it serves. Callers bind the sender
/// only to a dispatch provably serving that sender's live turn.
pub(crate) async fn with_turn_sender<T>(
    sender: &VerifiedCaller,
    future: impl std::future::Future<Output = T>,
) -> T {
    TURN_SENDER.scope(sender.clone(), future).await
}

/// The live turn's verified sender, if one was bound for this dispatch.
pub(super) fn current_turn_sender() -> Option<VerifiedCaller> {
    TURN_SENDER.try_with(Clone::clone).ok()
}

pub(super) fn current_principal() -> Option<ToolPrincipal> {
    VERIFIED_TOOL_SCOPE
        .try_with(|scope| scope.principal.clone())
        .ok()
}

/// The verified bearer this dispatch runs for, if any. `None` for a chat-agent
/// call (its principal is the host conversation's owner, which may not be the
/// person who sent the turn) and for test-only principal scopes.
pub(super) fn current_verified_caller() -> Option<VerifiedCaller> {
    VERIFIED_TOOL_SCOPE
        .try_with(|scope| scope.caller.clone())
        .ok()
        .flatten()
}

pub(crate) async fn with_verified_tool_caller<T>(
    caller: &VerifiedCaller,
    future: impl std::future::Future<Output = T>,
) -> T {
    let scope = VerifiedToolScope {
        principal: ToolPrincipal::Owned {
            user_id: caller.user_id.clone(),
            org_id: caller.org_id.clone(),
        },
        caller: Some(caller.clone()),
    };
    VERIFIED_TOOL_SCOPE.scope(scope, future).await
}

/// Who the vault treats as the owner of a dispatch no host conversation owns.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum SecretOwnerFallback {
    /// No verified caller is in scope: an owner-token or system call keeps the
    /// node-only (subject-less) context.
    NoCaller,
    /// The verified caller, whose `user:`/`role:`/`team:` policies then apply.
    Owner(String),
    /// A verified scope whose caller cannot be attributed to this node's org:
    /// resolution must fail closed rather than drop the caller's policies.
    FailClosed,
}

/// On an org-bound node, a conversationless MCP or app-tool dispatch from a
/// signed-in member must resolve secrets as that member. Without this the
/// vault sees no subjects and a member-bound deny never matches.
pub(super) fn secret_owner_without_conversation(node_org_id: Option<&str>) -> SecretOwnerFallback {
    secret_owner_for(current_principal(), node_org_id)
}

fn secret_owner_for(
    principal: Option<ToolPrincipal>,
    node_org_id: Option<&str>,
) -> SecretOwnerFallback {
    match principal {
        None => SecretOwnerFallback::NoCaller,
        Some(ToolPrincipal::Owned { user_id, org_id })
            if !user_id.is_empty()
                && org_id
                    .as_deref()
                    .is_none_or(|org| node_org_id.is_none_or(|node| node == org)) =>
        {
            SecretOwnerFallback::Owner(user_id)
        }
        Some(_) => SecretOwnerFallback::FailClosed,
    }
}

/// Run `future` with an arbitrary principal in scope. Tests only: it lets
/// registry tests reach the `ToolPrincipal::Unresolved` refusals, which otherwise
/// need an org-bound node that a unit test cannot register.
#[cfg(test)]
pub(super) async fn with_principal_for_tests<T>(
    principal: ToolPrincipal,
    future: impl std::future::Future<Output = T>,
) -> T {
    let scope = VerifiedToolScope {
        principal,
        caller: None,
    };
    VERIFIED_TOOL_SCOPE.scope(scope, future).await
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
    async fn the_verified_caller_travels_with_its_principal() {
        let mut alice = caller("alice");
        alice.teams.push(crate::identity_verify::TeamMembership {
            id: "design".to_owned(),
            org_id: "workspace".to_owned(),
            role: "member".to_owned(),
        });
        let seen = with_verified_tool_caller(&alice, async { current_verified_caller() }).await;
        let seen = seen.expect("verified caller in scope");
        assert_eq!(seen.user_id, "alice");
        assert_eq!(seen.teams.len(), 1);
        assert_eq!(seen.teams[0].id, "design");
        assert!(current_verified_caller().is_none());
    }

    #[tokio::test]
    async fn a_test_principal_scope_carries_no_verified_caller() {
        let owned = ToolPrincipal::Owned {
            user_id: "alice".to_owned(),
            org_id: Some("workspace".to_owned()),
        };
        let (principal, caller) = with_principal_for_tests(owned.clone(), async {
            (current_principal(), current_verified_caller())
        })
        .await;
        assert_eq!(principal, Some(owned));
        assert!(caller.is_none());
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

    #[tokio::test]
    async fn a_turn_sender_is_scoped_and_nests() {
        assert!(current_turn_sender().is_none());
        with_turn_sender(&caller("alice"), async {
            assert_eq!(
                current_turn_sender().map(|c| c.user_id),
                Some("alice".into())
            );
            with_turn_sender(&caller("bob"), async {
                assert_eq!(current_turn_sender().map(|c| c.user_id), Some("bob".into()));
            })
            .await;
            assert_eq!(
                current_turn_sender().map(|c| c.user_id),
                Some("alice".into())
            );
        })
        .await;
        assert!(current_turn_sender().is_none());
    }

    #[tokio::test]
    async fn background_tasks_do_not_inherit_the_turn_sender() {
        with_turn_sender(&caller("alice"), async {
            assert!(current_turn_sender().is_some());
            assert!(tokio::spawn(async { current_turn_sender().is_none() })
                .await
                .unwrap());
        })
        .await;
    }

    #[tokio::test]
    async fn a_turn_sender_changes_neither_principal_nor_secret_owner() {
        let (principal, verified, owner) = with_turn_sender(&caller("alice"), async {
            (
                current_principal(),
                current_verified_caller(),
                secret_owner_without_conversation(Some("workspace")),
            )
        })
        .await;
        assert!(principal.is_none());
        assert!(verified.is_none());
        assert_eq!(owner, SecretOwnerFallback::NoCaller);

        let bob = with_verified_tool_caller(&caller("bob"), async {
            with_turn_sender(&caller("alice"), async { current_principal() }).await
        })
        .await;
        assert!(matches!(bob, Some(ToolPrincipal::Owned { user_id, .. }) if user_id == "bob"));
    }

    #[tokio::test]
    async fn a_verified_member_owns_a_conversationless_secret_lookup() {
        assert_eq!(
            secret_owner_without_conversation(Some("workspace")),
            SecretOwnerFallback::NoCaller
        );
        let owner = with_verified_tool_caller(&caller("bob"), async {
            secret_owner_without_conversation(Some("workspace"))
        })
        .await;
        assert_eq!(owner, SecretOwnerFallback::Owner("bob".to_owned()));
    }

    #[test]
    fn an_unattributable_verified_scope_fails_closed() {
        let owned = |user: &str, org: Option<&str>| {
            Some(ToolPrincipal::Owned {
                user_id: user.to_owned(),
                org_id: org.map(str::to_owned),
            })
        };
        assert_eq!(
            secret_owner_for(owned("bob", Some("other-org")), Some("workspace")),
            SecretOwnerFallback::FailClosed
        );
        assert_eq!(
            secret_owner_for(owned("", Some("workspace")), Some("workspace")),
            SecretOwnerFallback::FailClosed
        );
        assert_eq!(
            secret_owner_for(Some(ToolPrincipal::Unresolved), Some("workspace")),
            SecretOwnerFallback::FailClosed
        );
        assert_eq!(
            secret_owner_for(owned("bob", None), Some("workspace")),
            SecretOwnerFallback::Owner("bob".to_owned())
        );
    }
}
