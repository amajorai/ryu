//! URL and request body construction (pure, so it is unit-testable).

use super::*;

// ── URL / body construction (pure, so it is unit-testable) ───────────────────

/// Resolve the manager base: explicit env override, else the hosted default.
/// Trailing slashes are trimmed so joining never doubles one.
pub fn manager_base() -> String {
    std::env::var(MANAGER_URL_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_MANAGER_BASE.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Control-plane origin that owns channel configs: the account backend
/// [`crate::server::sync::SyncClient`] also uses (`RYU_SERVER_URL`, then the
/// backend of the last device sign-in, https only). There is no default
/// address.
pub(super) fn control_plane_base() -> Result<String, BackendError> {
    crate::server::sync::backend::backend_base()
}

pub(super) fn pair_url(base: &str) -> String {
    format!("{}/managed-bot/pair", base.trim_end_matches('/'))
}

pub(super) fn claim_url(base: &str, nonce: &str) -> String {
    format!("{}/managed-bot/claim/{nonce}", base.trim_end_matches('/'))
}

/// `refresh` / `rotate` / `delete` share one shape: a POST to
/// `/managed-bot/<action>` authenticated by the claim_secret, with the nonce in the
/// body.
pub(super) fn action_url(base: &str, action: &str) -> String {
    format!("{}/managed-bot/{action}", base.trim_end_matches('/'))
}

pub(super) fn action_body(nonce: &str) -> Value {
    json!({ "nonce": nonce })
}

/// Reject a nonce that is not a bare base32url/hex token before it reaches a URL
/// path or the pending map.
pub fn validate_nonce(nonce: &str) -> Result<()> {
    if nonce.len() < NONCE_MIN_LEN || nonce.len() > NONCE_MAX_LEN {
        bail!("managed-bot nonce must be {NONCE_MIN_LEN}..={NONCE_MAX_LEN} characters");
    }
    if !nonce
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("managed-bot nonce contains characters outside [A-Za-z0-9_-]");
    }
    Ok(())
}

/// The body that creates a Telegram channel config carrying a managed token.
///
/// Three deliberate choices:
/// - `secrets.bot_token` is the key the untouched adapter reads, so a managed token
///   is indistinguishable from a pasted one downstream.
/// - `managed_bot_secret` / `managed_bot_nonce` ride along so rotation survives a
///   node restart. The control plane only enforces the *required* keys per channel
///   type, so extra keys persist (sealed) rather than 400.
/// - every other field comes from [`ChannelIntent`] — the form the user filled in
///   minutes earlier. The control plane defaults each one when it is absent
///   (`enabled: body.enabled === true`, `agentId: null`, the default reply mode), so
///   an intent field this body drops is a user choice silently discarded.
pub fn create_channel_body(
    name: &str,
    bot_token: &str,
    claim_secret: &str,
    nonce: &str,
    intent: &ChannelIntent,
) -> Value {
    let mut body = json!({
        "channelType": "telegram",
        "name": name,
        // Explicit, because the control plane reads `body.enabled === true`: omitting
        // it would silently disable a bot the user asked to switch on.
        "enabled": intent.enabled,
        "secrets": {
            "bot_token": bot_token,
            "managed_bot_secret": claim_secret,
            "managed_bot_nonce": nonce,
        },
    });
    // A team binding and an agent binding are mutually exclusive in the control
    // plane, and the desktop's single picker already resolved which one this is, so
    // whichever arrived is the one sent.
    for (key, value) in [
        ("agentId", intent.agent_id.as_deref()),
        ("teamId", intent.team_id.as_deref()),
        ("model", intent.model.as_deref()),
        ("systemPrompt", intent.system_prompt.as_deref()),
        ("groupReplyMode", intent.group_reply_mode.as_deref()),
        ("proactiveTarget", intent.proactive_target.as_deref()),
    ] {
        if let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) {
            body[key] = json!(value);
        }
    }
    body["proactiveOpening"] = json!(intent.proactive_opening);
    if let Some(reaction_learning) = &intent.reaction_learning {
        body["reactionLearning"] = reaction_learning.clone();
    }
    body
}

/// Everything a channel config needs that the *bot* cannot supply: the add-channel
/// form, carried across the pairing.
///
/// It has to be carried because the config is written by a POLL, minutes after the
/// form is gone — the bot does not exist when the user presses the button, so there
/// is nothing to write it against yet. A field missing here is a user choice that
/// silently reverts to a default: that is exactly how a managed bot ended up bound
/// to no agent, with the default reply mode, ignoring the Enabled switch.
#[derive(Debug, Clone)]
pub struct ChannelIntent {
    /// Name for the config. Falls back to the created bot's `@handle`.
    pub name: Option<String>,
    /// Existing config to PATCH instead of creating a new one. Also the seam a
    /// later "rotate this bot's token" flow reuses.
    pub channel_id: Option<String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub group_reply_mode: Option<String>,
    /// Send Ryu's first plain-language welcome to the approved target when the
    /// gateway starts. The target is deliberately explicit; it is never inferred
    /// from a token or broadcast to a whole platform.
    pub proactive_opening: bool,
    pub proactive_target: Option<String>,
    /// The form's Enabled switch. Honoured rather than forced on: the manual paste
    /// path respects it, and a disabled row is visible in the sidebar with a toggle,
    /// whereas a silently-flipped one is a setting the user cannot trust. Defaults
    /// to true for a caller that says nothing, since `GET /channels/gateway/enabled`
    /// serves only enabled configs and "create a bot for me" plainly asks for a
    /// running bot.
    pub enabled: bool,
    /// Provider-emoji to Learning feedback mapping, carried until the delayed
    /// control-plane write completes.
    pub reaction_learning: Option<Value>,
}

impl Default for ChannelIntent {
    fn default() -> Self {
        Self {
            name: None,
            channel_id: None,
            agent_id: None,
            team_id: None,
            model: None,
            system_prompt: None,
            group_reply_mode: None,
            proactive_opening: false,
            proactive_target: None,
            enabled: true,
            reaction_learning: None,
        }
    }
}

/// The PATCH body for an EXISTING config: secrets only. `PATCH` merges secrets, so
/// sending just these three rotates the token without disturbing the bot's name,
/// agent binding, behaviour settings, or the user's own `enabled` choice.
pub fn patch_channel_body(bot_token: &str, claim_secret: &str, nonce: &str) -> Value {
    json!({
        "secrets": {
            "bot_token": bot_token,
            "managed_bot_secret": claim_secret,
            "managed_bot_nonce": nonce,
        }
    })
}

/// Classify a 200 claim body. Anything that is not a known status is an error
/// rather than an optimistic "pending", so a manager/protocol mismatch surfaces
/// instead of turning into an infinite poll.
pub(super) fn claim_status_from_body(body: &Value) -> Result<ClaimStatus> {
    match body.get("status").and_then(Value::as_str) {
        Some("pending") => Ok(ClaimStatus::Pending),
        Some("ready") => {
            let bot: ManagedBot = serde_json::from_value(body.clone())
                .context("parsing the ready managed-bot payload")?;
            if bot.token.is_empty() {
                bail!("manager reported ready with an empty token");
            }
            Ok(ClaimStatus::Ready(Box::new(bot)))
        }
        // The manager's own third answer, and one the two sides MUST agree on: it
        // means "handed out already", not "gone", and reporting it as an expiry
        // would strand a bot that really exists (see `ClaimStatus::AlreadyClaimed`).
        Some("claimed") => Ok(ClaimStatus::AlreadyClaimed),
        other => bail!(
            "manager returned an unknown claim status {:?}",
            other.unwrap_or("<missing>")
        ),
    }
}
