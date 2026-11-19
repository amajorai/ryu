//! Session Box status, views and cloud task admission.
// test-exempt: moved verbatim out of server/session_box.rs; covered by session_box/tests.rs and broker_relay_tests.rs.

use super::*;

// ── Status ───────────────────────────────────────────────────────────────────

/// `PublicBox.placement` as the UI shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBoxPlacement {
    /// `hetzner`, `vultr`, `digitalocean`, `overflow` or `local`.
    pub provider: Option<String>,
    pub location: Option<String>,
    /// `parked`, `hetzner`, `pool`, `overflow`, `fallback` or `local`.
    pub tier: Option<String>,
    pub isolation: Option<String>,
}

/// The Box screen's state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBoxDesktop {
    pub ready: bool,
    pub viewers: u32,
}

/// One Box as the session UI shows it (design §9). Shared by
/// `SessionBoxStatus` and `CloudTaskStatus`; every field but `state` is
/// optional for older clients and records.
#[derive(Clone, Debug, Default, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBoxView {
    pub id: Option<String>,
    /// `small`, `default` or `large`.
    pub size: Option<String>,
    /// `provisioning`, `ready`, `parked`, `stopped` or `error`.
    pub state: String,
    /// `cloud_task`, `session` or `sub_agent`.
    pub source: Option<String>,
    /// The sub-agent child number, for a child Box.
    pub child: Option<u32>,
    pub placement: Option<SessionBoxPlacement>,
    pub desktop: Option<SessionBoxDesktop>,
    pub running_since: Option<String>,
    /// Seconds metered in the current run.
    pub running_seconds: u64,
    /// Cost so far in this run, from the Gateway's tick (micro-USD).
    pub accrued_micro_usd: u64,
    /// The Gateway's hourly rate for this Box (micro-USD per hour).
    pub rate_per_hour_micro_usd: Option<u64>,
    pub balance_micro_usd: Option<i64>,
    pub minutes_remaining: Option<u64>,
    /// `none`, `low` or `critical`.
    pub warning: String,
    /// Why the Box stopped: `user`, `idle`, `ttl`, `balance`, `budget`,
    /// `accounting`, `liveness`, `suspended` or `restart`.
    pub stop_reason: Option<String>,
    /// When a live Box is parked for its lifetime.
    pub expires_at: Option<String>,
}

/// `GET /api/session-boxes/{conversationId}`.
#[derive(Clone, Debug, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBoxStatus {
    pub conversation_id: String,
    #[serde(rename = "box")]
    #[schema(rename = "box")]
    pub session_box: Option<SessionBoxView>,
    /// Sub-agent child Boxes, by child number.
    pub children: Vec<SessionBoxView>,
    pub caps: Option<BoxCaps>,
    /// Present while a Box of this conversation waits for the owner's
    /// one-time acknowledgement of its hourly cost
    /// (`POST /api/session-boxes/{conversationId}/cost-notice`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_notice: Option<notice::CostNotice>,
}

/// Low-credit level for a run: `critical` under 5 minutes of balance or a
/// non-positive balance, `low` on the Gateway's `warn` verdict or under 15
/// minutes, else `none`.
pub(crate) fn warning_level(
    verdict: Option<heartbeat::Verdict>,
    minutes_remaining: Option<u64>,
    balance_micro_usd: Option<i64>,
) -> &'static str {
    if balance_micro_usd.is_some_and(|balance| balance <= 0)
        || minutes_remaining.is_some_and(|minutes| minutes < 5)
    {
        "critical"
    } else if verdict == Some(heartbeat::Verdict::Warn)
        || minutes_remaining.is_some_and(|minutes| minutes < 15)
    {
        "low"
    } else {
        "none"
    }
}

/// Minutes of balance left at `rate` micro-USD per hour.
pub(crate) fn minutes_remaining(balance_micro_usd: Option<i64>, rate: Option<u64>) -> Option<u64> {
    let balance = u64::try_from(balance_micro_usd?).unwrap_or(0);
    let rate = rate.filter(|rate| *rate > 0)?;
    Some(balance.saturating_mul(60) / rate)
}

