//! The **warmup** kernel capabilities (`warmup.detect`, `warmup.list`,
//! `warmup.apply`, `warmup.runNow`).
//!
//! `@ryu/warmup` keeps subscription usage windows open by scheduling one
//! keep-alive agent ping per window on Core's heartbeat scheduler. Nothing here is
//! Warmup-specific inside Core: detection is the agent list plus each candidate's
//! usage snapshot and advertised ACP models, and scheduling is the heartbeat job
//! store. An app reaches these four operations, gated by the existing
//! `warmup:crud` grant:
//!
//! - a sidecar calls `POST /api/host/capability/warmup.<op>` (a
//!   `KERNEL_CAPABILITIES` row in `sidecar::ext_proxy`);
//! - a Companion frame calls `window.ryu.warmup.<op>()`, which the shell forwards
//!   to Core's app host bridge (`POST /api/plugins/:id/host`,
//!   `server::plugin_bridge_api`), checked against the app's approved grants.
//!
//! Both reach [`WarmupOp::run`], which drives the SAME handlers the
//! `/api/agents*` and `/heartbeat/jobs*` routes serve, in-process. Two gates hold
//! at once and neither stands in for the other:
//!
//! - **the app grant** (`warmup:crud`), checked by the caller's entry point;
//! - **the user's permission**: the handlers run their own `agent.view` /
//!   `agent.edit` checks and per-user job visibility against the verified caller.
//!   The bridge passes the signed-in user; a sidecar has no user, so it is
//!   checked as an anonymous caller — allowed only on an unbound single-operator
//!   node, refused on an org-bound or managed node, exactly as an anonymous
//!   request to `/heartbeat/jobs` is.
//!
//! **Owner scoping.** The owning app is the authenticated caller (the bridge's
//! path id, or the sidecar's verified plugin id), never a value from the args.
//! `list` returns only that app's jobs, `apply` deletes and creates only that
//! app's jobs, and `runNow` refuses any job the app does not own — so the grant
//! is "manage my warmup pings", never "run any automation on this node".

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use serde_json::{json, Value};

use super::kernel_op::{decode_handler_reply as handler_json, KernelOpError};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;
use crate::scheduler::store::{JobTarget, Schedule};

/// The grant every operation requires. Already in the Gateway's reviewed
/// vocabulary and already declared by `@ryu/warmup`.
pub(crate) const GRANT_WARMUP: &str = "warmup:crud";

/// Upper bound on one `apply` batch. A warmup plan is a handful of pings per
/// agent; a larger batch is a bug or abuse, refused before anything is deleted.
const MAX_APPLY_JOBS: usize = 64;

/// A refused or failed warmup operation (the shared kernel-operation error).
pub(crate) type WarmupError = KernelOpError;

/// One warmup operation. The wire name is the same on the kernel-capability
/// table and the app host bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WarmupOp {
    /// Subscription agents with their usage windows and advertised models.
    Detect,
    /// The calling app's scheduled jobs.
    List,
    /// Replace the calling app's scheduled jobs with the given set.
    Apply,
    /// Run one of the calling app's jobs now.
    RunNow,
}

impl WarmupOp {
    /// The operation a capability / host-method name selects, if any.
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "warmup.detect" => Some(Self::Detect),
            "warmup.list" => Some(Self::List),
            "warmup.apply" => Some(Self::Apply),
            "warmup.runNow" => Some(Self::RunNow),
            _ => None,
        }
    }

    /// Answer the operation for `owner_app` (the authenticated calling app) on
    /// behalf of `caller` (the verified user, or `None` for a sidecar).
    pub(crate) async fn run(
        self,
        state: &ServerState,
        owner_app: &str,
        caller: &Option<VerifiedCaller>,
        args: &Value,
    ) -> Result<Value, WarmupError> {
        match self {
            Self::Detect => detect(state, caller).await,
            Self::List => list(state, owner_app, caller).await,
            Self::Apply => apply(state, owner_app, caller, args).await,
            Self::RunNow => run_now(state, owner_app, caller, args).await,
        }
    }
}

