//! Composio dispatch adapter for the unified tool catalog (#474).
//!
//! The composio-specific logic — key resolution, base-URL pinning, the
//! `POST /tools/execute/{slug}` request, and connection-required detection —
//! lives in the extracted [`ryu_composio::execute`] crate module. This file is
//! the thin Core-side adapter that (1) re-exports the id/config surface the MCP
//! registry resolves against, and (2) turns the crate's typed
//! [`ryu_composio::execute::ExecOutcome`] into the shared `__ryu_elicitation__`
//! envelope.
//!
//! **Why the envelope construction stays in Core (adjudication):** the
//! `__ryu_elicitation__` shape is single-sourced by the identity-vault builder
//! [`crate::identity::to_envelope`] over a Core [`crate::tool_exec::Elicitation`]
//! — the same builder the vault (domain-keyed) detector funnels through. Keeping
//! it here preserves that one-builder invariant; the crate stays free of any
//! Core type. This is glue, not composio business logic.
//!
//! Placement (CLAUDE.md §1): running a Composio action is *what runs* → Core.
//! The allowlist verdict / budget / audit is *what's allowed/measured* → Gateway
//! (the unified [`super::McpRegistry::call_tool_with_user`] path emits those).

use anyhow::Result;
use reqwest::Client;
use serde_json::Value;

pub use ryu_composio::execute::SERVER_NAME;

/// True when a Composio key is configured (preferences or env).
pub fn is_configured() -> bool {
    ryu_composio::service::is_configured() || ryu_composio::auth::is_configured()
}

/// Execute a Composio action (`tool` = the action slug, e.g. `GITHUB_CREATE_ISSUE`).
///
/// Delegates to [`ryu_composio::execute::dispatch`] and maps a
/// [`ryu_composio::execute::ExecOutcome::NeedsConnection`] into the
/// `__ryu_elicitation__` envelope the PTC invoker pauses on (so the HITL connect
/// flow can fire). A normal result is returned as its unwrapped `data` value.
pub async fn dispatch(
    http: &Client,
    tool: &str,
    arguments: Value,
    user_id: Option<&str>,
) -> Result<Value> {
    dispatch_with_connection(
        http,
        tool,
        arguments,
        ryu_composio::connect::Subject::User(user_id),
        None,
        user_id,
    )
    .await
}

/// Execute a Composio action against one server-validated connected account.
/// `None` preserves the ordinary entity-level selection for non-profile calls.
///
/// `subject` is whose account the action runs on: a user's, or an agent's
/// own (its own entity embedded, its account in the owner's tenant with the
/// Connect service). `billing_user_id` is who the Gateway authorizes and
/// bills: always a user, never an agent entity (see [`charge_user_id`]).
pub async fn dispatch_with_connection(
    http: &Client,
    tool: &str,
    arguments: Value,
    subject: ryu_composio::connect::Subject<'_>,
    connected_account_id: Option<&str>,
    billing_user_id: Option<&str>,
) -> Result<Value> {
    crate::sidecar::gateway::authorize_composio_execution(http, billing_user_id).await?;
    let (service_user, agent) = subject.service_parts();
    if let Some(result) = ryu_composio::service::dispatch_as(
        tool,
        &arguments,
        service_user,
        agent,
        connected_account_id,
    )
    .await
    {
        // Connect refuses a call whose toolkit account is missing or expired
        // with a typed precondition; it pauses on the same connect prompt as
        // the embedded path instead of failing.
        if let Err(error) = &result {
            if let Some(outcome) = ryu_composio::service::connection_outcome(error) {
                return Ok(connect_prompt(outcome));
            }
        }
        return result.map(|value| {
            if crate::sidecar::control_plane::registered_org().is_some()
                && value.get("__ryu_composio_billing").is_none()
            {
                billing_envelope(value, None)
            } else {
                value
            }
        });
    }
    let metered = crate::sidecar::control_plane::registered_org().is_some();
    let entity = subject.embedded_user();
    let execution = ryu_composio::execute::dispatch_with_billing(
        http,
        tool,
        arguments,
        entity.as_deref(),
        connected_account_id,
        metered,
    )
    .await?;
    match execution.outcome {
        ryu_composio::execute::ExecOutcome::Ok(data) => {
            if metered {
                Ok(billing_envelope(data, execution.receipt))
            } else {
                Ok(data)
            }
        }
        outcome => Ok(connect_prompt(outcome)),
    }
}

