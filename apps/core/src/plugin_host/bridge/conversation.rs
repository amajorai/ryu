//! Background process control, conversation title and reactions, preferences.
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

impl PluginHookBridge {
    /// `host.background.list({ running_only?, producer? })` — return the shared
    /// Core registry projection. The process owner remains responsible for
    /// honoring stop requests; this read is safe for both hooks and apps.
    pub(super) async fn background_list(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_BACKGROUND_CONTROL) {
            return err(format!(
                "capability '{GRANT_BACKGROUND_CONTROL}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let running_only = args
            .get("running_only")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let producer = args
            .get("producer")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let owner =
            match crate::background_processes::owner_for_caller(self.verified_caller.as_ref()) {
                Ok(owner) => owner,
                Err(error) => return err(error),
            };
        match serde_json::to_value(crate::background_processes::list(
            &owner,
            running_only,
            producer,
        )) {
            Ok(value) => ok(value),
            Err(error) => err(format!("could not list background processes: {error}")),
        }
    }

    /// `host.background.stop({ process_id })` — enqueue a cooperative stop for
    /// the process owner. Core never sends a signal to an arbitrary PID.
    pub(super) async fn background_stop(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_BACKGROUND_CONTROL) {
            return err(format!(
                "capability '{GRANT_BACKGROUND_CONTROL}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let process_id = args
            .get("process_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if process_id.is_empty() {
            return err("host.background.stop requires a non-empty 'process_id'".to_string());
        }
        let owner =
            match crate::background_processes::owner_for_caller(self.verified_caller.as_ref()) {
                Ok(owner) => owner,
                Err(error) => return err(error),
            };
        match crate::background_processes::request_stop(&owner, process_id) {
            Ok(()) => ok(json!({
                "ok": true,
                "requested": true,
                "process_id": process_id,
            })),
            Err(error) => err(error),
        }
    }

    /// `host.setConversationTitle({ id, title, mode? })` — rename a conversation.
    /// `mode` defaults to `"auto"` (skips when `title_custom`); `"custom"` locks
    /// the title like a manual rename. Titles are sanitized with the same rules
    /// as Core's built-in titler.
    pub(super) async fn set_conversation_title(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_SET_TITLE) {
            return err(format!(
                "capability '{GRANT_SET_TITLE}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if id.is_empty() {
            return err("host.setConversationTitle requires a non-empty 'id'".to_string());
        }
        if let Err(error) = self.require_bound_conversation(id, true).await {
            return err(error);
        }
        let raw = args
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let title = crate::server::auto_title::sanitize_title(raw);
        if title.is_empty() {
            return err("host.setConversationTitle requires a usable 'title'".to_string());
        }
        let mode = args
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .trim();
        match mode {
            "custom" => match self.state.conversations.set_title(id, &title).await {
                Ok(()) => ok(json!({ "ok": true, "title": title, "applied": true })),
                Err(e) => err(e.to_string()),
            },
            "auto" => match self.state.conversations.auto_set_title(id, &title).await {
                Ok(applied) => ok(json!({ "ok": true, "title": title, "applied": applied })),
                Err(e) => err(e.to_string()),
            },
            other => err(format!(
                "host.setConversationTitle mode must be 'auto' or 'custom', got '{other}'"
            )),
        }
    }

    /// `host.addMessageReaction({ message_id?, emoji })` — add an agent-authored
    /// reaction to one exact persisted message in the current conversation, or
    /// to its latest user message when `message_id` is omitted.
    ///
    /// The current conversation and actor are bound when the inline tool bridge is
    /// created. This is intentionally not a general conversation-id argument: an
    /// agent can react to a peer's message in the shared transcript, but cannot
    /// turn the tool into a cross-chat write or choose another agent's identity.
    pub(super) async fn add_message_reaction(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_CONVERSATION_REACTIONS) {
            return err(format!(
                "capability '{GRANT_CONVERSATION_REACTIONS}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let Some(conversation_id) = self
            .authorized_conversation_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            return err(
                "host.addMessageReaction requires the calling agent's current conversation"
                    .to_owned(),
            );
        };
        let Some(agent_id) = self
            .calling_agent_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 128)
        else {
            return err("host.addMessageReaction requires a verified calling agent".to_owned());
        };
        if agent_id.chars().any(char::is_control) {
            return err("host.addMessageReaction received an invalid calling agent".to_owned());
        }
        if let Err(error) = self
            .require_bound_conversation(conversation_id, false)
            .await
        {
            return err(error);
        }

        // Keep the agent plane aligned with the existing conversation ACL. On an
        // org-bound node, an unresolved/unterminated host conversation is never a
        // reason to fall back to the node-wide token.
        if crate::sidecar::control_plane::registered_org().is_some()
            && crate::sidecar::mcp::ToolPrincipal::resolve(
                &self.state.conversations,
                Some(conversation_id),
            )
            .await
            .is_unresolved()
        {
            return err(
                "host.addMessageReaction: the current conversation is not authorized".to_owned(),
            );
        }

        // An omitted id means "what the user just said": the agent is never shown
        // persisted message ids, so the acknowledgement case resolves server-side
        // to the latest user message of the bound conversation.
        let named_message_id = args
            .get("message_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let message_id = match named_message_id {
            Some(message_id) => message_id,
            None => match self
                .state
                .conversations
                .latest_user_message_id(conversation_id)
                .await
            {
                Ok(Some(message_id)) => message_id,
                Ok(None) => {
                    return err(
                        "host.addMessageReaction found no user message to react to in the current conversation"
                            .to_owned(),
                    );
                }
                Err(error) => {
                    return err(format!(
                        "host.addMessageReaction could not resolve the latest user message: {error}"
                    ));
                }
            },
        };
        let message_id = message_id.as_str();
        if message_id.len() > 200 {
            return err("host.addMessageReaction 'message_id' exceeds 200 bytes".to_owned());
        }

        let emoji = args
            .get("emoji")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(emoji) = emoji else {
            return err("host.addMessageReaction requires a non-empty 'emoji'".to_owned());
        };
        if emoji.len() > 64 {
            return err("host.addMessageReaction 'emoji' exceeds 64 bytes".to_owned());
        }

        match self
            .state
            .app_store
            .get(crate::plugins::builtins::REACTIONS_PLUGIN_ID)
            .await
        {
            Ok(Some(record)) if record.enabled => {}
            Ok(_) => {
                return err(
                    "host.addMessageReaction requires the Message Reactions plugin to be enabled"
                        .to_owned(),
                );
            }
            Err(error) => {
                return err(format!(
                    "host.addMessageReaction could not verify the Message Reactions plugin: {error}"
                ));
            }
        }

        let actor = format!("agent:{agent_id}");
        match self
            .state
            .conversations
            .add_reaction(conversation_id, message_id, &actor, emoji)
            .await
        {
            Ok(true) => ok(json!({
                "ok": true,
                "conversation_id": conversation_id,
                "message_id": message_id,
                "emoji": emoji,
                "from": agent_id,
            })),
            Ok(false) => err(format!(
                "host.addMessageReaction message '{message_id}' was not found in the current conversation"
            )),
            Err(error) => err(format!(
                "host.addMessageReaction could not persist reaction: {error}"
            )),
        }
    }

    /// `host.getPreference({ key })` — read one preference as a string (or null).
    pub(super) async fn get_preference(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_PREFERENCES_READ) {
            return err(format!(
                "capability '{GRANT_PREFERENCES_READ}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let key = args
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if key.is_empty() {
            return err("host.getPreference requires a non-empty 'key'".to_string());
        }
        if crate::server::preferences::is_secret_preference_key(key) {
            return err(
                "host.getPreference cannot return credential-bearing preferences; use the \
                 governed secret-header or vault capability instead"
                    .to_owned(),
            );
        }
        match self.state.preferences.get(key).await {
            Ok(Some(v)) => ok(json!(v)),
            Ok(None) => ok(Value::Null),
            Err(e) => err(e.to_string()),
        }
    }
}
