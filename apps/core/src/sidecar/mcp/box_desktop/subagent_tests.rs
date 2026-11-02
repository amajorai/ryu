//! Tests for the sub-agent scope in [`super`].

use super::*;

/// The scoped future is boxed, so a caller awaiting `with_subagent_scope`
/// holds one pointer in its own state instead of the wrapped dispatch. The
/// registry's dispatch core inlined the whole `threads.*` dispatch here, which
/// overflowed a 2 MiB worker in debug builds once the core re-entered itself.
#[test]
fn the_scoped_future_is_boxed_not_held_inline() {
    let large = async {
        let buffer = [7_u8; 64 * 1024];
        tokio::task::yield_now().await;
        buffer[0]
    };
    let scoped = with_subagent_scope(None, large);
    assert_eq!(std::mem::size_of_val(&scoped), std::mem::size_of::<usize>());
}

#[tokio::test]
async fn the_scope_is_visible_inside_and_absent_outside() {
    let scope = SubagentScope {
        owner: "user:owner-a".to_owned(),
        parent_conversation_id: "conversation-a".to_owned(),
    };
    let seen = with_subagent_scope(Some(scope.clone()), async { current_subagent_scope() }).await;
    assert_eq!(seen, Some(scope));
    let unscoped = with_subagent_scope(None, async { current_subagent_scope() }).await;
    assert_eq!(unscoped, None);
    assert_eq!(current_subagent_scope(), None);
}
