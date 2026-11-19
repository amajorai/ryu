//! Acquiring a session Box: who may, and the desktop target.
// test-exempt: moved verbatim out of server/session_box.rs; covered by session_box/tests.rs and broker_relay_tests.rs.

use super::*;

// ── Acquire, resume, park, release ───────────────────────────────────────────

/// The owner a request speaks for (`user:<id>` or `node-owner`).
pub(crate) fn owner_of(auth: &ResolvedAuthorization) -> Result<String, ApiError> {
    environments::owner(auth)
}

/// Whether a caller may create or resume a session Box.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Acquisition {
    Allowed,
    /// Machine verbs stay on the node by configuration: the owner's `node`
    /// preference, or a Box service that cannot run a desktop.
    KeepNode,
    /// This caller may not acquire one now: no rollout flag (or a turn
    /// authority whose token has expired) or no usable Box credential.
    Refused,
}

/// Whether `reason` may create or resume a session Box for this caller: the
/// rollout flag (a local owner without a cloud identity is gated only by the
/// node's Box configuration), a configured Box endpoint that can run a
/// desktop, and for computer use (including a sub-agent's) the owner's target
/// preference.
pub(super) async fn acquisition(
    auth: &ResolvedAuthorization,
    reason: AcquireReason,
) -> Acquisition {
    if environments::require_box_backend_feature(auth)
        .await
        .is_err()
    {
        return Acquisition::Refused;
    }
    let Ok(credential) = box_credential().await else {
        return Acquisition::Refused;
    };
    if matches!(reason, AcquireReason::ComputerUse | AcquireReason::SubAgent)
        && !computer_target_is_auto().await
    {
        return Acquisition::KeepNode;
    }
    if !desktop_supported(&credential).await {
        return Acquisition::KeepNode;
    }
    Acquisition::Allowed
}

/// Whether this node's Box credential resolves (env, or the installed
/// control-plane source on a managed node).
///
/// Reads the process-wide credential only (never a test override), so route
/// gates see exactly what the node is configured with.
pub(crate) async fn box_configured() -> bool {
    ryu_sandbox::box_credential::current().await.is_ok()
}

/// Whether this node serves `computer.*` and `browser.*` from session Boxes
/// at all: a Box credential, a Box service that can run a desktop, and the
/// `auto` computer target. The per-caller rollout flag is checked per call.
pub(crate) async fn serves_machine_verbs() -> bool {
    let Ok(credential) = ryu_sandbox::box_credential::current().await else {
        return false;
    };
    computer_target_is_auto().await && desktop_supported(&credential).await
}

/// Whether this node puts a conversation's computer use on session Boxes: a
/// usable Box credential, a Box service that can run a desktop, and the
/// `auto` computer target. A run that may not start a Box then fails closed
/// instead of driving the node's display (`box_desktop`).
pub(crate) async fn computer_use_goes_to_boxes() -> bool {
    let Ok(credential) = box_credential().await else {
        return false;
    };
    computer_target_is_auto().await && desktop_supported(&credential).await
}

/// How long a desktop capability answer is reused: a positive one for 10
/// minutes, a negative or failed one for 1 minute.
pub(super) const DESKTOP_PROBE_TTL: Duration = Duration::from_secs(600);
pub(super) const DESKTOP_PROBE_RETRY: Duration = Duration::from_secs(60);

/// Whether the Box service behind `credential` can run a desktop Box: it
/// lists `desktop` in its `/health` features only when it has a desktop image
/// (an older service never lists it). Without it a session Box would have no
/// screen, so computer use stays on the node.
pub(super) async fn desktop_supported(credential: &BoxCredential) -> bool {
    static PROBES: OnceLock<StdMutex<HashMap<String, (Instant, bool)>>> = OnceLock::new();
    let probes = PROBES.get_or_init(|| StdMutex::new(HashMap::new()));
    let base = credential.base.as_str().to_owned();
    if let Some((at, supported)) = probes
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&base)
        .copied()
    {
        let ttl = if supported {
            DESKTOP_PROBE_TTL
        } else {
            DESKTOP_PROBE_RETRY
        };
        if at.elapsed() < ttl {
            return supported;
        }
    }
    let supported = match BoxSessionClient::from_credential(credential)
        .features()
        .await
    {
        Ok(features) => features.iter().any(|feature| feature == "desktop"),
        Err(error) => {
            tracing::warn!(error = %error, "Box service features could not be read; computer use stays on the node");
            false
        }
    };
    probes
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(base, (Instant::now(), supported));
    supported
}

/// `session-box-computer-target`: `auto` (the default) or `node`.
pub(crate) async fn computer_target_is_auto() -> bool {
    let Ok(store) = crate::server::preferences::PreferencesStore::open_default() else {
        return true;
    };
    !matches!(
        store.get(PREF_COMPUTER_TARGET).await,
        Ok(Some(value)) if value.trim().eq_ignore_ascii_case("node")
    )
}