async fn require_permission(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    permission: &str,
) -> Result<(), WarmupError> {
    super::enforce_permission(state, caller, permission)
        .await
        .map_err(|_| {
            WarmupError::new(
                StatusCode::FORBIDDEN,
                format!("insufficient permissions: {permission}"),
            )
        })
}

// ── detect ──────────────────────────────────────────────────────────────────

/// The node's IANA zone: `TZ` when it names a zone, else the `/etc/localtime`
/// link target, else `UTC`. Every answer is one `chrono-tz` parses, so it can be
/// stamped onto a cron schedule unchanged.
fn node_time_zone() -> String {
    let valid = |name: &str| crate::scheduler::cron::parse_tz(name).is_ok();
    if let Ok(tz) = std::env::var("TZ") {
        let tz = tz.trim().trim_start_matches(':');
        if !tz.is_empty() && valid(tz) {
            return tz.to_owned();
        }
    }
    if let Ok(target) = std::fs::read_link("/etc/localtime") {
        let target = target.to_string_lossy();
        if let Some((_, zone)) = target.split_once("zoneinfo/") {
            if valid(zone) {
                return zone.to_owned();
            }
        }
    }
    "UTC".to_owned()
}

/// Shape one candidate from its agent-list row, usage snapshot and ACP config.
///
/// An agent that answers `available: false` is still listed: "signed out" is a
/// state the user can fix, and hiding it would look like the agent does not
/// exist. A failed usage read degrades to `reason: "error"`, a failed config
/// read to no models, rather than failing the whole detection.
fn warmup_agent(agent: &Value, usage: Option<&Value>, config: Option<&Value>) -> Value {
    let windows: Vec<Value> = usage
        .and_then(|u| u.get("windows"))
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .map(|w| {
                    json!({
                        "label": w.get("label").cloned().unwrap_or(Value::Null),
                        "model": w.get("model").cloned().unwrap_or(Value::Null),
                        "usedPercent": w.get("used_percent").cloned().unwrap_or(json!(0)),
                        "resetsAt": w.get("resets_at").cloned().unwrap_or(Value::Null),
                        "windowSeconds": w.get("window_seconds").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let models: Vec<Value> = config
        .and_then(|c| c.pointer("/models/availableModels"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .map(|m| {
                    json!({
                        "modelId": m.get("modelId").cloned().unwrap_or(Value::Null),
                        "name": m.get("name").cloned().unwrap_or(Value::Null),
                        "description": m.get("description").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let reason = match usage {
        Some(u) => u.get("reason").cloned().unwrap_or(Value::Null),
        None => json!("error"),
    };
    json!({
        "id": agent.get("id").cloned().unwrap_or(Value::Null),
        "name": agent.get("name").cloned().unwrap_or(Value::Null),
        "available": usage
            .and_then(|u| u.get("available"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "plan": usage.and_then(|u| u.get("plan")).cloned().unwrap_or(Value::Null),
        "reason": reason,
        "windows": windows,
        "models": models,
    })
}

async fn detect(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
) -> Result<Value, WarmupError> {
    // `list_agents` runs the `agent.view` gate and the per-agent resource ACL.
    let listed =
        handler_json(super::list_agents(State(state.clone()), Extension(caller.clone())).await)
            .await?;
    let candidates: Vec<Value> = listed
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|agent| {
            agent
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(ryu_usage::supports_usage)
        })
        .cloned()
        .collect();

    let detected = futures_util::future::join_all(candidates.iter().map(|agent| async move {
        let id = agent
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let usage = super::usage_api::agent_usage(Path(id.clone()))
            .await
            .into_response();
        let config = super::acp_config(
            State(state.clone()),
            Extension(caller.clone()),
            Path(id),
            Query(super::AcpConfigQuery::default()),
        );
        let (usage, config) = tokio::join!(handler_json(usage), async {
            handler_json(config.await).await
        });
        warmup_agent(agent, usage.ok().as_ref(), config.ok().as_ref())
    }))
    .await;

    let providers = if super::account_warmup::caller_may_ping_accounts(caller) {
        warmup_providers(
            crate::subscriptions::snapshot(crate::subscriptions::SnapshotQuery {
                usage: crate::subscriptions::UsageMode::Refresh,
                include_labels: true,
                ..Default::default()
            })
            .await,
        )
    } else {
        // Saved logins (and their labels) are the node owner's; a member sees
        // agents only, the same rule as `subscriptions.list`.
        Vec::new()
    };

    Ok(json!({ "agents": detected, "providers": providers, "tz": node_time_zone() }))
}

/// One reading's windows in the warmup wire shape.
fn reading_windows(reading: Option<&crate::subscriptions::ProviderUsageReading>) -> Vec<Value> {
    reading
        .map(|reading| reading.windows.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|w| {
            json!({
                "label": w.get("label").cloned().unwrap_or(Value::Null),
                "model": w.get("model").cloned().unwrap_or(Value::Null),
                "usedPercent": w.get("usedPercent").cloned().unwrap_or(json!(0)),
                "resetsAt": w.get("resetsAt").cloned().unwrap_or(Value::Null),
                "windowSeconds": w.get("windowSeconds").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

/// Every provider whose saved accounts can be pinged one at a time
/// (`capabilities.account_ping`) with at least one saved OAuth login, each login
/// carrying its own usage reading. Any other provider's turns go through a pool
/// that picks the account itself, so a per-account schedule for it would not do
/// what it says. A login that needs a new sign-in is still listed (Core never
/// reads it) so the user can see why it is not being warmed. Models are the
/// provider's suggested models the user has not turned off.
fn warmup_providers(snapshot: crate::subscriptions::SubscriptionsSnapshot) -> Vec<Value> {
    snapshot
        .providers
        .into_iter()
        .filter(|provider| provider.capabilities.account_ping)
        .filter_map(|provider| {
            let accounts: Vec<Value> = provider
                .accounts
                .iter()
                .filter(|account| account.kind == crate::pi_config::accounts::KIND_OAUTH)
                .map(|account| {
                    let usage = account.usage.as_ref();
                    let reason = if account.needs_reauth {
                        json!("token_expired")
                    } else {
                        usage
                            .and_then(|usage| usage.reason.as_ref())
                            .and_then(|reason| serde_json::to_value(reason).ok())
                            .unwrap_or(Value::Null)
                    };
                    json!({
                        "id": account.account_id,
                        "label": account.label.clone().unwrap_or_else(|| account.account_id.clone()),
                        "needsReauth": account.needs_reauth,
                        "available": usage.is_some_and(|usage| usage.available),
                        "plan": usage.and_then(|usage| usage.plan.clone()),
                        "reason": reason,
                        "windows": reading_windows(usage),
                    })
                })
                .collect();
            if accounts.is_empty() {
                return None;
            }
            let models: Vec<Value> =
                crate::pi_config::enabled_suggested_models(&provider.provider_id)
                    .into_iter()
                    .map(|model_id| json!({ "modelId": model_id, "name": model_id, "description": null }))
                    .collect();
            Some(json!({
                "id": provider.provider_id,
                "name": provider.label,
                "accounts": accounts,
                "models": models,
            }))
        })
        .collect()
}

// ── list / apply / runNow ───────────────────────────────────────────────────

fn owned_by(job: &Value, owner_app: &str) -> bool {
    job.get("owner_app").and_then(Value::as_str) == Some(owner_app)
}

/// The calling app's jobs, as `GET /heartbeat/jobs` serializes them. The route
/// applies `agent.view` and per-user visibility; this narrows to the owner.
async fn list(
    state: &ServerState,
    owner_app: &str,
    caller: &Option<VerifiedCaller>,
) -> Result<Value, WarmupError> {
    let all = handler_json(
        super::list_jobs(
            State(state.clone()),
            Extension(caller.clone()),
            // Warmup's own jobs include pings pinned to one saved account.
            axum::extract::Query(super::IncludeQuery::including("provider_accounts")),
        )
        .await,
    )
    .await?;
    let jobs: Vec<Value> = all
        .get("jobs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|job| owned_by(job, owner_app))
        .cloned()
        .collect();
    Ok(json!({ "jobs": jobs }))
}

/// One ping to schedule. Narrower than `CreateJobBody`: only an agent target is
/// expressible, and the owner is the authenticated caller, never the args.
#[derive(serde::Deserialize)]
struct WarmupJobArg {
    name: String,
    schedule: Schedule,
    target: WarmupTargetArg,
}

#[derive(serde::Deserialize)]
struct WarmupTargetArg {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, rename = "agentId", alias = "agent_id")]
    agent_id: Option<String>,
    #[serde(default, rename = "providerId", alias = "provider_id")]
    provider_id: Option<String>,
    #[serde(default, rename = "accountId", alias = "account_id")]
    account_id: Option<String>,
    prompt: String,
    #[serde(default)]
    model: Option<String>,
}

/// The scheduler target for one warmup job: an agent ping, or a ping pinned to
/// one saved login of a provider pool.
fn warmup_target(target: WarmupTargetArg) -> Result<JobTarget, WarmupError> {
    let required = |value: Option<String>, field: &str| {
        value
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid(format!("warmup.apply target needs '{field}'")))
    };
    match target.kind.as_str() {
        "agent" => Ok(JobTarget::Agent {
            agent_id: required(target.agent_id, "agentId")?,
            prompt: target.prompt,
            model: target.model.filter(|m| !m.trim().is_empty()),
            conversation_id: None,
        }),
        "provider_account" => Ok(JobTarget::ProviderAccount {
            provider_id: required(target.provider_id, "providerId")?,
            account_id: required(target.account_id, "accountId")?,
            prompt: target.prompt,
            model: Some(required(target.model, "model")?),
        }),
        _ => Err(invalid(
            "warmup.apply schedules agent and provider_account targets only",
        )),
    }
}

#[derive(serde::Deserialize)]
struct ApplyArgs {
    jobs: Vec<WarmupJobArg>,
}

fn invalid(message: impl Into<String>) -> WarmupError {
    WarmupError::new(StatusCode::BAD_REQUEST, message)
}

/// Replace the calling app's jobs with `args.jobs`.
///
/// Core has no batch-update route, so this deletes every job the app owns and
/// creates the given set. Every new job is validated BEFORE anything is
/// deleted, so a bad cron or zone leaves the existing plan intact.
async fn apply(
    state: &ServerState,
    owner_app: &str,
    caller: &Option<VerifiedCaller>,
    args: &Value,
) -> Result<Value, WarmupError> {
    let ApplyArgs { jobs } = serde_json::from_value(args.clone())
        .map_err(|e| invalid(format!("warmup.apply expects {{ jobs: [...] }}: {e}")))?;
    if jobs.len() > MAX_APPLY_JOBS {
        return Err(invalid(format!(
            "warmup.apply accepts at most {MAX_APPLY_JOBS} jobs"
        )));
    }
    require_permission(
        state,
        caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await?;

    let mut planned = Vec::with_capacity(jobs.len());
    for job in jobs {
        let target = warmup_target(job.target)?;
        super::validate_scheduled_job_input(
            state,
            caller,
            &job.name,
            &job.schedule,
            &target,
            true,
            None,
        )
        .await
        .map_err(invalid)?;
        planned.push((job.name, job.schedule, target));
    }

    for job in crate::scheduler::store::list_jobs() {
        if job.owner_app.as_deref() != Some(owner_app)
            || !super::scheduled_job_visible(&job, caller)
        {
            continue;
        }
        let deleted = super::delete_job(
            State(state.clone()),
            Extension(caller.clone()),
            Path(job.id),
        )
        .await;
        match handler_json(deleted).await {
            // Already gone (a concurrent apply) is the state we wanted.
            Err(e) if e.status == StatusCode::NOT_FOUND => {}
            other => {
                other?;
            }
        }
    }

    let mut created = Vec::with_capacity(planned.len());
    for (name, schedule, target) in planned {
        let target = serde_json::to_value(&target)
            .map_err(|e| WarmupError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let (status, Json(body)) = super::create_job(
            State(state.clone()),
            Extension(caller.clone()),
            Json(super::CreateJobBody {
                name,
                schedule,
                target,
                quick_routine: false,
                enabled: true,
                require_approval: false,
                owner_app: Some(owner_app.to_owned()),
            }),
        )
        .await;
        if !status.is_success() {
            let message = body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("could not create the job")
                .to_owned();
            return Err(WarmupError::new(status, message));
        }
        created.push(body.get("job").cloned().unwrap_or(Value::Null));
    }
    Ok(json!({ "jobs": created }))
}

#[derive(serde::Deserialize)]
struct RunNowArgs {
    #[serde(rename = "jobId", alias = "job_id")]
    job_id: String,
}

/// Run one of the calling app's jobs now, through the same handler (and so the
/// same `run_target_for_job` and history record) as `POST /heartbeat/jobs/:id/run`.
async fn run_now(
    state: &ServerState,
    owner_app: &str,
    caller: &Option<VerifiedCaller>,
    args: &Value,
) -> Result<Value, WarmupError> {
    let RunNowArgs { job_id } = serde_json::from_value(args.clone())
        .map_err(|e| invalid(format!("warmup.runNow expects {{ jobId }}: {e}")))?;
    let owned = crate::scheduler::store::load_job(&job_id)
        .is_ok_and(|job| job.owner_app.as_deref() == Some(owner_app));
    if !owned {
        // One message for "missing" and "not yours", so an app cannot probe
        // which job ids other apps or Core own.
        return Err(WarmupError::new(
            StatusCode::NOT_FOUND,
            "That ping is no longer scheduled.",
        ));
    }
    handler_json(
        super::run_job_now(
            State(state.clone()),
            Extension(caller.clone()),
            Path(job_id),
        )
        .await,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::store::{self, ScheduledJob};

    const APP: &str = "@example/warmer";

    fn job(id: &str, owner_app: Option<&str>) -> ScheduledJob {
        ScheduledJob {
            id: id.to_owned(),
            name: id.to_owned(),
            schedule: Schedule::Every {
                interval: "1h".to_owned(),
            },
            target: JobTarget::Agent {
                agent_id: "claude-code".to_owned(),
                prompt: "hi".to_owned(),
                model: None,
                conversation_id: None,
            },
            enabled: true,
            require_approval: false,
            owner_app: owner_app.map(str::to_owned),
            owner_user_id: None,
            org_id: None,
            created_at: "now".to_owned(),
            updated_at: "now".to_owned(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        }
    }

    fn assert_unbound_node() {
        assert!(!crate::sidecar::control_plane::is_managed_node());
        assert!(crate::sidecar::control_plane::registered_org().is_none());
    }

    /// An enabled app whose manifest declares `warmup:crud`, approved or not.
    async fn app_state(directory: &std::path::Path, approved: bool) -> ServerState {
        let state = crate::server::isolated_plugin_hook_test_state(directory);
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        let grants: Vec<String> = if approved {
            vec![GRANT_WARMUP.to_owned()]
        } else {
            Vec::new()
        };
        state.app_store.set_enabled(APP, &grants).await.unwrap();
        let manifest: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
            "id": APP, "name": "Warmup", "version": "1.0.0", "runnables": [],
            "permission_grants": [GRANT_WARMUP],
        }))
        .unwrap();
        state.app_manifests.write().await.push(manifest);
        state
    }

    async fn bridge(state: &ServerState, method: &str, args: Value) -> (StatusCode, Value) {
        let response = crate::server::plugin_bridge_api::plugin_bridge_dispatch(
            State(state.clone()),
            Extension(None),
            Path(APP.to_owned()),
            axum::http::HeaderMap::new(),
            Json(crate::server::plugin_bridge_api::HostDispatchBody {
                method: method.to_owned(),
                args,
            }),
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(
            response.into_body(),
            crate::server::kernel_op::MAX_REPLY_BYTES,
        )
        .await
        .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn detected_providers_list_pingable_oauth_logins_with_their_windows() {
        use crate::server::oauth_pool_policy::Strategy;
        use crate::subscriptions::{
            AccountPinning, AccountState, ProviderCapabilities, ProviderKind, ProviderUsageReading,
            SubscriptionAccount, SubscriptionProvider, SubscriptionsSnapshot,
        };
        let reading = ProviderUsageReading {
            provider_id: "claude-pro-max".to_owned(),
            account_id: Some("acct_ok".to_owned()),
            account_label: None,
            agent_id: None,
            engine: "claude".to_owned(),
            available: true,
            plan: Some("max".to_owned()),
            reason: None,
            model_matched: None,
            observed_at: "2026-10-14T00:00:00Z".to_owned(),
            cached: true,
            retry_after_seconds: None,
            extra_usage_usd: None,
            windows: vec![json!({
                "targetId": "window:Weekly:opus:604800", "label": "Weekly", "scope": "model",
                "model": "opus", "usedPercent": 40.0, "remainingPercent": 60.0,
                "resetsAt": "2026-10-20T00:00:00Z", "windowSeconds": 604800, "window": "7d"
            })],
            meters: Vec::new(),
        };
        let account = |id: &str, kind: &str, needs_reauth: bool, usage| SubscriptionAccount {
            account_id: id.to_owned(),
            label: Some(format!("{id}@example.test")),
            kind: kind.to_owned(),
            active: false,
            gateway_active: false,
            needs_reauth,
            updated_at: 1,
            connection_state: None,
            pool_enabled: true,
            pool_priority: None,
            state: AccountState::Ok,
            usage,
        };
        let provider = |id: &str, ping: bool, accounts| SubscriptionProvider {
            provider_id: id.to_owned(),
            label: id.to_owned(),
            kind: ProviderKind::Subscription,
            managed: false,
            capabilities: ProviderCapabilities {
                account_usage: true,
                account_ping: ping,
                account_pinning: AccountPinning::None,
                pool_strategies: vec![Strategy::QuotaFirst],
                quota_observations: true,
            },
            policy: None,
            active_account_id: None,
            accounts,
        };
        let providers = warmup_providers(SubscriptionsSnapshot {
            version: 1,
            generated_at: "2026-10-14T00:00:00Z".to_owned(),
            providers: vec![
                provider(
                    "claude-pro-max",
                    true,
                    vec![
                        account(
                            "acct_ok",
                            crate::pi_config::accounts::KIND_OAUTH,
                            false,
                            Some(reading),
                        ),
                        account("acct_key", "api_key", false, None),
                        account(
                            "acct_expired",
                            crate::pi_config::accounts::KIND_OAUTH,
                            true,
                            None,
                        ),
                    ],
                ),
                // No per-account ping: never offered, however many logins.
                provider(
                    "copilot",
                    false,
                    vec![account(
                        "acct_c",
                        crate::pi_config::accounts::KIND_OAUTH,
                        false,
                        None,
                    )],
                ),
                // Ping-capable but no OAuth login: nothing to warm.
                provider(
                    "chatgpt",
                    true,
                    vec![account("acct_k", "api_key", false, None)],
                ),
            ],
        });
        assert_eq!(providers.len(), 1);
        let accounts = providers[0]["accounts"].as_array().expect("accounts");
        let ids: Vec<&str> = accounts.iter().filter_map(|a| a["id"].as_str()).collect();
        assert_eq!(ids, ["acct_ok", "acct_expired"]);
        assert_eq!(accounts[0]["label"], "acct_ok@example.test");
        assert_eq!(accounts[0]["available"], true);
        assert_eq!(accounts[0]["plan"], "max");
        assert_eq!(
            accounts[0]["windows"][0],
            json!({ "label": "Weekly", "model": "opus", "usedPercent": 40.0,
                    "resetsAt": "2026-10-20T00:00:00Z", "windowSeconds": 604800 })
        );
        assert_eq!(accounts[1]["needsReauth"], true);
        assert_eq!(accounts[1]["reason"], "token_expired");
        assert_eq!(accounts[1]["windows"], json!([]));
    }

    #[test]
    fn apply_targets_cover_agents_and_single_provider_accounts() {
        let parse =
            |value: Value| warmup_target(serde_json::from_value::<WarmupTargetArg>(value).unwrap());
        assert!(matches!(
            parse(
                json!({ "type": "agent", "agentId": "claude-code", "prompt": "hi", "model": " " })
            ),
            Ok(JobTarget::Agent { model: None, .. })
        ));
        match parse(json!({
            "type": "provider_account", "providerId": "claude-pro-max",
            "accountId": "acct_1", "prompt": "hi", "model": "claude-sonnet-4"
        })) {
            Ok(JobTarget::ProviderAccount {
                provider_id,
                account_id,
                model,
                ..
            }) => {
                assert_eq!(provider_id, "claude-pro-max");
                assert_eq!(account_id, "acct_1");
                assert_eq!(model.as_deref(), Some("claude-sonnet-4"));
            }
            other => panic!("unexpected target: {other:?}"),
        }
        for bad in [
            json!({ "type": "provider_account", "providerId": "claude-pro-max", "accountId": "acct_1", "prompt": "hi" }),
            json!({ "type": "provider_account", "accountId": "acct_1", "prompt": "hi", "model": "m" }),
            json!({ "type": "agent", "prompt": "hi" }),
            json!({ "type": "workflow", "agentId": "x", "prompt": "hi" }),
        ] {
            assert!(parse(bad.clone()).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn op_names_match_the_host_api_methods_and_their_grant() {
        for (name, op) in [
            ("warmup.detect", WarmupOp::Detect),
            ("warmup.list", WarmupOp::List),
            ("warmup.apply", WarmupOp::Apply),
            ("warmup.runNow", WarmupOp::RunNow),
        ] {
            assert_eq!(WarmupOp::from_name(name), Some(op));
            // The Companion path gates on the host-API table's grant; it must be
            // the same existing grant the kernel-capability rows use.
            assert_eq!(
                ryu_kernel_contracts::host_api::grant_for(name),
                Some(GRANT_WARMUP),
                "{name}"
            );
        }
        assert_eq!(WarmupOp::from_name("warmup.delete"), None);
    }

    #[test]
    fn detected_agent_keeps_signed_out_agents_and_degrades_failed_reads() {
        let agent = json!({ "id": "claude-code", "name": "Claude Code" });
        let usage = json!({
            "available": true, "plan": "Max",
            "windows": [{ "label": "Session", "used_percent": 12.5,
                          "resets_at": "2026-10-10T05:00:00Z", "window_seconds": 18000 }]
        });
        let config = json!({ "models": { "availableModels": [
            { "modelId": "opus", "name": "Opus" }
        ] } });
        let shaped = warmup_agent(&agent, Some(&usage), Some(&config));
        assert_eq!(shaped["available"], true);
        assert_eq!(shaped["windows"][0]["usedPercent"], 12.5);
        assert_eq!(shaped["windows"][0]["windowSeconds"], 18000);
        assert_eq!(shaped["models"][0]["modelId"], "opus");
        assert_eq!(shaped["models"][0]["description"], Value::Null);

        let failed = warmup_agent(&agent, None, None);
        assert_eq!(failed["available"], false);
        assert_eq!(failed["reason"], "error");
        assert_eq!(failed["windows"], json!([]));
        assert_eq!(failed["models"], json!([]));
    }

    #[test]
    fn node_time_zone_is_always_a_parseable_zone() {
        assert!(crate::scheduler::cron::parse_tz(&node_time_zone()).is_ok());
    }

    #[tokio::test]
    async fn bridge_refuses_every_warmup_method_without_the_grant() {
        assert_unbound_node();
        let directory = tempfile::tempdir().unwrap();
        let jobs = directory.path().join("jobs");
        let state = app_state(directory.path(), false).await;
        store::with_test_jobs_directory(jobs, async {
            store::save_job(&job("mine", Some(APP))).unwrap();
            for (method, args) in [
                ("warmup.detect", json!({})),
                ("warmup.list", json!({})),
                ("warmup.apply", json!({ "jobs": [] })),
                ("warmup.runNow", json!({ "jobId": "mine" })),
            ] {
                let (status, body) = bridge(&state, method, args).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{method}: {body}");
                assert_eq!(body["error"]["code"], "denied", "{method}");
            }
            // Nothing was touched.
            assert_eq!(store::list_jobs().len(), 1);
        })
        .await;
    }

    #[tokio::test]
    async fn bridge_list_and_apply_are_scoped_to_the_calling_app() {
        assert_unbound_node();
        let directory = tempfile::tempdir().unwrap();
        let jobs = directory.path().join("jobs");
        let state = app_state(directory.path(), true).await;
        store::with_test_jobs_directory(jobs, async {
            store::save_job(&job("mine", Some(APP))).unwrap();
            store::save_job(&job("monitor", Some("@ryu/monitors"))).unwrap();
            store::save_job(&job("core", None)).unwrap();

            let (status, listed) = bridge(&state, "warmup.list", json!({})).await;
            assert_eq!(status, StatusCode::OK, "{listed}");
            let ids: Vec<&str> = listed["result"]["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|j| j["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids, vec!["mine"]);

            // An empty plan removes the app's own jobs and nothing else.
            let (status, applied) = bridge(&state, "warmup.apply", json!({ "jobs": [] })).await;
            assert_eq!(status, StatusCode::OK, "{applied}");
            let mut remaining: Vec<String> = store::list_jobs().into_iter().map(|j| j.id).collect();
            remaining.sort();
            assert_eq!(remaining, vec!["core".to_owned(), "monitor".to_owned()]);

            // A non-agent target is refused before anything is deleted or created.
            store::save_job(&job("mine-again", Some(APP))).unwrap();
            let (status, refused) = bridge(
                &state,
                "warmup.apply",
                json!({ "jobs": [{
                    "name": "x",
                    "schedule": { "kind": "every", "interval": "1h" },
                    "target": { "type": "workflow", "agentId": "a", "prompt": "p" }
                }] }),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
            assert!(store::load_job("mine-again").is_ok());
        })
        .await;
    }

    #[tokio::test]
    async fn run_now_refuses_a_job_the_app_does_not_own() {
        assert_unbound_node();
        let directory = tempfile::tempdir().unwrap();
        let jobs = directory.path().join("jobs");
        let state = app_state(directory.path(), true).await;
        store::with_test_jobs_directory(jobs, async {
            store::save_job(&job("monitor", Some("@ryu/monitors"))).unwrap();
            store::save_job(&job("core", None)).unwrap();
            for id in ["monitor", "core", "missing"] {
                let (status, body) = bridge(&state, "warmup.runNow", json!({ "jobId": id })).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{id}: {body}");
                assert_eq!(
                    body["error"]["message"], "That ping is no longer scheduled.",
                    "{id}"
                );
            }
            // Neither foreign job ran (no history recorded).
            for id in ["monitor", "core"] {
                assert!(store::load_job(id).unwrap().history.is_empty(), "{id}");
            }
        })
        .await;
    }
}
