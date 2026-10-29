//! Turn context for the `pre_model_select` hook.
//!
//! A model-selection hook (the usage pacer) wants to know which subscription
//! provider and saved account the turn is about to spend. Core can only
//! *predict* that before the transport opens: the managed Pi captures its SDK
//! account later, and a proxy may still reselect. Every value here is therefore
//! a best-effort prediction, omitted when unknown, and never a pin.
//!
//! The prediction must not stall the turn. Settings and vault reads are
//! synchronous file I/O, so they run on the blocking pool, and the whole
//! prediction is bounded by [`PREDICTION_TIMEOUT`]; a slow or failed read drops
//! the predictions instead of delaying hook dispatch.

use std::time::Duration;

use serde_json::{json, Value};

use crate::server::oauth_pool_policy::Strategy;

/// Upper bound on the time the prediction may add before hooks run.
const PREDICTION_TIMEOUT: Duration = Duration::from_millis(250);

/// The agent id that runs Core's managed Pi (see `ryu_agent_route_with_user_jwt`).
const MANAGED_PI_AGENT_ID: &str = "ryu";

/// What the turn is predicted to spend. Labels are never part of it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct TurnAccountPrediction {
    pub(super) provider_id: String,
    pub(super) account_id: Option<String>,
    pub(super) pool_strategy: Option<Strategy>,
}

/// Inputs to the direct-managed-Pi decision, gathered once so the decision
/// itself stays pure.
#[derive(Clone, Copy, Debug)]
pub(super) struct ManagedPiRoute<'a> {
    pub(super) agent_id: Option<&'a str>,
    pub(super) cloud_task: bool,
    pub(super) gateway_routing: bool,
    pub(super) provider_routing: &'a str,
    pub(super) managed_binary_present: bool,
}

/// Whether the turn will run Core's managed Pi talking straight to its provider.
///
/// Mirrors the route the turn resolves later: only the `ryu` agent spawns the
/// managed Pi binary, a cloud task takes the plain default route, and Gateway
/// routing hides the provider behind the Gateway. Without the managed binary the
/// route falls back to a Pi on PATH, which captures no saved account.
pub(super) fn is_direct_managed_pi(route: ManagedPiRoute<'_>) -> bool {
    route.agent_id == Some(MANAGED_PI_AGENT_ID)
        && !route.cloud_task
        && !route.gateway_routing
        && route.provider_routing == "direct"
        && route.managed_binary_present
}

/// The `ctx.event` payload for `pre_model_select`. Each prediction is omitted
/// when unknown so a hook can tell "no prediction" from an explicit value.
pub(super) fn event(
    model: &str,
    background: bool,
    prediction: Option<&TurnAccountPrediction>,
) -> Value {
    let mut event = json!({
        "model": model,
        "background": background,
    });
    let Some(prediction) = prediction else {
        return event;
    };
    let Some(fields) = event.as_object_mut() else {
        return event;
    };
    fields.insert("provider_id".to_owned(), json!(prediction.provider_id));
    if let Some(account_id) = prediction.account_id.as_deref() {
        fields.insert("account_id".to_owned(), json!(account_id));
    }
    if let Some(strategy) = prediction.pool_strategy {
        fields.insert("pool_strategy".to_owned(), json!(strategy));
    }
    event
}

/// Predict the provider, account and pool strategy for a turn. `None` when the
/// turn is not a direct managed Pi turn, or when the prediction could not be
/// made within [`PREDICTION_TIMEOUT`].
///
/// `conversation_id` must be `None` for a non-durable conversation, matching the
/// account capture, which keeps no affinity for it.
pub(super) async fn predict(
    agent_id: Option<String>,
    conversation_id: Option<String>,
    cloud_task: bool,
) -> Option<TurnAccountPrediction> {
    match tokio::time::timeout(
        PREDICTION_TIMEOUT,
        predict_inner(agent_id, conversation_id, cloud_task),
    )
    .await
    {
        Ok(prediction) => prediction,
        Err(_) => {
            tracing::debug!("pre_model_select account prediction timed out; omitting it");
            None
        }
    }
}

