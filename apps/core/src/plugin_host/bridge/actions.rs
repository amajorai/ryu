//! Learning feedback, skill synthesis, running the app's own hook, navigation.
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

impl PluginHookBridge {
    /// `host.recordFeedback({ conversation_id, message_id, rating })` — record a
    /// thumbs vote on an assistant turn. `rating` is `"up"` / `"down"` or `null`
    /// (clear). Persists the durable message state, then wraps Core's shared
    /// `crate::learning::apply_message_feedback` fan-out (learning reward +
    /// RAG-memory sinks), the same sink used by the HTTP feedback route.
    pub(super) async fn record_feedback(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_LEARNING_FEEDBACK) {
            return err(format!(
                "capability '{GRANT_LEARNING_FEEDBACK}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let conversation_id = args
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if conversation_id.is_empty() {
            return err("host.recordFeedback requires a non-empty 'conversation_id'".to_string());
        }
        if let Err(error) = self
            .require_bound_conversation(conversation_id, false)
            .await
        {
            return err(error);
        }
        let message_id = args
            .get("message_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if message_id.is_empty() {
            return err("host.recordFeedback requires a non-empty 'message_id'".to_string());
        }
        let rating = match args.get("rating") {
            Some(Value::Null) | None => None,
            Some(v) => v.as_str(),
        };
        match rating {
            Some("up") | Some("down") | None => {}
            Some(other) => {
                return err(format!(
                    "host.recordFeedback rating must be 'up', 'down' or null, got '{other}'"
                ));
            }
        }
        let updated = match self
            .state
            .conversations
            .set_message_feedback(conversation_id, message_id, rating)
            .await
        {
            Ok(updated) => updated,
            Err(error) => {
                return err(format!(
                    "host.recordFeedback could not persist vote: {error}"
                ));
            }
        };
        if !updated {
            return err(format!(
                "host.recordFeedback message '{message_id}' was not found in conversation '{conversation_id}'"
            ));
        }
        let outcome = crate::learning::apply_message_feedback(
            &self.state,
            conversation_id,
            message_id,
            rating,
            None,
        )
        .await;
        ok(json!(outcome))
    }

    /// `host.synthesizeSkill({ conversation_id, force? })` — distill a skill from a
    /// conversation and propose it in the approval inbox. The "make a skill from
    /// this chat" context-menu row dispatches through this verb; it wraps
    /// `ryu_learning::synthesize_skill`, the same logic as the `/api/learn/synthesize`
    /// route. No caller identity travels on the host bridge (the shell holds the
    /// node token), so `requested_by` is `None`; the force/consent semantics are
    /// identical to the HTTP route.
    pub(super) async fn synthesize_skill(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_LEARNING_SYNTHESIZE) {
            return err(format!(
                "capability '{GRANT_LEARNING_SYNTHESIZE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let cid = args
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if cid.is_empty() {
            return err("host.synthesizeSkill requires a non-empty 'conversation_id'".to_string());
        }
        if let Err(error) = self.require_bound_conversation(cid, false).await {
            return err(error);
        }
        let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
        match ryu_learning::synthesize_skill(
            &crate::learning::learning_ctx(&self.state),
            cid,
            force,
            None,
        )
        .await
        {
            Ok(outcome) => ok(json!(outcome)),
            Err(e) => err(e.to_string()),
        }
    }

    /// `host.runHook({ hook_id, conversation_id, event? })` — run ONE of the
    /// calling plugin's own declared turn hooks, now, outside the turn loop.
    ///
    /// This is what lets an app whose entire behaviour is a hook be triggered by
    /// the user. A contributed context-menu row can only dispatch a HOST
    /// capability, so before this a plugin like `@ryu/chat-title` — which renames
    /// chats from a `post_assistant_turn` hook — had no way to offer "rename this
    /// one now": the shell would have had to hardcode the feature, which is the
    /// arrangement the contribution system exists to remove.
    ///
    /// Three properties make it safe to expose:
    ///
    /// * **Own hooks only.** `self.plugin_id` comes from the bridge (the HTTP relay
    ///   takes it from the PATH, never the body), and the lookup filters on it, so
    ///   a plugin cannot run another plugin's hook or borrow its grants.
    /// * **No privilege gain.** The hook runs with the grants it already has —
    ///   `run_hook` builds its bridge from `hook.grants`. The capability adds a
    ///   TRIGGER, not an authority.
    /// * **No recursion.** A hook that calls `host.runHook` on itself would spawn
    ///   sandboxes without bound, so a re-entrancy set refuses a manual run of a
    ///   hook already running manually.
    ///
    /// `event` is merged into `ctx.event` as `{ source: "manual", ... }`, which is
    /// how a hook tells a user-forced run from its scheduled one (e.g. skipping its
    /// own "only every N turns" gate).
    pub(super) async fn run_own_hook(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_RUN_SELF_HOOK) {
            return err(format!(
                "capability '{GRANT_RUN_SELF_HOOK}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let hook_id = args
            .get("hook_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if hook_id.is_empty() {
            return err("host.runHook requires a non-empty 'hook_id'".to_string());
        }
        let conversation_id = args
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if conversation_id.is_empty() {
            return err("host.runHook requires a non-empty 'conversation_id'".to_string());
        }
        let Some(caller) = self.verified_caller.as_ref() else {
            return err(
                "host.runHook requires a verified user caller; node-token-only requests are denied"
                    .to_string(),
            );
        };
        if self.authorized_conversation_id.as_deref() != Some(conversation_id.as_str()) {
            return err(
                "host.runHook conversation_id is not the conversation authorized for this request"
                    .to_string(),
            );
        }
        if let Err(response) = crate::server::require_conversation_read_by_id(
            &self.state,
            &Some(caller.clone()),
            &conversation_id,
        )
        .await
        {
            return err(format!(
                "host.runHook conversation is not authorized (HTTP {})",
                response.status()
            ));
        }

        let hooks = crate::plugin_host::collect_enabled_hooks(&self.state).await;
        let Some(hook) = hooks
            .into_iter()
            .find(|h| h.plugin_id == self.plugin_id && h.hook_id == hook_id)
        else {
            // Also the disabled case: `collect_enabled_hooks` only returns hooks of
            // enabled plugins, so "not found" and "not enabled" are one message.
            return err(format!(
                "plugin '{}' declares no enabled hook '{hook_id}'",
                self.plugin_id
            ));
        };

        let key = format!("{}:{}:{}", self.plugin_id, caller.user_id, conversation_id);
        let Some(manual_run) = ManualRunGuard::claim(&key) else {
            return err(format!("hook '{hook_id}' is already running"));
        };

        // Build the same shape the turn loop passes, from the persisted transcript.
        const MAX_TRANSCRIPT: usize = 20;
        let transcript = match self
            .state
            .conversations
            .get_active_messages(&conversation_id)
            .await
        {
            Ok(msgs) => {
                let skip = msgs.len().saturating_sub(MAX_TRANSCRIPT);
                msgs.into_iter()
                    .skip(skip)
                    .map(|m| crate::plugin_host::HookMessage {
                        role: m.role,
                        content: m.content,
                    })
                    .collect()
            }
            Err(e) => {
                return err(format!("host.runHook could not load the transcript: {e}"));
            }
        };
        let mut event = match args.get("event") {
            Some(Value::Object(map)) => map.clone(),
            _ => serde_json::Map::new(),
        };
        event.insert("source".to_string(), json!("manual"));
        // Carry the verified caller into the hook, as the turn path does: the
        // inner bridge needs it for conversation/resource ACLs on registered
        // nodes and for the caller's storage tenant.
        let ctx = crate::plugin_host::HookContext {
            conversation_id: Some(conversation_id),
            caller_user_id: Some(caller.user_id.clone()),
            verified_caller: Some(caller.clone()),
            transcript,
            event: Some(Value::Object(event)),
            ..Default::default()
        };
        let directive = crate::plugin_host::run_hook(&self.state, &hook, &ctx).await;
        drop(manual_run);
        // A hook that returns `None` decided to do nothing — its gate did not
        // match, its model returned nothing, its write failed. Reporting that as
        // success is how a menu row ends up toasting "Renamed" over a chat whose
        // title never changed, so the no-op is an error here and the caller's
        // `error` copy is what the user sees. A hook that wants to report success
        // returns a `Note`, whose text becomes the result.
        match directive {
            crate::plugin_host::HookDirective::None => err(format!(
                "hook '{hook_id}' made no change (it declined to act, or its work failed)"
            )),
            other => ok(json!({
                "ran": true,
                "message": match &other {
                    crate::plugin_host::HookDirective::Note { text }
                    | crate::plugin_host::HookDirective::Continue { text } => text.clone(),
                    _ => String::new(),
                },
            })),
        }
    }

    /// `host.runAgent({ task, agent_id?, preset?, wall_time_secs?, max_tokens? })`
    /// — spawn ONE full sub-agent with a clean context (it sees only `task`, never
    /// the parent transcript) and return its final text. Unlike `sideModel` (a
    /// single toolless completion), this routes through the delegation engine
    /// ([`crate::workflow::delegation::run_fanout`]): when `agent_id` names a
    /// configured agent and the agent runner is live, the sub-agent runs the real
    /// chat path — its own engine, tools, MCP, and Gateway routing — so it can
    /// gather actual evidence (read files, run tests, hit endpoints) rather than
    /// guess from the conversation. This is the "proof of work" primitive: an
    /// independent agent that must *prove* a goal was done, not merely judge it.
    /// `host.navigate({ target, params? })` — ask the host shell to navigate or
    /// deep-link on the app's behalf. A sandboxed app UI can't drive the shell
    /// router directly; this grant-gated primitive publishes a [`NavigationRequest`]
    /// that the connected surface consumes over SSE and acts on. Fire-and-forget:
    /// success means "queued", not "the shell navigated" (no surface may be live).
    pub(super) fn navigate(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_NAVIGATE) {
            return err(format!(
                "capability '{GRANT_NAVIGATE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let target = args
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if target.is_empty() {
            return err("host.navigate requires a non-empty 'target'".to_string());
        }
        crate::events::publish_navigation(crate::events::NavigationRequest {
            plugin_id: self.plugin_id.clone(),
            target: target.to_string(),
            params: args.get("params").cloned(),
            kind: crate::events::NavigationKind::Tab,
            force_new: false,
            // A personal node has one trusted operator, so preserve the original
            // broadcast behavior. Shared nodes must address the verified caller;
            // otherwise one app click would navigate every connected teammate.
            target_user_id: crate::server::node_org_id()
                .is_some()
                .then(|| {
                    self.verified_caller
                        .as_ref()
                        .map(|caller| caller.user_id.clone())
                })
                .flatten(),
        });
        ok(serde_json::json!({ "queued": true, "target": target }))
    }
}