/// The `__ryu_elicitation__` connect prompt for a call that needs an account,
/// from either path. A normal result is returned unchanged.
fn connect_prompt(outcome: ryu_composio::execute::ExecOutcome) -> Value {
    match outcome {
        ryu_composio::execute::ExecOutcome::Ok(data) => data,
        ryu_composio::execute::ExecOutcome::NeedsConnection { message, url } => {
            let elicit = crate::tool_exec::Elicitation {
                kind: "url".to_owned(),
                message,
                url,
                requested_schema: None,
            };
            crate::identity::to_envelope(&elicit)
        }
    }
}

/// The user a Composio authorization or charge is recorded against.
///
/// The verified owner of the call wins. Otherwise the caller's `user_id` is
/// used, except that an agent's own entity (`agent:<owner>:<agent_id>`) is
/// mapped to its owner: that entity only selects the Composio account the
/// action ran on, and an agent's usage is billed to the user who owns it.
/// The agent itself is recorded separately as the charge's `agent_id`.
pub fn charge_user_id(
    verified_owner: Option<&str>,
    client_user_id: Option<&str>,
) -> Option<String> {
    let user = verified_owner
        .map(str::trim)
        .filter(|owner| !owner.is_empty())
        .or_else(|| client_user_id.map(str::trim))?;
    let user = crate::agent_access::AgentAccountPolicy::parse_composio_agent_entity(user)
        .map_or(user, |(owner, _)| owner);
    (!user.is_empty()).then(|| user.to_owned())
}

pub fn billing_envelope(
    data: Value,
    receipt: Option<ryu_composio::receipt::ComposioReceipt>,
) -> Value {
    serde_json::json!({ "__ryu_composio_billing": receipt, "output": data })
}

/// Remove transport metadata before returning data to an agent or API client.
/// Some(None) means execution happened but accounting evidence is unavailable.
pub fn take_receipt(output: &mut Value) -> Option<Option<ryu_composio::receipt::ComposioReceipt>> {
    let receipt = output.get("__ryu_composio_billing")?;
    let receipt = serde_json::from_value(receipt.clone()).ok();
    *output = output
        .get_mut("output")
        .map(Value::take)
        .unwrap_or(Value::Null);
    Some(receipt)
}

/// One Composio execution to report to Gateway's `/v1/budget/charge`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCharge {
    pub receipt: Option<ryu_composio::receipt::ComposioReceipt>,
    pub accounting_unavailable: bool,
}

