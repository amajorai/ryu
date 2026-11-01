//! The start-or-fall-back decision for a prompt whose executor is a provider agent.

use super::super::accounts::ProviderId;
use super::super::routing::{self, Availability, Notice, SessionPin};
use super::super::store::{self, RunRecord};
use super::super::{
    anthropic_plan_allowed, caller_is_node_owner, openai_plan_allowed, plan_owner, rollout_allows,
    unix_now, CloudTaskBackend, Provider,
};
use super::availability::{availability, chosen_account, fallback_accounts, linked, SignIns};
use super::follow_up::follow_up;
use super::launch::{start, StartFailure};
use super::{api_error, owner_only, ApiError};
use crate::server::ResolvedAuthorization;
use axum::http::StatusCode;
use axum::Json;
use serde_json::json;
use std::collections::BTreeMap;

/// A prompt for a cloud task whose executor is a provider agent.
pub(crate) struct RouteRequest<'a> {
    pub(crate) owner: &'a str,
    pub(crate) conversation_id: &'a str,
    pub(crate) environment_id: &'a str,
    pub(crate) executor: &'a str,
    pub(crate) agent_id: Option<&'a str>,
    pub(crate) pin: SessionPin,
    /// The session's account pin, `(provider, account id)`.
    pub(crate) account: Option<(ProviderId, &'a str)>,
    pub(crate) text: &'a str,
}

#[derive(Debug)]
pub(crate) enum RouteOutcome {
    /// The task runs on the user's plan. No Box exists and none is billed.
    Started {
        record: RunRecord,
        notices: Vec<Notice>,
    },
    /// Run it on the Ryu Box (the existing path, with its admission, caps and cost
    /// notice). `notices` says why a preferred plan was skipped.
    UseBox { notices: Vec<Notice> },
}