/// The hourly rate at which the wallet `run` reports is drained: the rates
/// of every live run billed to the same org (this run's own when it has no
/// org). `None` until this run has a rate.
pub(crate) fn combined_rate(
    run: &heartbeat::SandboxRunSnapshot,
    active: &[heartbeat::SandboxRunSnapshot],
) -> Option<u64> {
    let own = run.rate_micro_usd_per_hour?;
    let Some(org) = run.org_id.as_deref() else {
        return Some(own);
    };
    let others: u64 = active
        .iter()
        .filter(|other| other.run_id != run.run_id && other.org_id.as_deref() == Some(org))
        .filter_map(|other| other.rate_micro_usd_per_hour)
        .fold(0, u64::saturating_add);
    Some(own.saturating_add(others))
}

pub(super) fn view_cache() -> &'static StdMutex<HashMap<String, (Instant, BoxView)>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, (Instant, BoxView)>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// The Box service's view of one Box, reused for [`VIEW_CACHE_TTL`].
pub(super) async fn fetch_view(box_id: &WorkspaceId) -> Option<BoxView> {
    {
        let cache = view_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((fetched, view)) = cache.get(&box_id.0) {
            if fetched.elapsed() < VIEW_CACHE_TTL {
                return Some(view.clone());
            }
        }
    }
    let view = tokio::time::timeout(Duration::from_secs(3), async {
        box_client().await.ok()?.status(box_id).await.ok()
    })
    .await
    .ok()
    .flatten()?;
    let mut cache = view_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.retain(|_, (fetched, _)| fetched.elapsed() < VIEW_CACHE_TTL);
    cache.insert(box_id.0.clone(), (Instant::now(), view.clone()));
    Some(view)
}

pub(super) fn placement_of(value: Option<&Value>) -> Option<SessionBoxPlacement> {
    let value = value?.as_object()?;
    let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
    Some(SessionBoxPlacement {
        provider: text("provider"),
        location: text("location"),
        tier: text("tier"),
        isolation: text("isolation"),
    })
}

/// Build the UI view of one Box from the heartbeat run and, while it is
/// live, the Box service's own view.
pub(crate) async fn box_view(
    target: &BoxTarget,
    live: bool,
    stop_reason: Option<String>,
    run_until: Option<u64>,
    child: Option<u32>,
) -> SessionBoxView {
    let snapshot = heartbeat::run_snapshot(&target.run_id);
    let remote = if live {
        fetch_view(&target.box_id).await
    } else {
        None
    };
    let rate = snapshot
        .as_ref()
        .and_then(|run| run.rate_micro_usd_per_hour);
    let balance = snapshot.as_ref().and_then(|run| run.balance_micro_usd);
    // The wallet is shared: every running Box of the org draws on it.
    let minutes = minutes_remaining(
        balance,
        snapshot
            .as_ref()
            .and_then(|run| combined_rate(run, &heartbeat::list_active_runs())),
    );
    let state = match (live, remote.as_ref().map(|view| view.status)) {
        (false, _) => "parked",
        (true, Some(BoxStatus::Provisioning)) => "provisioning",
        (true, Some(BoxStatus::Stopping | BoxStatus::Stopped)) => "parked",
        (true, Some(BoxStatus::Error)) => "error",
        (true, Some(BoxStatus::Deleted)) => "stopped",
        (true, _) => "ready",
    };
    let viewers = relay_viewer_count(&target.box_id.0);
    SessionBoxView {
        id: Some(target.box_id.0.clone()),
        size: Some(target.size.as_str().to_owned()),
        state: state.to_owned(),
        source: Some(target.source.label().to_owned()),
        child,
        placement: remote
            .as_ref()
            .and_then(|view| placement_of(view.placement.as_ref())),
        desktop: remote.as_ref().and_then(|view| {
            view.desktop.map(|desktop| SessionBoxDesktop {
                ready: desktop.ready,
                viewers: desktop.viewers.max(viewers),
            })
        }),
        running_since: remote.as_ref().and_then(|view| view.running_since.clone()),
        running_seconds: snapshot.as_ref().map_or(0, |run| run.elapsed_seconds),
        accrued_micro_usd: snapshot.as_ref().map_or(0, |run| run.accrued_micro_usd),
        rate_per_hour_micro_usd: rate,
        balance_micro_usd: balance,
        minutes_remaining: minutes,
        warning: warning_level(
            snapshot.as_ref().and_then(|run| run.last_verdict),
            minutes,
            balance,
        )
        .to_owned(),
        stop_reason,
        expires_at: if live {
            run_until.and_then(rfc3339)
        } else {
            None
        },
    }
}

