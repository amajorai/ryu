//! The hand-off an app-tool alias (`app.<plugin>.<tool>`) makes to the dispatch wrapper.
//!
//! The dispatch core (`call_tool_with_identity_no_gate_scoped_inner`) has a very
//! large debug-build poll frame (about 840 KiB). When an alias re-entered dispatch
//! for its target from inside that core, two such frames stacked and overflowed an
//! ordinary 2 MiB worker or test thread. The alias arm now hands its target to an
//! [`AppAliasSlot`] and returns; `call_tool_with_identity_no_gate_scoped` dispatches
//! the target once the core's frame has unwound, so only one frame is live at a time.

use serde_json::Value;
use std::sync::{Arc, Mutex, PoisonError};

/// Shared between the dispatch wrapper and the core it boxes. The core's future
/// is built in the wrapper's synchronous frame, so it cannot borrow a local of the
/// async block that later reads the slot.
#[derive(Clone, Default)]
pub(super) struct AppAliasSlot(Arc<Mutex<Option<AppAliasReentry>>>);

impl AppAliasSlot {
    pub(super) fn hand_off(&self, reentry: AppAliasReentry) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(reentry);
    }

    pub(super) fn take(&self) -> Option<AppAliasReentry> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

/// What the target dispatch needs that the wrapper does not already hold.
pub(super) struct AppAliasReentry {
    /// The manifest-fixed target tool id.
    pub(super) tool: String,
    pub(super) arguments: Value,
    /// The caller's profiles after the calling agent's account policy narrowed
    /// them. The wrapper's own `profile_ids` are not narrowed, so they must not
    /// be reused for the target.
    pub(super) profile_ids: Vec<String>,
    pub(super) session_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use crate::sidecar::mcp::McpRegistry;
    use std::sync::Arc;

    const ALIAS: &str = "app.agent_builder.configure_agent";
    const TARGET: &str = "agent_builder.configure_agent";

    /// An alias call and its target dispatch must fit the 2 MiB stack Tokio gives
    /// worker threads, in a debug build. The thread's stack size is set explicitly
    /// so `RUST_MIN_STACK` cannot hide a regression.
    #[test]
    fn alias_dispatch_fits_an_ordinary_worker_stack() {
        std::thread::Builder::new()
            .name("app-alias-stack-proof".into())
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(alias_dispatch_reaches_the_target())
            })
            .unwrap()
            .join()
            .expect("an app-tool alias must dispatch on an ordinary worker stack");
    }

    async fn alias_dispatch_reaches_the_target() {
        let agents = crate::agents::AgentStore::open_in_memory(
            &crate::sidecar::adapters::AcpAgentRegistry::new(),
        )
        .unwrap();
        let target = agents
            .create(crate::agents::CreateAgent {
                name: "Original".to_owned(),
                ..Default::default()
            })
            .await
            .unwrap();
        let registry = McpRegistry::empty().with_agent_store(agents.clone());
        registry.register_app_tool(ALIAS.to_owned(), TARGET.to_owned(), None);
        let registry = Arc::new(registry);
        let arguments = serde_json::json!({"agent_id": target.id, "name": "Changed"});

        // Both refusals come from the target's own checks, so reaching them proves
        // the alias handed off and the target dispatched with the caller's identity.
        for (caller, granted, expected) in [
            (
                None,
                true,
                format!("tool '{TARGET}' requires a verified calling agent"),
            ),
            (
                Some("ryu"),
                false,
                format!("{TARGET} requires interactive permission"),
            ),
        ] {
            let error = registry
                .call_tool_with_identity_no_gate_scoped(
                    caller,
                    ALIAS,
                    arguments.clone(),
                    None,
                    None,
                    &[],
                    None,
                    None,
                    None,
                    None,
                    granted,
                )
                .await
                .expect_err("the target must apply its own authorization");
            assert_eq!(error.to_string(), expected);
        }
        assert_eq!(
            agents.get(&target.id).await.unwrap().unwrap().name,
            "Original"
        );
    }
}