/// Decide where a prompt runs, and start it there when that is the user's plan.
pub(crate) async fn start_or_fall_back(
    auth: &ResolvedAuthorization,
    request: RouteRequest<'_>,
) -> Result<RouteOutcome, ApiError> {
    // The plan store keys the node owner by one stable identity, signed in or not.
    let owner = plan_owner(auth, request.owner);
    let request = RouteRequest {
        owner: &owner,
        ..request
    };
    // A conversation already on a plan stays on it: follow up there.
    if let Some(record) = store::run(request.conversation_id) {
        if record.owner != request.owner {
            return Err(api_error(
                StatusCode::CONFLICT,
                "cloud_task_on_subscription",
                "This conversation runs on another account's plan.",
            ));
        }
        // A session belongs to the account that started it: it cannot move.
        if let Some((provider, id)) = request.account {
            let same_provider = record
                .backend
                .provider()
                .is_some_and(|own| ProviderId::from(own) == provider);
            if !same_provider || id != record.account() {
                return Err(api_error(
                    StatusCode::CONFLICT,
                    "cloud_task_account_locked",
                    "This conversation runs on another of your accounts. Start a new conversation to use a different account.",
                ));
            }
        }
        return follow_up(record, request.text).await;
    }
    let settings = store::settings(request.owner);
    if let Some((provider, id)) = request.account {
        if !linked(request.owner, provider, id) {
            return Err(api_error(
                StatusCode::NOT_FOUND,
                "subscription_account_not_found",
                "That account is not linked on this node.",
            ));
        }
    }
    let may_use_plan = settings.enabled && caller_is_node_owner(auth) && rollout_allows(auth).await;
    let pinned_plan = request
        .pin
        .backend
        .is_some_and(|backend| backend != CloudTaskBackend::RyuBox);
    if pinned_plan && !caller_is_node_owner(auth) {
        return Err(owner_only());
    }
    if !may_use_plan && !pinned_plan {
        return Ok(RouteOutcome::UseBox {
            notices: Vec::new(),
        });
    }
    let link = settings.environments.get(request.environment_id).cloned();
    let now = unix_now();
    let mut known = BTreeMap::new();
    let mut sign_ins = SignIns::default();
    let mut primary = BTreeMap::new();
    for provider in [Provider::Anthropic, Provider::Openai] {
        let account = chosen_account(
            request.owner,
            &settings,
            provider,
            request.agent_id,
            request.account,
        );
        primary.insert(ProviderId::from(provider), account);
    }
    let account_for = |backend: CloudTaskBackend| {
        backend
            .provider()
            .and_then(|provider| primary.get(&ProviderId::from(provider)))
            .cloned()
    };
    let openai_allowed = openai_plan_allowed(auth).await;
    let anthropic_allowed = anthropic_plan_allowed(auth).await;
    let mut early_notices: Vec<Notice> = Vec::new();
    for backend in CloudTaskBackend::PLANS {
        let state = if !backend.serves(request.executor) {
            Availability::Disabled
        } else if !may_use_plan {
            // A pin to a plan that is switched off for this caller.
            Availability::Disabled
        } else if backend.provider() == Some(Provider::Openai) && !openai_allowed {
            // A ChatGPT plan on a Ryu-hosted node waits for OpenAI's approval.
            Availability::Disabled
        } else if backend.provider() == Some(Provider::Anthropic) && !anthropic_allowed {
            // A Claude plan on a Ryu-hosted node would leave from a datacenter IP.
            Availability::Disabled
        } else if let Some(account) = account_for(backend) {
            let state = availability(backend, &account, link.as_ref(), now, &mut sign_ins).await;
            let provider = backend.provider().unwrap_or(Provider::Anthropic);
            let stand_in = fallback_accounts(request.owner, &settings, provider, &account.id)
                .iter()
                .any(|other| store::cooldown_remaining(&other.key(provider), now).is_none());
            if state == Availability::CoolingDown && stand_in {
                // The owner listed another account to use while this one is limited.
                let notice = Notice::new(
                    "subscription_cooling_down",
                    backend,
                    format!(
                        "Your {} plan ({}) hit its usage limit recently, so Ryu uses the next account you listed.",
                        backend.plan_name(),
                        account.label
                    ),
                )
                .for_account(&account.id);
                let said = early_notices.iter().any(|known| {
                    known.code == notice.code && known.account_id == notice.account_id
                });
                if !said {
                    early_notices.push(notice);
                }
                Availability::Ready
            } else {
                state
            }
        } else {
            Availability::Disabled
        };
        known.insert(backend, state);
    }
    let agent_order = request
        .agent_id
        .and_then(|agent| settings.agent_overrides.get(agent))
        .map(Vec::as_slice);
    let plan = routing::resolve(
        request.executor,
        request.pin,
        agent_order,
        &settings.default_order,
        |backend| known.get(&backend).copied().unwrap_or(Availability::Ready),
    );
    let mut notices = early_notices;
    notices.extend(plan.notices);
    let candidates = plan.candidates;
    for backend in candidates {
        if backend == CloudTaskBackend::RyuBox {
            return Ok(RouteOutcome::UseBox { notices });
        }
        let (Some(provider), Some(first)) = (backend.provider(), account_for(backend)) else {
            continue;
        };
        // The chosen account first. The owner's listed fallback accounts come next,
        // and only once an account has reached its usage or rate limit (§0b).
        let mut queue = vec![first.clone()];
        queue.extend(fallback_accounts(
            request.owner,
            &settings,
            provider,
            &first.id,
        ));
        for (index, account) in queue.iter().enumerate() {
            let limited = store::cooldown_remaining(&account.key(provider), unix_now()).is_some();
            if index > 0 {
                let state =
                    availability(backend, account, link.as_ref(), unix_now(), &mut sign_ins).await;
                if state != Availability::Ready {
                    if state == Availability::CoolingDown {
                        continue;
                    }
                    break;
                }
            } else if limited {
                // Skipped by routing (or just hit by an earlier backend); its notice
                // is out already. Only a listed fallback account may stand in.
                continue;
            }
            match start(backend, &request, link.as_ref(), account).await {
                Ok(record) => {
                    // A run on this node saved itself and keeps its record current.
                    if !backend.runs_on_node() {
                        store::save_run(record.clone());
                    }
                    return Ok(RouteOutcome::Started { record, notices });
                }
                Err(StartFailure::Fallback(notice)) => {
                    let quota = notice.code == "subscription_quota_fallback";
                    if !notices.iter().any(|known: &Notice| known == &notice) {
                        notices.push(notice);
                    }
                    if !quota {
                        break;
                    }
                }
                Err(StartFailure::Rejected(reason)) => {
                    return Err((
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(json!({"error":{
                            "code":"subscription_run_rejected",
                            "message":format!("{} refused the task: {reason}", backend.cli_name()),
                            "backend":backend,
                        }})),
                    ));
                }
            }
        }
    }
    Err((
        StatusCode::CONFLICT,
        Json(json!({"error":{
            "code":"subscription_backend_unavailable",
            "message":"The backend this task is pinned to cannot run it now.",
            "notices":notices,
        }})),
    ))
}

/// Whether a prompt could run on the node owner's plan at all, without asking any CLI:
/// the executor is a provider agent, the caller is the node owner with the rollout on,
/// and the owner turned plans on (or the session pins one).
pub(crate) async fn may_try_plan(
    auth: &ResolvedAuthorization,
    owner: &str,
    conversation_id: &str,
    executor: &str,
    pin: Option<CloudTaskBackend>,
) -> bool {
    let owner = plan_owner(auth, owner);
    let owner = owner.as_str();
    // A conversation already on a plan always continues there (it is fenced from Boxes).
    if store::run(conversation_id).is_some_and(|record| record.owner == owner) {
        return true;
    }
    let served = CloudTaskBackend::PLANS
        .into_iter()
        .any(|backend| backend.serves(executor));
    let pinned_plan = pin.is_some_and(|backend| backend != CloudTaskBackend::RyuBox);
    served
        && (store::settings(owner).enabled || pinned_plan)
        && caller_is_node_owner(auth)
        && rollout_allows(auth).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner_auth() -> ResolvedAuthorization {
        ResolvedAuthorization {
            context: crate::authorization::AuthorizationContext::owner(0),
            bindings: crate::authorization::RequestBindings::default(),
            caller: None,
            verified_user_jwt: None,
        }
    }

    #[tokio::test]
    async fn the_ryu_agent_never_runs_on_a_plan() {
        let conversation = format!("no-plan-run-{}", std::process::id());
        for pin in [None, Some(CloudTaskBackend::RyuBox)] {
            assert!(!may_try_plan(&owner_auth(), "owner", &conversation, "ryu", pin).await);
        }
    }
}
