//! Writing a claimed token into the channel config the gateway reads.

use super::*;

// ── Landing the token where a hand-pasted one lands ──────────────────────────

/// Write a managed token into the channel config the gateway already reads.
///
/// Creates when `channel_id` is `None`, otherwise PATCHes — the control plane's own
/// `POST /api/channels` / `PATCH /api/channels/:id`, with the signed-in device
/// account's bearer, so there is exactly ONE channel-config writer and one place
/// that seals the secrets. Returns the config id.
///
/// Unlike the manager calls, a non-2xx control-plane body IS included in the error:
/// that response is a masked config or a validation message and never carries a
/// secret, and its text ("missing required secrets for telegram: …") is the only
/// way to debug a rejected write.
///
/// The control plane is the account backend (`RYU_SERVER_URL`, then the stored
/// sign-in backend, https only). With no usable backend this returns an error
/// and sends nothing.
pub async fn land_token(
    bot: &ManagedBot,
    nonce: &str,
    claim_secret: &Secret,
    intent: &ChannelIntent,
) -> Result<String> {
    let http = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .context("building reqwest client")?;
    land_token_with(
        &http,
        crate::auth::load_token(),
        control_plane_base(),
        bot,
        nonce,
        claim_secret,
        intent,
    )
    .await
}

/// [`land_token`] with its inputs passed in: the HTTP client, the stored
/// account token and the resolved control-plane base. Both are checked before
/// any request is made.
pub(super) async fn land_token_with(
    http: &reqwest::Client,
    token: Option<String>,
    base: Result<String, BackendError>,
    bot: &ManagedBot,
    nonce: &str,
    claim_secret: &Secret,
    intent: &ChannelIntent,
) -> Result<String> {
    let token = token
        .ok_or_else(|| anyhow!("no signed-in account — complete device login before pairing"))?;
    let base = base.map_err(|e| anyhow!("cannot save the bot to your account: {e}"))?;

    let (url, body, method_patch) = match intent.channel_id.as_deref() {
        Some(id) => (
            format!("{base}/api/channels/{id}"),
            patch_channel_body(bot.token.expose(), claim_secret.expose(), nonce),
            true,
        ),
        None => (
            format!("{base}/api/channels"),
            create_channel_body(
                &channel_name(intent.name.as_deref(), &bot.bot_username, bot.bot_id),
                bot.token.expose(),
                claim_secret.expose(),
                nonce,
                intent,
            ),
            false,
        ),
    };

    let req = if method_patch {
        http.patch(&url)
    } else {
        http.post(&url)
    };
    let resp = req
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("writing the managed bot token to the channel config")?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        bail!("control plane channel write returned {status}: {detail}");
    }
    let saved: Value = resp
        .json()
        .await
        .context("decoding the saved channel config")?;
    let id = saved
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("control plane channel write returned no id"))?;
    Ok(id.to_string())
}

/// Name for a newly-created config. The control plane requires a non-empty name,
/// and the name is not known when the pairing starts (the bot does not exist yet),
/// so the bot's own username is the fallback — with the numeric id as a last resort
/// for a manager that omitted the username.
pub fn channel_name(requested: Option<&str>, bot_username: &str, bot_id: i64) -> String {
    if let Some(name) = requested.map(str::trim).filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    let handle = bot_username.trim();
    if handle.is_empty() {
        format!("Telegram bot {bot_id}")
    } else {
        format!("@{}", handle.trim_start_matches('@'))
    }
}