/// The view of one registry entry.
pub(super) async fn entry_view(key: &SessionBoxKey) -> Option<SessionBoxView> {
    let slot = existing_slot(key)?;
    let (target, live, stop_reason, run_until) = {
        let guard = slot.try_lock().ok()?;
        let entry = guard.as_ref()?;
        (
            entry.target(),
            entry.phase == Phase::Live,
            entry.stop_reason.clone(),
            entry.run_until,
        )
    };
    Some(box_view(&target, live, stop_reason, Some(run_until), key.child).await)
}

/// The session Box status of one conversation, or `None` when it has no Box.
pub(crate) async fn status(owner: &str, conversation_id: &str) -> Option<SessionBoxStatus> {
    let parent = SessionBoxKey::session(owner, conversation_id);
    let mut session_box = match cloud_tasks::bound_box(owner, conversation_id).await {
        Some(target) => Some(box_view(&target, true, None, None, None).await),
        None => entry_view(&parent).await,
    };
    if session_box.is_none() {
        // An entry being created holds its lock.
        if let Some(slot) = existing_slot(&parent) {
            if slot.try_lock().is_err() {
                session_box = Some(SessionBoxView {
                    state: "provisioning".to_owned(),
                    warning: "none".to_owned(),
                    source: Some(TargetSource::Session.label().to_owned()),
                    ..SessionBoxView::default()
                });
            }
        }
    }
    let mut children = Vec::new();
    for key in conversation_keys(conversation_id)
        .into_iter()
        .filter(|key| key.owner == owner && key.child.is_some())
    {
        if let Some(view) = entry_view(&key).await {
            children.push(view);
        }
    }
    let cost_notice = notice::pending_notice(owner, conversation_id);
    if session_box.is_none() && children.is_empty() && cost_notice.is_none() {
        return None;
    }
    Some(SessionBoxStatus {
        conversation_id: conversation_id.to_owned(),
        session_box,
        children,
        caps: caps::cached_caps(owner),
        cost_notice,
    })
}

/// A cloud task Box admission refusal (429 or 402), carried through the
/// task preparation's error so the route answers with it.
#[derive(Debug)]
pub(crate) struct AdmissionRefusal(pub ApiError);

impl std::fmt::Display for AdmissionRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = self.0 .1 .0["error"]["message"]
            .as_str()
            .unwrap_or("The Box was not admitted.");
        formatter.write_str(message)
    }
}

impl std::error::Error for AdmissionRefusal {}

/// Admit a cloud task's Box of `size` for `owner` before it is created: the
/// same signed running cap, credit pre-flight and Box limits as a session Box
/// (design §7.2, §7.3).
pub(crate) async fn admit_cloud_task(
    auth: &ResolvedAuthorization,
    owner: &str,
    size: BoxSize,
) -> Result<(), AdmissionRefusal> {
    caps::admit(auth, owner, None, size)
        .await
        .map_err(AdmissionRefusal)
}

/// The caller's running Boxes and cap, refreshed for this request.
pub(crate) async fn owner_caps(auth: &ResolvedAuthorization, owner: &str) -> Option<BoxCaps> {
    caps::refresh(auth, owner).await;
    caps::cached_caps(owner)
}

/// Live session Boxes (not cloud task Boxes) of one owner, leaving out
/// `exclude` (the Box being admitted, whose slot the caller holds).
pub(super) fn live_session_boxes(owner: &str, exclude: Option<&SessionBoxKey>) -> u32 {
    let slots: Vec<Slot> = lock_registry()
        .iter()
        .filter(|(key, _)| key.owner == owner && Some(*key) != exclude)
        .map(|(_, slot)| slot.clone())
        .collect();
    let live = slots
        .iter()
        .filter(|slot| {
            // A held lock is an entry being created or resumed: count it.
            slot.try_lock().map_or(true, |entry| {
                entry
                    .as_ref()
                    .is_some_and(|entry| entry.phase == Phase::Live)
            })
        })
        .count();
    u32::try_from(live).unwrap_or(u32::MAX)
}
