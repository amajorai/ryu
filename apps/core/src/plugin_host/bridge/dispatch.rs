//! Constructors and the `host.*` dispatch table of [`PluginHookBridge`].
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

impl PluginHookBridge {
    #[cfg(test)]
    pub(in crate::plugin_host) fn with_test_storage(
        mut self,
        store: crate::plugin_storage::PluginStorage,
    ) -> Self {
        self.test_storage = Some(store);
        self
    }

    pub fn new(plugin_id: String, grants: HashSet<String>, state: ServerState) -> Self {
        Self::new_for_request(plugin_id, grants, state, None, None)
    }

    pub fn new_for_request(
        plugin_id: String,
        grants: HashSet<String>,
        state: ServerState,
        verified_caller: Option<crate::identity_verify::VerifiedCaller>,
        authorized_conversation_id: Option<String>,
    ) -> Self {
        Self {
            plugin_id,
            grants,
            state,
            verified_caller,
            authorized_conversation_id,
            calling_agent_id: None,
            storage_tenant: None,
            #[cfg(test)]
            test_storage: None,
            middleware_next: None,
            middleware_next_used: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Construct a bridge for an inline tool invoked by an identified agent. The
    /// conversation id and agent id were already resolved by the registry call
    /// path; binding them here gives the tool a narrow current-conversation write
    /// without turning model-controlled arguments into an authorization principal.
    pub fn new_for_agent_tool(
        plugin_id: String,
        grants: HashSet<String>,
        state: ServerState,
        agent_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> Self {
        let mut bridge = Self::new_for_request(
            plugin_id,
            grants,
            state,
            None,
            conversation_id.map(str::to_owned),
        );
        bridge.calling_agent_id = agent_id.map(str::to_owned);
        bridge
    }

    /// Construct a bridge for an authenticated tool dispatch that has a
    /// verified user id but no full JWT caller object. The tenant is used only
    /// to partition plugin KV; it never grants resource access.
    pub fn new_with_tenant(
        plugin_id: String,
        grants: HashSet<String>,
        state: ServerState,
        tenant: Option<String>,
    ) -> Self {
        let mut bridge = Self::new(plugin_id, grants, state);
        bridge.storage_tenant = tenant;
        bridge
    }

    /// Attach the Core-owned continuation for a middleware hook invocation.
    /// This is intentionally not part of the public host-API table: it exists
    /// only inside the sandbox runtime and inherits the current hook's lease.
    pub(crate) fn with_middleware_next(mut self, next: crate::plugin_host::MiddlewareNext) -> Self {
        self.middleware_next = Some(next);
        self
    }

    /// Bind an inline hook/tool bridge to the agent that produced the current
    /// turn. A hook may ask Core to run a specialist, but it must not turn that
    /// argument into a cross-agent privilege selector.
    pub(crate) fn with_calling_agent(mut self, agent_id: Option<String>) -> Self {
        self.calling_agent_id = agent_id;
        self
    }

    pub(super) async fn require_bound_conversation(
        &self,
        requested: &str,
        write: bool,
    ) -> Result<(), String> {
        let requested = requested.trim();
        let Some(bound) = self.authorized_conversation_id.as_deref() else {
            return Err("host operation requires the current authorized conversation".to_owned());
        };
        if bound != requested {
            return Err("host operation cannot target a different conversation".to_owned());
        }
        let meta = self.state.conversations.get_access_meta(requested).await;
        let result = if write {
            crate::server::require_resource_write(
                meta,
                self.verified_caller.as_ref(),
                &format!("conversation '{requested}' not found"),
            )
        } else {
            crate::server::require_resource_read(
                meta,
                self.verified_caller.as_ref(),
                &format!("conversation '{requested}' not found"),
            )
        };
        result.map_err(|response| {
            format!(
                "host operation conversation is not authorized (HTTP {})",
                response.status()
            )
        })
    }

    pub(super) fn usage_admin_allowed(&self) -> bool {
        node_owner_or_admin(self.verified_caller.as_ref())
    }

    pub(super) async fn handle_inner(&self, path: String, args: Value) -> InvokeOutcome {
        // The sandbox proxy delivers `host.<method>` as the path.
        let method = path.strip_prefix("host.").unwrap_or(&path);
        match method {
            "authorization_issue" | "authorization_check" => {
                if !self.grants.contains("authorization:defer") {
                    return err("authorization:defer is not granted".to_owned());
                }
                match crate::sidecar::deferred_authorization::invoke(
                    &self.state,
                    &self.plugin_id,
                    method,
                    args,
                )
                .await
                {
                    Ok(value) => ok(value),
                    Err(error) => err(error.to_owned()),
                }
            }
            "execution_pause" | "execution_resume" | "execution_status" => {
                if !self.grants.contains("execution:control") {
                    return err("execution:control is not granted".to_owned());
                }
                if !self.usage_admin_allowed() {
                    return err("execution control is not granted to this caller".to_owned());
                }
                let _control = crate::execution_control::control_lock().await;
                let mut cancelled = 0;
                if method == "execution_pause" {
                    crate::execution_control::pause();
                    cancelled += crate::sidecar::adapters::acp::request_cancel_all();
                    cancelled += crate::a2a::request_cancel_all();
                } else if method == "execution_resume" {
                    crate::execution_control::resume();
                }
                let interrupted_conversations = if method == "execution_pause" {
                    match self
                        .state
                        .conversations
                        .interrupt_running_conversations()
                        .await
                    {
                        Ok(interrupted) => interrupted,
                        Err(error) => {
                            tracing::error!(%error, "execution paused but run statuses could not be updated");
                            return err("execution paused, but run statuses could not be updated"
                                .to_owned());
                        }
                    }
                } else {
                    0
                };
                tracing::info!(plugin = %self.plugin_id, method, cancelled, "execution control");
                ok(
                    json!({ "paused": crate::execution_control::is_paused(), "cancelledTurns": cancelled, "interruptedConversations": interrupted_conversations }),
                )
            }
            "security_check" => {
                if !self.grants.contains("security:check") {
                    return err("security:check is not granted".to_owned());
                }
                let text = match args.get("text").and_then(Value::as_str) {
                    Some(text) if text.len() <= 2_000_000 => text,
                    _ => return err("security.check requires text up to 2 MB".to_owned()),
                };
                let Some(client) = security_check_client() else {
                    return err("Security scanner unavailable".to_owned());
                };
                let endpoint = format!(
                    "{}/v1/firewall/check",
                    crate::sidecar::gateway::gateway_url().trim_end_matches('/')
                );
                let mut request = client
                    .post(endpoint)
                    .timeout(std::time::Duration::from_secs(15))
                    .json(&json!({ "text": text, "checks": ["secret"] }));
                if let Some(token) = crate::sidecar::gateway::gateway_token() {
                    request = request.bearer_auth(token);
                }
                let response = match request.send().await {
                    Ok(response) if response.status().is_success() => response,
                    _ => return err("Security scanner unavailable; operation refused".to_owned()),
                };
                match response.json::<Value>().await {
                    Ok(value) if value.get("allowed").is_some_and(Value::is_boolean) => ok(
                        json!({"allowed": value["allowed"], "reason": value.get("reason").cloned().unwrap_or(Value::Null)}),
                    ),
                    _ => err("Invalid security scanner response".to_owned()),
                }
            }
            "identity_current" => {
                if !self.grants.contains("identity:read") {
                    return err("identity:read is not granted".to_owned());
                }
                // Apps match email-addressed grants against this address, so it
                // carries only an email the identity token marks verified.
                let principal = self.verified_caller.as_ref().map(|caller| {
                    json!({
                        "id": caller.user_id,
                        "email": caller.verified_email().unwrap_or_default(),
                        "workspaceIds": caller.org_id.iter().collect::<Vec<_>>(),
                    })
                });
                ok(
                    json!({ "principal": principal, "requiresIdentity": crate::sidecar::control_plane::registered_org().is_some() }),
                )
            }
            "catalogSnapshot" => self.catalog_snapshot(args).await,
            "catalogModels" => self.catalog_models(args).await,
            "sideModel" => self.side_model(args).await,
            "runAgent" => self.run_agent(args).await,
            "runFanout" => self.run_fanout(args).await,
            "workflowScript" => self.workflow_script(args).await,
            "workflowRunStatus" => self.workflow_run_status(args).await,
            "storage_get"
            | "storage_set"
            | "storage_delete"
            | "storage_keys"
            | "storage_compare_and_set" => self.storage(method, args).await,
            "crypto_seal" | "crypto_open" | "crypto_status" => self.crypto(method, args).await,
            "backups_destinations"
            | "backups_create"
            | "backups_list"
            | "backups_get"
            | "backups_restore" => self.backups(method, args).await,
            "spaces_search"
            | "spaces_ensure_space"
            | "spaces_create_doc"
            | "spaces_get_doc"
            | "spaces_update_doc"
            | "spaces_list_docs"
            | "spaces_delete_doc"
            | "spaces_create_database"
            | "spaces_list_databases"
            | "spaces_get_database"
            | "spaces_update_database"
            | "spaces_query_database"
            | "spaces_delete_database" => self.spaces(method, args).await,
            "setConversationTitle" => self.set_conversation_title(args).await,
            "addMessageReaction" => self.add_message_reaction(args).await,
            "getPreference" => self.get_preference(args).await,
            "background_list" => self.background_list(args).await,
            "background_stop" => self.background_stop(args).await,
            "usageSnapshot" => self.usage_snapshot(args).await,
            "subscriptions_list" | "subscriptions_usage" => self.subscriptions(method, args).await,
            "gatewayBudgetSpend" => self.gateway_budget_spend(args).await,
            "gatewayAudit" => self.gateway_audit(args).await,
            "recordFeedback" => self.record_feedback(args).await,
            "synthesizeSkill" => self.synthesize_skill(args).await,
            "runHook" => self.run_own_hook(args).await,
            "next" => self.next(args).await,
            "notify" => self.notify(args).await,
            "t" => hook_text_bridge::translate(args).await,
            "notifications_send" => self.notifications_send(args).await,
            "navigate" => self.navigate(args),
            other => err(format!("unknown host capability '{other}'")),
        }
    }

    /// Continue a middleware hook chain with a serialized `HookContext`.
    /// `next` is one-shot per hook invocation, which prevents accidental
    /// duplicate downstream side effects while retaining normal onion semantics.
    pub(super) async fn next(&self, args: Value) -> InvokeOutcome {
        let Some(next) = self.middleware_next.as_ref() else {
            return err("host.next is only available to middleware hooks".to_owned());
        };
        if self.middleware_next_used.swap(true, Ordering::AcqRel) {
            return err("middleware hook next() may only be called once".to_owned());
        }
        let Some(context) = args.get("context").cloned() else {
            return err("host.next requires a context object".to_owned());
        };
        let context = match serde_json::from_value::<crate::plugin_host::HookContext>(context) {
            Ok(context) => context,
            Err(error) => return err(format!("host.next received an invalid context: {error}")),
        };
        let directive = next(context).await;
        match serde_json::to_value(directive) {
            Ok(value) => ok(value),
            Err(error) => err(format!("host.next could not serialize its result: {error}")),
        }
    }
}

impl SandboxBridge for PluginHookBridge {
    fn handle(
        &self,
        path: String,
        args: Value,
    ) -> Pin<Box<dyn Future<Output = InvokeOutcome> + Send + '_>> {
        Box::pin(self.handle_inner(path, args))
    }
}