async fn predict_inner(
    agent_id: Option<String>,
    conversation_id: Option<String>,
    cloud_task: bool,
) -> Option<TurnAccountPrediction> {
    if agent_id.as_deref() != Some(MANAGED_PI_AGENT_ID) || cloud_task {
        return None;
    }
    let blocking = tokio::task::spawn_blocking(move || {
        let config = crate::pi_config::current();
        let direct = is_direct_managed_pi(ManagedPiRoute {
            agent_id: agent_id.as_deref(),
            cloud_task,
            gateway_routing: crate::pi_config::is_gateway_routing(),
            provider_routing: &config.routing,
            managed_binary_present: super::acp::managed_pi_binary().exists(),
        });
        if !direct || config.provider.is_empty() {
            return None;
        }
        let account_id = crate::subscriptions::reading::peek_account(
            &config.provider,
            conversation_id.as_deref(),
            agent_id.as_deref().unwrap_or(MANAGED_PI_AGENT_ID),
        );
        Some((config.provider, account_id))
    });
    let (provider_id, account_id) = match blocking.await {
        Ok(found) => found?,
        Err(error) => {
            tracing::debug!(%error, "pre_model_select account prediction failed");
            return None;
        }
    };
    let pool_strategy = crate::subscriptions::load_policy(&provider_id)
        .await
        .map(|policy| policy.strategy);
    Some(TurnAccountPrediction {
        provider_id,
        account_id,
        pool_strategy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direct_route() -> ManagedPiRoute<'static> {
        ManagedPiRoute {
            agent_id: Some(MANAGED_PI_AGENT_ID),
            cloud_task: false,
            gateway_routing: false,
            provider_routing: "direct",
            managed_binary_present: true,
        }
    }

    #[test]
    fn direct_managed_pi_requires_every_route_condition() {
        assert!(is_direct_managed_pi(direct_route()));
        for route in [
            ManagedPiRoute {
                agent_id: Some("claude-code"),
                ..direct_route()
            },
            ManagedPiRoute {
                agent_id: None,
                ..direct_route()
            },
            ManagedPiRoute {
                cloud_task: true,
                ..direct_route()
            },
            ManagedPiRoute {
                gateway_routing: true,
                ..direct_route()
            },
            ManagedPiRoute {
                provider_routing: "gateway",
                ..direct_route()
            },
            ManagedPiRoute {
                managed_binary_present: false,
                ..direct_route()
            },
        ] {
            assert!(!is_direct_managed_pi(route), "{route:?}");
        }
    }

    #[test]
    fn event_carries_the_predicted_provider_for_a_direct_managed_pi_turn() {
        let prediction = TurnAccountPrediction {
            provider_id: "anthropic".to_owned(),
            account_id: Some("acct_1".to_owned()),
            pool_strategy: Some(Strategy::RoundRobin),
        };
        let event = event("claude-sonnet", false, Some(&prediction));
        assert_eq!(
            event,
            json!({
                "model": "claude-sonnet",
                "background": false,
                "provider_id": "anthropic",
                "account_id": "acct_1",
                "pool_strategy": "round_robin",
            })
        );
    }

    #[test]
    fn event_omits_unknown_predictions() {
        let event_without = event("gpt-5", true, None);
        assert_eq!(
            event_without,
            json!({ "model": "gpt-5", "background": true })
        );

        let provider_only = TurnAccountPrediction {
            provider_id: "chatgpt".to_owned(),
            account_id: None,
            pool_strategy: None,
        };
        let event_partial = event("gpt-5", false, Some(&provider_only));
        let fields = event_partial.as_object().expect("event object");
        assert_eq!(fields.get("provider_id"), Some(&json!("chatgpt")));
        assert!(!fields.contains_key("account_id"));
        assert!(!fields.contains_key("pool_strategy"));
        assert!(!fields.contains_key("label"));
    }

    #[tokio::test]
    async fn non_managed_pi_turns_get_no_prediction() {
        assert_eq!(
            predict(Some("claude-code".to_owned()), Some("c1".to_owned()), false).await,
            None
        );
        assert_eq!(predict(None, Some("c1".to_owned()), false).await, None);
        assert_eq!(
            predict(Some(MANAGED_PI_AGENT_ID.to_owned()), None, true).await,
            None
        );
    }
}
