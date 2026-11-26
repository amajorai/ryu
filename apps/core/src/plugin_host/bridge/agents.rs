//! `host.runAgent`, `host.runFanout` and `host.sideModel`.
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

impl PluginHookBridge {
    pub(super) async fn require_user_agent_run_permission(&self) -> Result<(), String> {
        // A verified user must hold the collection permission in addition to
        // the app's hook grant. Sidecar-only calls without a user are checked
        // against node scope by enforce_permission; only a bridge invoked from
        // an identified agent tool inherits its enclosing turn's authorization.
        if !requires_user_agent_run_permission(
            self.verified_caller.is_some(),
            self.calling_agent_id.is_some(),
        ) {
            return Ok(());
        }
        crate::server::enforce_permission(
            &self.state,
            &self.verified_caller,
            crate::identity_verify::permissions::AGENT_RUN,
        )
        .await
        .map_err(|_| "permission 'agent.run' is not granted to this caller".to_owned())
    }

    /// The `x-ryu-agent-provider-access` value of the agent whose turn invoked
    /// this bridge, or `None` when there is no calling agent or its model
    /// providers are unrestricted. A store error fails closed to `none`.
    pub(in crate::plugin_host) async fn calling_agent_provider_access(&self) -> Option<String> {
        let agent_id = self.calling_agent_id.as_deref()?;
        crate::agent_access::provider_access_for_agent(&self.state.agent_store, agent_id)
            .await
            .map(|ids| crate::agent_access::provider_access_header_value(&ids))
    }

    /// Sub-agents and fan-out delegates are Gateway completions on the node's
    /// model providers with no provider-access header, so an agent whose model
    /// providers are limited would get them all back through an app's tool.
    pub(in crate::plugin_host) async fn refuse_limited_provider_access(
        &self,
        verb: &str,
    ) -> Result<(), String> {
        if self.calling_agent_provider_access().await.is_some() {
            return Err(format!(
                "{verb} runs sub-tasks on all of your model providers, which this agent's account access does not allow"
            ));
        }
        Ok(())
    }

