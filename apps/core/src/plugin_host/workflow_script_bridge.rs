//! `host.workflowScript` / `host.workflowRunStatus`: let a plugin tool start a
//! durable workflow script (see [`crate::workflow::script`]) and follow it.
//!
//! Scripts run sub-agents, so both verbs need the same `hook:run-agent` grant and
//! user permission as `host.runFanout`. A script's agents always run as the
//! calling agent: a sandboxed body cannot borrow another agent through a script.
//! As with `host.runAgent`, a mutating preset (`code_write`) also needs
//! `hook:run-agent:write`, both for the run's `preset` and for every
//! `agent(prompt, { preset })` call the script makes.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::tool_exec::InvokeOutcome;
use crate::workflow::delegation::PermissionPreset;
use crate::workflow::script;

use super::{
    check_preset_grant, err, ok, PluginHookBridge, GRANT_RUN_AGENT, GRANT_RUN_AGENT_WRITE,
};

/// Longest a single call may block waiting for the run. Plugin tools are capped
/// at 600 seconds, so this leaves room to return the summary.
const MAX_WAIT_SECS: u64 = 540;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartInput {
    script: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    preset: Option<PermissionPreset>,
    /// Runs the same script and args again as a separate run.
    #[serde(default)]
    run_key: Option<String>,
    #[serde(default)]
    wait_secs: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusInput {
    run_id: String,
    #[serde(default)]
    wait_secs: Option<u64>,
}

fn wait_for(secs: Option<u64>) -> Duration {
    Duration::from_secs(secs.unwrap_or(0).min(MAX_WAIT_SECS))
}

impl PluginHookBridge {
    async fn require_script_grant(&self, verb: &str) -> Result<(), String> {
        if !self.grants.contains(GRANT_RUN_AGENT) {
            return Err(format!(
                "capability '{GRANT_RUN_AGENT}' not granted to plugin '{}' ({verb})",
                self.plugin_id
            ));
        }
        self.require_user_agent_run_permission().await
    }

    /// Who owns a script run: this plugin, as this calling agent, in this
    /// conversation. Folded into the run id and recorded on the run, and status
    /// reads must present the same scope, so one plugin (or one agent or
    /// conversation) cannot read another's run by guessing or seeing its id.
    ///
    /// The parts are NUL-joined, so a part that itself holds a NUL would make
    /// the join ambiguous (agent `a\0b` in conversation `c` and agent `a` in
    /// conversation `b\0c` would share one scope). Plugin ids are validated;
    /// agent and conversation ids are not guaranteed NUL-free, so such a caller
    /// is refused instead of being given a scope it might share.
    fn script_run_scope(&self, verb: &str) -> Result<String, String> {
        let agent = self.calling_agent_id.as_deref().unwrap_or("");
        let conversation = self.authorized_conversation_id.as_deref().unwrap_or("");
        if [self.plugin_id.as_str(), agent, conversation]
            .iter()
            .any(|part| part.contains('\0'))
        {
            return Err(format!(
                "{verb}: the calling agent or conversation id is malformed"
            ));
        }
        Ok(format!("{}\u{0}{agent}\u{0}{conversation}", self.plugin_id))
    }

    pub(super) async fn workflow_script(&self, args: Value) -> InvokeOutcome {
        if let Err(error) = self.require_script_grant("host.workflowScript").await {
            return err(error);
        }
        if let Err(error) = self
            .refuse_limited_provider_access("host.workflowScript")
            .await
        {
            return err(error);
        }
        let input: StartInput = match serde_json::from_value(args) {
            Ok(input) => input,
            Err(e) => return err(format!("host.workflowScript: invalid arguments: {e}")),
        };
        if let Some(Err(error)) = input
            .preset
            .map(|preset| check_preset_grant(&self.grants, &self.plugin_id, preset))
        {
            return err(format!("host.workflowScript: {error}"));
        }
        if input
            .run_key
            .as_deref()
            .is_some_and(|key| key.len() > 128 || key.chars().any(char::is_control))
        {
            return err("host.workflowScript: run_key is too long or malformed".to_owned());
        }
        let scope = match self.script_run_scope("host.workflowScript") {
            Ok(scope) => scope,
            Err(error) => return err(error),
        };
        let request = script::ScriptRunRequest {
            code: &input.script,
            args: &input.args,
            agent_id: self.calling_agent_id.as_deref(),
            preset: input.preset,
            allow_mutation: self.grants.contains(GRANT_RUN_AGENT_WRITE),
            scope: &scope,
            run_key: input.run_key.as_deref(),
        };
        let run_id = match script::start_script_run(&request) {
            Ok(run_id) => run_id,
            Err(error) => return err(format!("host.workflowScript: {error}")),
        };
        match script::wait_for_script_run(&run_id, &scope, wait_for(input.wait_secs)).await {
            Ok(summary) => ok(summary),
            Err(error) => err(format!("host.workflowScript: {error}")),
        }
    }

    pub(super) async fn workflow_run_status(&self, args: Value) -> InvokeOutcome {
        if let Err(error) = self.require_script_grant("host.workflowRunStatus").await {
            return err(error);
        }
        let input: StatusInput = match serde_json::from_value(args) {
            Ok(input) => input,
            Err(e) => return err(format!("host.workflowRunStatus: invalid arguments: {e}")),
        };
        let scope = match self.script_run_scope("host.workflowRunStatus") {
            Ok(scope) => scope,
            Err(error) => return err(error),
        };
        match script::wait_for_script_run(&input.run_id, &scope, wait_for(input.wait_secs)).await {
            Ok(summary) => ok(summary),
            Err(error) => err(format!("host.workflowRunStatus: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use serde_json::json;

    use super::*;
    use crate::workflow::store;

    fn bridge(
        state: &crate::server::ServerState,
        plugin_id: &str,
        agent: &str,
        conversation: &str,
    ) -> PluginHookBridge {
        PluginHookBridge::new_for_agent_tool(
            plugin_id.to_owned(),
            HashSet::from([GRANT_RUN_AGENT.to_owned()]),
            state.clone(),
            Some(agent),
            Some(conversation),
        )
    }

    fn status_reply(outcome: InvokeOutcome) -> Result<Value, String> {
        match outcome {
            InvokeOutcome::Result(result) if result.is_error => {
                Err(result.error.unwrap_or_default())
            }
            InvokeOutcome::Result(result) => Ok(result.value),
            InvokeOutcome::Suspend(_) => panic!("status reads never suspend"),
        }
    }

    fn new_run_id() -> String {
        format!(
            "{}{}",
            script::SCRIPT_RUN_PREFIX,
            uuid::Uuid::new_v4().simple()
        )
    }

    fn seed_run(run_id: &str, caller_scope: Option<String>) {
        let mut run = store::WorkflowRun::new(
            run_id.to_owned(),
            format!("{}test", store::SCRIPT_WORKFLOW_PREFIX),
            HashMap::new(),
        );
        run.status = store::RunStatus::Completed;
        run.output
            .insert("result".to_owned(), r#"{"secret":"owner-only"}"#.to_owned());
        run.caller_scope = caller_scope;
        store::save_run(&run).unwrap();
    }

    #[tokio::test]
    async fn run_status_answers_only_the_plugin_agent_and_conversation_that_own_the_run() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let conversation = format!("conv-{}", uuid::Uuid::new_v4().simple());
        let owner = bridge(&state, "@test/owner", "agent-1", &conversation);
        let run_id = new_run_id();
        seed_run(
            &run_id,
            Some(script::scope_digest(
                &owner.script_run_scope("test").unwrap(),
            )),
        );
        let legacy_id = new_run_id();
        seed_run(&legacy_id, None);

        let summary =
            status_reply(owner.workflow_run_status(json!({ "run_id": run_id })).await).unwrap();
        assert_eq!(summary["result"], json!({ "secret": "owner-only" }));

        let unknown = status_reply(
            owner
                .workflow_run_status(json!({ "run_id": new_run_id() }))
                .await,
        )
        .unwrap_err();
        let other_conversation = format!("{conversation}-other");
        let outsiders = [
            bridge(&state, "@test/other", "agent-1", &conversation),
            bridge(&state, "@test/owner", "agent-2", &conversation),
            bridge(&state, "@test/owner", "agent-1", &other_conversation),
        ];
        for outsider in &outsiders {
            let started = std::time::Instant::now();
            let error = status_reply(
                outsider
                    .workflow_run_status(json!({ "run_id": run_id, "wait_secs": 30 }))
                    .await,
            )
            .unwrap_err();
            assert_eq!(error, unknown, "no existence oracle for another scope");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        // A run with no recorded scope is not readable through a plugin.
        let legacy = status_reply(
            owner
                .workflow_run_status(json!({ "run_id": legacy_id }))
                .await,
        )
        .unwrap_err();
        assert_eq!(legacy, unknown);
    }

    #[tokio::test]
    async fn ids_holding_the_scope_separator_cannot_share_another_callers_scope() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        // Agent `a` in conversation `b\0c` joins to the same bytes as agent
        // `a\0b` in conversation `c`: neither may read the other's runs.
        let owner_scope = format!("@test/owner\u{0}a\u{0}b\u{0}c{suffix}");
        let run_id = new_run_id();
        seed_run(&run_id, Some(script::scope_digest(&owner_scope)));

        let callers = [
            bridge(&state, "@test/owner", "a", &format!("b\u{0}c{suffix}")),
            bridge(&state, "@test/owner", "a\u{0}b", &format!("c{suffix}")),
        ];
        for caller in &callers {
            let error = status_reply(
                caller
                    .workflow_run_status(json!({ "run_id": run_id }))
                    .await,
            )
            .unwrap_err();
            assert!(error.contains("malformed"), "{error}");
            let error = status_reply(
                caller
                    .workflow_script(json!({ "script": "return 1;" }))
                    .await,
            )
            .unwrap_err();
            assert!(error.contains("malformed"), "{error}");
        }
    }

    #[tokio::test]
    async fn a_mutating_preset_needs_the_write_grant() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let conversation = format!("conv-{}", uuid::Uuid::new_v4().simple());
        let read_only = bridge(&state, "@test/reader", "agent-1", &conversation);
        let error = status_reply(
            read_only
                .workflow_script(json!({ "script": "return 1;", "preset": "code_write" }))
                .await,
        )
        .unwrap_err();
        assert!(error.contains(GRANT_RUN_AGENT_WRITE), "{error}");
        assert!(error.contains("not granted"), "{error}");
    }
}
