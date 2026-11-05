//! Two-phase completion of hosted OAuth callbacks.
//!
//! The hosted callback is one public URL, and the OAuth `state` inside a
//! forwardable authorization URL is the only thing that ties a browser's
//! response to a flow. A hosted callback therefore never stores tokens on its
//! own: it exchanges the code, holds the bundle in memory and shows the
//! completing browser a one-time confirmation code. Only the owner who started
//! the flow, through an authenticated request carrying that code, commits the
//! connection. Whoever approved at the provider decides whether to hand the
//! code over, so a forwarded link cannot silently bind one person's provider
//! account to another person's Ryu account.

use super::*;

/// How long the owner has to enter the code once the browser shows it.
pub(super) const CONFIRMATION_TTL_SECS: i64 = 5 * 60;
const MAX_CONFIRMATION_ATTEMPTS: u8 = 5;
/// 32 symbols without the look-alikes I, O, 0 and 1.
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;

/// The sealed-to-be token bundle and its metadata, ready to upsert.
#[derive(Clone)]
pub(super) struct ConnectionMaterial {
    pub(super) plaintext: String,
    pub(super) scopes: Vec<String>,
    pub(super) expires_at: Option<i64>,
}

#[derive(Clone)]
pub(super) struct HeldConnection {
    code_digest: [u8; 32],
    attempts: u8,
    material: ConnectionMaterial,
}

/// A fresh code, grouped `XXXX-XXXX` for reading aloud or typing.
fn new_confirmation_code() -> String {
    let mut bytes = [0_u8; CODE_LEN];
    rand::thread_rng().fill_bytes(&mut bytes);
    let symbols: String = bytes
        .iter()
        .map(|byte| char::from(CODE_ALPHABET[usize::from(byte & 31)]))
        .collect();
    format!("{}-{}", &symbols[..4], &symbols[4..])
}

/// Case, spaces and separators do not matter when the code is typed back.
pub(super) fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn code_digest(code: &str) -> [u8; 32] {
    Sha256::digest(normalize_code(code).as_bytes()).into()
}