/// The Box a conversation's machine verbs run on.
///
/// - A conversation with a cloud task Box attaches to it (no second create).
/// - A live session Box is returned and marked active.
/// - With `acquire`, a parked Box is resumed and a missing one created, after
///   the rollout gate and admission (§7.3). Without it, nothing is created.
/// - A child the cap refuses shares its parent's Box.
///
/// `Ok(None)` means "run on the node": no Box exists and none may be acquired
/// for this caller (flag off, no Box endpoint, or the `node` preference).
pub(crate) async fn desktop_target(
    auth: &ResolvedAuthorization,
    key: &SessionBoxKey,
    acquire: Option<AcquireReason>,
) -> Result<Option<BoxTarget>, ApiError> {
    if owner_of(auth)? != key.owner {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "session_box_forbidden",
            "This session Box belongs to a different caller.",
        ));
    }
    if is_deleted(&key.conversation_id) {
        return Err(deleted_error());
    }
    // A conversation on the user's own plan has no session Box (no live screen, no Box
    // charge, no first-Box cost notice); its agent runs in the provider's cloud.
    if crate::server::subscription_cloud::fences_box(&key.conversation_id) {
        return match acquire {
            Some(AcquireReason::ComputerUse | AcquireReason::SubAgent) => Err(api_error(
                StatusCode::CONFLICT,
                "session_box_unavailable_on_subscription",
                "This conversation runs on your own Claude or ChatGPT plan, which has no Ryu Box or live screen. Start a new conversation to use one.",
            )),
            _ => Ok(None),
        };
    }
    if key.child.is_none() {
        if let Some(target) = cloud_tasks::bound_box(&key.owner, &key.conversation_id).await {
            return Ok(Some(target));
        }
    } else if lock_shared().contains(key) {
        return Box::pin(desktop_target(auth, &key.parent(), acquire)).await;
    }
    let creating = matches!(
        acquire,
        Some(AcquireReason::ComputerUse | AcquireReason::SubAgent)
    );
    let slot = if creating {
        slot_for(key)
    } else {
        match existing_slot(key) {
            Some(slot) => slot,
            None => return Ok(None),
        }
    };
    let mut guard = slot.lock().await;
    // The slot may have left the registry while this call waited for it (a
    // conversation delete releases it; an empty slot is forgotten). An entry
    // stored in such an orphan would be invisible to the sweep, park, status
    // and release, so never act on one.
    let registered = existing_slot(key).is_some_and(|current| Arc::ptr_eq(&current, &slot));
    if !registered || is_deleted(&key.conversation_id) {
        drop(guard);
        if is_deleted(&key.conversation_id) {
            return Err(deleted_error());
        }
        return Box::pin(desktop_target(auth, key, acquire)).await;
    }
    match guard.as_mut() {
        Some(entry) if entry.phase == Phase::Live => {
            entry.last_activity = Instant::now();
            return Ok(Some(entry.target()));
        }
        Some(_) | None if !creating => return Ok(None),
        _ => {}
    }
    let reason = acquire.unwrap_or(AcquireReason::ComputerUse);
    match acquisition(auth, reason).await {
        Acquisition::Allowed => {}
        Acquisition::KeepNode if guard.is_none() => {
            drop(guard);
            forget_empty(key, &slot);
            return Ok(None);
        }
        Acquisition::KeepNode => return Ok(None),
        Acquisition::Refused if guard.is_none() => {
            drop(guard);
            forget_empty(key, &slot);
            return Ok(None);
        }
        // A parked Box exists: its machine verbs must never fall back to
        // the node's display. The turn's authority has lapsed (its token
        // expired) or the Box credential failed; a new message refreshes it.
        Acquisition::Refused => {
            return Err(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "session_box_authority_expired",
                "This conversation's session Box is parked and cannot be resumed for this turn. Send the message again from the conversation to resume it.",
            ))
        }
    }
    let admitted = caps::admit(auth, &key.owner, Some(key), BoxSize::default()).await;
    if let Err(refusal) = admitted {
        let empty = guard.is_none();
        drop(guard);
        if empty {
            forget_empty(key, &slot);
        }
        if key.child.is_some() && refusal.0 == StatusCode::TOO_MANY_REQUESTS {
            // Cap pressure is not an error for a sub-agent: it shares the
            // parent's Box (design §7.5).
            lock_shared().insert(key.clone());
            return Box::pin(desktop_target(auth, &key.parent(), acquire)).await;
        }
        return Err(refusal);
    }
    // The first Box of an owner waits for the one-time cost notice
    // (`notice`), asked only once admission passed so nobody allows a cost
    // and is then refused. The slot is released while the call waits; once
    // allowed, the call starts over (admission is checked again) and the turn
    // goes on. A parked Box resumes without the notice.
    if guard.is_none() && !notice::acknowledged(&key.owner) {
        drop(guard);
        forget_empty(key, &slot);
        notice::wait_for_acknowledgement(key, BoxSize::default()).await?;
        return Box::pin(desktop_target(auth, key, acquire)).await;
    }
    match guard.as_mut() {
        Some(entry) => {
            resume_entry(entry).await?;
            Ok(Some(entry.target()))
        }
        None => match create_entry(key, &broker_relay::relay_owner(auth)).await {
            Ok(entry) => {
                let target = entry.target();
                *guard = Some(entry);
                Ok(Some(target))
            }
            Err(error) => {
                drop(guard);
                forget_empty(key, &slot);
                Err(error)
            }
        },
    }
}
