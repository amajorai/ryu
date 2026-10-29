//! Accepted native capture policy: the runtime snapshot, its persistence, and
//! the capture gates that read it.

use super::*;

/// Accepted native capture policy. Desktop's saved desired preferences remain
/// separate: a refused native update never changes this accepted snapshot.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturePolicy {
    version: u32,
    pub paused: bool,
    pub frames: bool,
    pub app_allowlist: Vec<String>,
}

impl Default for CapturePolicy {
    fn default() -> Self {
        Self {
            version: 1,
            paused: true,
            frames: false,
            app_allowlist: Vec::new(),
        }
    }
}

pub(crate) static CAPTURE_POLICY: RwLock<CapturePolicy> = RwLock::new(CapturePolicy {
    version: 1,
    paused: false,
    frames: true,
    app_allowlist: Vec::new(),
});
const MAX_CAPTURE_POLICY_BYTES: usize = 2 * 1024 * 1024;

fn validate_capture_policy(policy: &CapturePolicy) -> Result<(), ShadowError> {
    if policy.version != 1 {
        return Err(capture_storage_error(
            "Unsupported saved capture policy version",
        ));
    }
    let encoded =
        serde_json::to_vec(policy).map_err(|error| capture_storage_error(error.to_string()))?;
    if encoded.len() > MAX_CAPTURE_POLICY_BYTES {
        return Err(capture_storage_error(
            "Saved capture policy exceeds size limit",
        ));
    }
    Ok(())
}

pub(crate) fn load_capture_policy(
    conn: &rusqlite::Connection,
) -> Result<CapturePolicy, ShadowError> {
    let raw: Option<String> = conn
        .query_row("SELECT policy FROM capture_policy WHERE id=1", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| capture_storage_error(error.to_string()))?;
    let Some(raw) = raw else {
        return Ok(CapturePolicy::default());
    };
    if raw.len() > MAX_CAPTURE_POLICY_BYTES {
        return Err(capture_storage_error(
            "Saved capture policy exceeds size limit",
        ));
    }
    let policy: CapturePolicy = serde_json::from_str(&raw)
        .map_err(|error| capture_storage_error(format!("Invalid saved capture policy: {error}")))?;
    validate_capture_policy(&policy)?;
    Ok(policy)
}

pub fn capture_policy_snapshot() -> Result<CapturePolicy, ShadowError> {
    CAPTURE_POLICY
        .read()
        .map(|policy| policy.clone())
        .map_err(|_| capture_storage_error("Capture policy lock poisoned"))
}

/// Hot capture gates borrow the policy rather than cloning its allowlist.
pub fn capture_paused() -> bool {
    CAPTURE_POLICY
        .read()
        .map(|policy| policy.paused)
        .unwrap_or(true)
}

pub fn frame_capture_enabled() -> bool {
    CAPTURE_POLICY
        .read()
        .map(|policy| policy.frames)
        .unwrap_or(false)
}

pub fn capture_allowed(app_name: &str) -> bool {
    let Ok(policy) = CAPTURE_POLICY.read() else {
        return false;
    };
    if policy.paused {
        return false;
    }
    let lower = app_name.to_lowercase();
    policy.app_allowlist.is_empty()
        || policy
            .app_allowlist
            .iter()
            .any(|entry| lower.contains(&entry.to_lowercase()))
}

/// Read capture and retention under the same serialized control boundary.
pub fn capture_control_snapshot() -> Result<(CapturePolicy, u32), ShadowError> {
    let Some(timeline) = TIMELINE.get() else {
        return Ok((capture_policy_snapshot()?, default_history_retention_days()));
    };
    let index = timeline
        .lock()
        .map_err(|_| capture_storage_error("Timeline lock poisoned"))?;
    let policy = capture_policy_snapshot()?;
    let retention = retention::load_policy(&index.conn).map_err(capture_storage_error)?;
    Ok((policy, retention.history_days()))
}

/// Update volatile state for legacy cold-store controls and native test callers.
/// Normal HTTP updates use update_capture_policy to persist before publication.
pub fn set_capture_runtime(
    paused: Option<bool>,
    frames: Option<bool>,
    app_allowlist: Option<Vec<String>>,
) -> Result<(), ShadowError> {
    let mut policy = CAPTURE_POLICY
        .write()
        .map_err(|_| capture_storage_error("Capture policy lock poisoned"))?;
    if let Some(value) = paused {
        policy.paused = value;
    }
    if let Some(value) = frames {
        policy.frames = value;
    }
    if let Some(value) = app_allowlist {
        policy.app_allowlist = value;
    }
    Ok(())
}

/// Lock order is TIMELINE then CAPTURE. One transaction commits capture and
/// requested retention fields before publishing one complete runtime snapshot.
pub fn update_capture_policy(
    paused: Option<bool>,
    frames: Option<bool>,
    app_allowlist: Option<Vec<String>>,
    history_days: Option<u32>,
) -> Result<(CapturePolicy, u32), ShadowError> {
    let Some(timeline) = TIMELINE.get() else {
        if history_days.is_some() {
            return Err(capture_storage_error("Timeline not initialized"));
        }
        set_capture_runtime(paused, frames, app_allowlist)?;
        return Ok((capture_policy_snapshot()?, default_history_retention_days()));
    };
    let index = timeline
        .lock()
        .map_err(|_| capture_storage_error("Timeline lock poisoned"))?;
    let mut active = CAPTURE_POLICY
        .write()
        .map_err(|_| capture_storage_error("Capture policy lock poisoned"))?;
    let policy_exists: bool = index
        .conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM capture_policy WHERE id=1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| capture_storage_error(error.to_string()))?;
    let capture_requested = paused.is_some() || frames.is_some() || app_allowlist.is_some();
    let complete_capture = paused.is_some() && frames.is_some() && app_allowlist.is_some();
    if !policy_exists && capture_requested && !complete_capture {
        return Err(ShadowError::CapturePolicyUninitialized);
    }
    let mut next = active.clone();
    if let Some(value) = paused {
        next.paused = value;
    }
    if let Some(value) = frames {
        next.frames = value;
    }
    if let Some(value) = app_allowlist {
        next.app_allowlist = value;
    }
    validate_capture_policy(&next)?;
    let retention = match history_days {
        Some(days) => retention::RetentionPolicy::from_history_days(days),
        None => retention::load_policy(&index.conn).map_err(capture_storage_error)?,
    };
    let encoded =
        serde_json::to_string(&next).map_err(|error| capture_storage_error(error.to_string()))?;
    let transaction = index
        .conn
        .unchecked_transaction()
        .map_err(|error| capture_storage_error(error.to_string()))?;
    // Retention-only updates do not establish an unknown capture policy.
    // New/old-install bootstrap stays paused until all three capture fields arrive.
    if policy_exists || complete_capture {
        transaction.execute("INSERT INTO capture_policy (id,policy) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET policy=excluded.policy", [&encoded])
            .map_err(|error| capture_storage_error(error.to_string()))?;
    }
    if history_days.is_some() {
        for (key, value) in [
            ("hot_days", retention.hot_days.to_string()),
            ("warm_days", retention.warm_days.to_string()),
            ("max_storage_bytes", retention.max_storage_bytes.to_string()),
        ] {
            transaction.execute("INSERT INTO retention_config (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value.as_str()])
                .map_err(|error| capture_storage_error(error.to_string()))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| capture_storage_error(error.to_string()))?;
    *active = next.clone();
    Ok((next, retention.history_days()))
}