fn digests_match(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn check_can_connect(flow: &PendingFlow, binding: &BindingKey, expected: FlowState) -> Result<()> {
    if BindingKey::from_flow(flow) != *binding
        || flow.view.status != expected
        || !flow.callback_claimed
    {
        bail!(NO_LONGER_PENDING_MESSAGE);
    }
    if chrono::Utc::now().timestamp() >= flow.view.expires_at {
        bail!(EXPIRED_MESSAGE);
    }
    Ok(())
}

impl McpOAuthManager {
    #[cfg(test)]
    pub(super) async fn ensure_flow_can_connect(
        &self,
        flow_id: &str,
        binding: &BindingKey,
    ) -> Result<()> {
        let flows = self.flows.read().await;
        let flow = flows.get(flow_id).context(CANCELLED_MESSAGE)?;
        check_can_connect(flow, binding, FlowState::Pending)
    }

    /// Park a hosted flow's tokens until its owner confirms, and return the
    /// code the callback page shows. Nothing reaches the vault here.
    pub(super) async fn hold_for_confirmation(
        self: &Arc<Self>,
        flow_id: &str,
        binding: &BindingKey,
        material: ConnectionMaterial,
    ) -> Result<String> {
        let code = new_confirmation_code();
        let expires_at = {
            let mut flows = self.flows.write().await;
            let flow = flows.get_mut(flow_id).context(CANCELLED_MESSAGE)?;
            check_can_connect(flow, binding, FlowState::Pending)?;
            flow.held = Some(HeldConnection {
                code_digest: code_digest(&code),
                attempts: 0,
                material,
            });
            flow.view.status = FlowState::AwaitingConfirmation;
            flow.view.error = None;
            flow.view.error_code = None;
            flow.view.expires_at = chrono::Utc::now().timestamp() + CONFIRMATION_TTL_SECS;
            scrub_flow_secrets(flow);
            flow.view.expires_at
        };
        let manager = self.clone();
        let expiry_flow_id = flow_id.to_owned();
        let wait = (expires_at - chrono::Utc::now().timestamp()).max(0) as u64;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(wait)).await;
            manager.expire_flow(&expiry_flow_id).await;
        });
        Ok(code)
    }

    /// Commit a hosted flow's held tokens for the owner who started it. The
    /// code must be the one the callback page showed; repeated wrong codes
    /// fail the flow and discard the tokens.
    pub async fn confirm_hosted_flow(
        &self,
        owner_user_id: &str,
        flow_id: &str,
        code: &str,
    ) -> Result<()> {
        let binding = {
            let mut flows = self.flows.write().await;
            let flow = flows
                .get_mut(flow_id)
                .filter(|flow| flow.owner_user_id == owner_user_id)
                .context("OAuth flow not found")?;
            if flow.view.status != FlowState::AwaitingConfirmation {
                bail!(NOT_AWAITING_MESSAGE);
            }
            if chrono::Utc::now().timestamp() >= flow.view.expires_at {
                bail!(EXPIRED_MESSAGE);
            }
            let held = flow.held.as_mut().context(NOT_AWAITING_MESSAGE)?;
            if !digests_match(&held.code_digest, &code_digest(code)) {
                held.attempts += 1;
                if held.attempts >= MAX_CONFIRMATION_ATTEMPTS {
                    flow.held = None;
                    flow.view.status = FlowState::Failed;
                    flow.view.error = Some(TOO_MANY_ATTEMPTS_MESSAGE.to_owned());
                    flow.view.error_code = Some(FlowErrorCode::TooManyAttempts);
                    bail!(TOO_MANY_ATTEMPTS_MESSAGE);
                }
                bail!(CODE_MISMATCH_MESSAGE);
            }
            BindingKey::from_flow(flow)
        };
        let committed = self
            .commit_connection(flow_id, &binding, FlowState::AwaitingConfirmation, None)
            .await;
        if let Err(error) = &committed {
            self.mark_flow_failed(flow_id, &error.to_string()).await;
        }
        committed
    }

    /// Seal `material` (or, when `None`, the flow's held tokens) under the
    /// flow's owner binding and mark the flow connected.
    pub(super) async fn commit_connection(
        &self,
        flow_id: &str,
        binding: &BindingKey,
        expected: FlowState,
        material: Option<ConnectionMaterial>,
    ) -> Result<()> {
        let plugin_lock = self.plugin_lock(&binding.plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let (pending, material) = {
            let mut flows = self.flows.write().await;
            let flow = flows.get_mut(flow_id).context(CANCELLED_MESSAGE)?;
            check_can_connect(flow, binding, expected)?;
            let material = match material {
                Some(material) => material,
                None => flow.held.take().context(NOT_AWAITING_MESSAGE)?.material,
            };
            (flow.clone(), material)
        };
        let store = &self.store;
        store
            .upsert_mcp_oauth_connection(
                &pending.owner_user_id,
                &pending.view.profile_id,
                &pending.view.plugin_id,
                &pending.view.server_name,
                &pending.resource,
                &pending.issuer,
                None,
                &material.scopes,
                material.expires_at,
                &SecretState::new(material.plaintext),
            )
            .await?;
        store
            .set_connection_access_level(
                &pending.owner_user_id,
                "mcp",
                &connection_key(
                    &pending.view.profile_id,
                    &pending.view.plugin_id,
                    &pending.view.server_name,
                ),
                crate::ConnectionAccessLevel::from_str(&pending.view.access_level),
            )
            .await?;
        let mut flows = self.flows.write().await;
        let flow = flows.get_mut(flow_id).context(CANCELLED_MESSAGE)?;
        flow.view.status = FlowState::Connected;
        flow.view.error = None;
        flow.view.error_code = None;
        flow.held = None;
        scrub_flow_secrets(flow);
        Ok(())
    }
}

/// Best-effort provider revocation for tokens that were never confirmed.
pub(super) async fn revoke_unconfirmed(held: HeldConnection) {
    let Ok(bundle) = serde_json::from_str::<TokenBundle>(&held.material.plaintext) else {
        return;
    };
    let Some(endpoint) = &bundle.revocation_endpoint else {
        return;
    };
    let token = bundle
        .refresh_token
        .clone()
        .unwrap_or_else(|| bundle.access_token.clone());
    let mut form = vec![("token", token), ("client_id", bundle.client_id.clone())];
    if let Some(secret) = &bundle.client_secret {
        form.push(("client_secret", secret.clone()));
    }
    let _ = post_form_empty(endpoint, &form).await;
}