    pub(super) async fn run_agent(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_RUN_AGENT) {
            return err(format!(
                "capability '{GRANT_RUN_AGENT}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if let Err(error) = self.require_user_agent_run_permission().await {
            return err(error);
        }
        if let Err(error) = self.refuse_limited_provider_access("host.runAgent").await {
            return err(error);
        }
        let task = args
            .get("task")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if task.is_empty() {
            return err("host.runAgent requires a non-empty 'task'".to_string());
        }
        if task.chars().count() > 64 * 1024 {
            return err("host.runAgent task exceeds the 64 KiB limit".to_owned());
        }
        let agent_id = args
            .get("agent_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if let Some(agent_id) = agent_id.as_deref() {
            if agent_id.len() > 128 || agent_id.chars().any(char::is_control) {
                return err("host.runAgent received an invalid agent_id".to_owned());
            }
            if let Some(calling_agent) = self.calling_agent_id.as_deref() {
                if calling_agent != agent_id {
                    return err(
                        "host.runAgent cannot target an agent different from the current turn"
                            .to_owned(),
                    );
                }
            }
            if !crate::fleet::is_agent_available(agent_id) {
                return err(
                    "host.runAgent agent is unavailable under organization policy".to_owned(),
                );
            }
            if let Err(response) = crate::server::enforce_agent_resource_permission(
                &self.state,
                &self.verified_caller,
                crate::identity_verify::permissions::AGENT_RUN,
                agent_id,
            )
            .await
            {
                return err(format!(
                    "host.runAgent agent is not authorized (HTTP {})",
                    response.status()
                ));
            }
        }
        let preset = parse_preset(args.get("preset").and_then(Value::as_str));
        if let Err(error) = check_preset_grant(&self.grants, &self.plugin_id, preset) {
            return err(error);
        }

        // Bound the verifier: clamp the wall time to a sane range so a stuck
        // sub-agent can never wedge the post-turn hook indefinitely.
        let mut caps = DelegationCaps {
            max_concurrent: 1,
            ..DelegationCaps::default()
        };
        if let Some(w) = args.get("wall_time_secs").and_then(Value::as_u64) {
            caps.wall_time_secs = w.clamp(5, 600);
        }
        if let Some(mt) = args.get("max_tokens").and_then(Value::as_u64) {
            caps.max_tokens = mt.min(u64::from(MAX_DELEGATION_TOKENS)) as u32;
        }

        let spec = DelegateSpec {
            id: "proof".to_string(),
            task: task.to_string(),
            agent_id,
            preset,
            inline: None,
        };
        // depth = 1: a top-level delegation launched from the chat path.
        let result = if preset.allows_mutation() {
            run_fanout(vec![spec], caps, 1, None).await
        } else {
            crate::workflow::delegation::run_read_only_fanout(vec![spec], caps, 1, None).await
        };
        match result {
            Ok(mut results) => match results.pop() {
                Some(res) => match res.output {
                    Some(out) => ok(json!(out)),
                    None => err(res
                        .error
                        .unwrap_or_else(|| "verifier agent produced no output".to_string())),
                },
                None => err("verifier agent returned no result".to_string()),
            },
            Err(e) => err(e.to_string()),
        }
    }

    /// `host.runFanout({ delegates, caps? })` — run a bounded set of independent
    /// clean-context delegates concurrently through Core's workflow engine. This
    /// is deliberately generic: plugins submit data, while delegation policy and
    /// Gateway routing remain owned by Core.
    pub(super) async fn run_fanout(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_RUN_AGENT) {
            return err(format!(
                "capability '{GRANT_RUN_AGENT}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if let Err(error) = self.require_user_agent_run_permission().await {
            return err(error);
        }
        if let Err(error) = self.refuse_limited_provider_access("host.runFanout").await {
            return err(error);
        }
        let raw_delegates = match args.get("delegates") {
            Some(Value::Array(items)) if !items.is_empty() => items,
            _ => return err("host.runFanout requires a non-empty 'delegates' array".to_string()),
        };
        if raw_delegates.len() > 20 {
            return err("host.runFanout accepts at most 20 delegates".to_string());
        }
        let mut delegates: Vec<DelegateSpec> = match raw_delegates
            .iter()
            .cloned()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()
        {
            Ok(value) => value,
            Err(e) => return err(format!("host.runFanout has an invalid delegate: {e}")),
        };
        let mut ids = HashSet::new();
        for delegate in &mut delegates {
            if delegate.id.trim().is_empty() || delegate.task.trim().is_empty() {
                return err(
                    "host.runFanout delegates require non-empty 'id' and 'task'".to_string()
                );
            }
            if delegate.id.len() > 128
                || delegate.id.chars().any(char::is_control)
                || delegate.task.chars().count() > 64 * 1024
            {
                return err(
                    "host.runFanout delegate id/task exceeds its bounded input limit".to_owned(),
                );
            }
            if !ids.insert(delegate.id.clone()) {
                return err(format!(
                    "host.runFanout duplicate delegate id '{}'",
                    delegate.id
                ));
            }
            if let Some(raw_agent_id) = delegate.agent_id.as_deref() {
                let agent_id = raw_agent_id.trim().to_owned();
                if agent_id.is_empty() {
                    return err("host.runFanout received an empty agent_id".to_owned());
                }
                delegate.agent_id = Some(agent_id.clone());
                if agent_id.len() > 128 || agent_id.chars().any(char::is_control) {
                    return err("host.runFanout received an invalid agent_id".to_owned());
                }
                if let Some(calling_agent) = self.calling_agent_id.as_deref() {
                    if calling_agent != agent_id.as_str() {
                        return err(
                            "host.runFanout cannot target an agent different from the current turn"
                                .to_owned(),
                        );
                    }
                }
                if !crate::fleet::is_agent_available(&agent_id) {
                    return err(
                        "host.runFanout agent is unavailable under organization policy".to_owned(),
                    );
                }
                if let Err(response) = crate::server::enforce_agent_resource_permission(
                    &self.state,
                    &self.verified_caller,
                    crate::identity_verify::permissions::AGENT_RUN,
                    &agent_id,
                )
                .await
                {
                    return err(format!(
                        "host.runFanout agent is not authorized (HTTP {})",
                        response.status()
                    ));
                }
            }
            if let Some(inline) = &delegate.inline {
                if inline.system_prompt.trim().is_empty() {
                    return err("host.runFanout inline system_prompt must be non-empty".to_string());
                }
                if inline.system_prompt.chars().count() > 64 * 1024
                    || inline
                        .model
                        .as_deref()
                        .is_some_and(|model| model.chars().count() > 256)
                {
                    return err(
                        "host.runFanout inline model fields exceed their bounded input limits"
                            .to_owned(),
                    );
                }
            }
        }
        let mut caps = match args.get("caps").cloned() {
            Some(value) => match serde_json::from_value::<DelegationCaps>(value) {
                Ok(caps) => caps,
                Err(e) => return err(format!("host.runFanout has invalid caps: {e}")),
            },
            None => DelegationCaps::default(),
        };
        caps.max_concurrent = caps.effective_concurrency();
        caps.wall_time_secs = caps.wall_time_secs.clamp(5, 600);
        caps.max_tokens = caps.effective_max_tokens();
        for delegate in &delegates {
            if let Err(error) = check_preset_grant(&self.grants, &self.plugin_id, delegate.preset) {
                return err(error);
            }
        }
        let read_only = delegates
            .iter()
            .all(|delegate| !delegate.preset.allows_mutation());
        let result = if read_only {
            crate::workflow::delegation::run_read_only_fanout(delegates, caps, 1, None).await
        } else {
            run_fanout(delegates, caps, 1, None).await
        };
        match result {
            Ok(results) => ok(json!({
                "ok": true,
                "count": results.len(),
                "results": results,
            })),
            Err(e) => err(e.to_string()),
        }
    }

    pub(super) async fn side_model(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_SIDE_MODEL) {
            return err(format!(
                "capability '{GRANT_SIDE_MODEL}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let args = crate::i18n::reply_language::apply_to_side_model_args(args).await;
        let prompt = args
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if prompt.is_empty() {
            return err("host.sideModel requires a non-empty 'prompt'".to_string());
        }
        let system = args
            .get("system")
            .and_then(Value::as_str)
            .unwrap_or("You are a careful assistant.");
        if prompt.chars().count() > 64 * 1024 {
            return err("host.sideModel prompt exceeds the 64 KiB limit".to_owned());
        }
        if system.chars().count() > 64 * 1024 {
            return err("host.sideModel system prompt exceeds the 64 KiB limit".to_owned());
        }
        let images = match validate_side_model_images(&args) {
            Ok(images) => images,
            Err(message) => return err(message),
        };
        // Character limits do not bound bytes: escaped or multi-byte text plus
        // images can still exceed the Gateway's chat body limit. Refuse here,
        // with the bridge's own name, instead of surfacing a Gateway 413.
        if let Err(message) = crate::server::encode_side_model_request(
            &crate::server::side_model_payload("", "", system, prompt, &images),
        ) {
            return err(format!("host.sideModel refused: {message}"));
        }
        let explicit = args.get("model").and_then(Value::as_str);
        let provider = args
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let pref_key = args.get("model_pref_key").and_then(Value::as_str);
        let effort = args.get("effort").and_then(Value::as_str).unwrap_or("");
        if explicit.is_some_and(|model| model.chars().count() > 256)
            || provider.is_some_and(|value| value.chars().count() > 256)
            || pref_key.is_some_and(|value| value.chars().count() > 256)
            || effort.chars().count() > 64
        {
            return err("host.sideModel model selection fields exceed their limits".to_owned());
        }
        let (model, selection_effort) = self.resolve_model(pref_key, explicit).await;
        // The plugin's per-call `effort` is its own considered choice (the
        // advisor asks for "high", auto-expand for "low"), so it wins; the
        // configured selection's effort fills in only when the plugin passed none.
        let effort = if effort.trim().is_empty() {
            selection_effort.as_str()
        } else {
            effort
        };
        // The calling agent's provider limit travels with the call, so the
        // Gateway keeps the completion on the providers that agent may use.
        let provider_access = self.calling_agent_provider_access().await;
        match crate::server::call_side_model_with_images(
            &self.state,
            &crate::sidecar::gateway::SidePurpose::Plugin(self.plugin_id.clone()),
            &model,
            provider,
            effort,
            system,
            prompt,
            &images,
            provider_access.as_deref(),
        )
        .await
        {
            Ok(text) => ok(json!(text)),
            Err(e) => err(e),
        }
    }
}