/// What a finished dispatch owes, stripping billing metadata from a result.
/// A connection prompt owes nothing. Composio bills an execution it logged
/// even when the tool reports a failure, so a failure with a verified receipt
/// is charged under that receipt's transaction ID; the error itself is left
/// exactly as the caller receives it. A failure without one owes nothing.
pub fn take_tool_charge(result: &mut Result<Value>) -> Option<ToolCharge> {
    match result {
        Ok(output) if output.get("__ryu_elicitation__").is_some() => None,
        // Served by a Treg equivalent: Gateway debited that call itself, so
        // there is no Composio execution to charge. Unwrap the answer.
        Ok(output)
            if output
                .get(super::composio_treg_route::ROUTED_PROVIDER_KEY)
                .is_some() =>
        {
            *output = output
                .get_mut("output")
                .map(Value::take)
                .unwrap_or(Value::Null);
            None
        }
        Ok(output) => {
            let billing = take_receipt(output);
            Some(ToolCharge {
                accounting_unavailable: matches!(billing, Some(None)),
                receipt: billing.flatten(),
            })
        }
        Err(error) => {
            ryu_composio::service::failed_execution_receipt(error).map(|receipt| ToolCharge {
                receipt: Some(receipt.clone()),
                accounting_unavailable: false,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn receipt(transaction_id: &str) -> ryu_composio::receipt::ComposioReceipt {
        ryu_composio::receipt::ComposioReceipt {
            auth_config_id: None,
            connected_account_id: None,
            transaction_id: transaction_id.to_owned(),
            usage: Default::default(),
        }
    }

    #[test]
    fn composio_usage_is_billed_to_a_user_never_an_agent_entity() {
        // The verified owner wins over whatever the caller named.
        assert_eq!(
            charge_user_id(Some("owner"), Some("agent:u1:a1")).as_deref(),
            Some("owner")
        );
        assert_eq!(
            charge_user_id(Some("owner"), Some("someone-else")).as_deref(),
            Some("owner")
        );
        // Without one, an agent's own entity is billed to its owner.
        assert_eq!(
            charge_user_id(None, Some("agent:u1:a1")).as_deref(),
            Some("u1")
        );
        assert_eq!(
            charge_user_id(Some("  "), Some("agent:org:u1:agent_x")).as_deref(),
            Some("org:u1")
        );
        assert_eq!(charge_user_id(None, Some("u2")).as_deref(), Some("u2"));
        assert_eq!(charge_user_id(None, Some("  ")), None);
        assert_eq!(charge_user_id(None, None), None);
        // A malformed entity is not a user either way; it is passed through
        // unchanged rather than guessed at.
        assert_eq!(
            charge_user_id(None, Some("agent:u1")).as_deref(),
            Some("agent:u1")
        );
    }

    #[test]
    fn a_result_served_by_treg_is_unwrapped_and_charges_nothing_here() {
        let mut routed: Result<Value> = Ok(json!({
            super::super::composio_treg_route::ROUTED_PROVIDER_KEY: "treg",
            "output": { "ok": true, "provider": "treg", "chargedMicroUsd": 1100 }
        }));
        assert_eq!(take_tool_charge(&mut routed), None);
        assert_eq!(
            routed.unwrap(),
            json!({ "ok": true, "provider": "treg", "chargedMicroUsd": 1100 })
        );
    }

    #[test]
    fn verified_failed_execution_is_charged_once_and_still_fails() {
        let mut result: Result<Value> = Err(ryu_composio::service::FailedExecution {
            receipt: receipt("log_failed-1"),
        }
        .into());
        assert_eq!(
            take_tool_charge(&mut result),
            Some(ToolCharge {
                receipt: Some(receipt("log_failed-1")),
                accounting_unavailable: false,
            })
        );
        // The caller still receives the same failure, not the receipt.
        let error = result.expect_err("a failed execution stays a failure");
        assert_eq!(error.to_string(), "Connect tool execution failed");
    }

    #[test]
    fn connect_precondition_pauses_on_the_connect_prompt_and_owes_nothing() {
        // Connect's `403 precondition_required`, as the crate decodes it.
        let outcome = ryu_composio::execute::ExecOutcome::NeedsConnection {
            message: "This action needs a connected github account.".to_owned(),
            url: None,
        };
        let mut result: Result<Value> = Ok(connect_prompt(outcome));
        assert_eq!(
            result.as_ref().unwrap(),
            &json!({"__ryu_elicitation__": {
                "kind": "url",
                "message": "This action needs a connected github account.",
            }})
        );
        assert!(crate::tool_exec::detect_elicitation(result.as_ref().unwrap()).is_some());
        assert_eq!(take_tool_charge(&mut result), None);
    }

    #[test]
    fn failure_without_a_receipt_is_not_charged() {
        for error in [
            anyhow::anyhow!("Connect tool execution failed"),
            anyhow::anyhow!("Connect execution rejected with HTTP 503"),
        ] {
            let mut result: Result<Value> = Err(error);
            assert_eq!(take_tool_charge(&mut result), None);
            assert!(result.is_err());
        }
    }

    #[test]
    fn successful_execution_charge_is_unchanged() {
        let data = json!({"ok": true});
        let mut metered = Ok(billing_envelope(data.clone(), Some(receipt("log_ok-1"))));
        assert_eq!(
            take_tool_charge(&mut metered),
            Some(ToolCharge {
                receipt: Some(receipt("log_ok-1")),
                accounting_unavailable: false,
            })
        );
        assert_eq!(metered.unwrap(), data);

        let mut unavailable = Ok(billing_envelope(data.clone(), None));
        assert_eq!(
            take_tool_charge(&mut unavailable),
            Some(ToolCharge {
                receipt: None,
                accounting_unavailable: true,
            })
        );
        assert_eq!(unavailable.unwrap(), data);

        let mut unmetered = Ok(data.clone());
        assert_eq!(
            take_tool_charge(&mut unmetered),
            Some(ToolCharge {
                receipt: None,
                accounting_unavailable: false,
            })
        );
        assert_eq!(unmetered.unwrap(), data);

        let prompt = json!({"__ryu_elicitation__": {"kind": "url"}});
        let mut elicitation = Ok(prompt.clone());
        assert_eq!(take_tool_charge(&mut elicitation), None);
        assert_eq!(elicitation.unwrap(), prompt);
    }
}
