//! The typed client for the hosted manager service.

use super::*;

// ── The account a pairing is made for ────────────────────────────────────────

/// Shown as is by the desktop when a signed-out node tries to pair.
pub const ACCOUNT_REQUIRED: &str = "Sign in to your Ryu account on this device first. \
     A managed bot is created for a signed-in account, so nothing was sent.";
/// The manager answered 401: it did not accept the bearer this node sent.
pub const ACCOUNT_REFUSED: &str = "The managed-bot service did not accept this device's \
     Ryu account sign-in. Sign in again, then retry.";
/// The manager base is plain http on another machine.
pub const INSECURE_MANAGER: &str = "The managed-bot service address is not https, so this \
     device did not send it your Ryu account sign-in. Nothing was sent.";

/// Whether the account bearer may be sent to `base`: https, or plain http to a
/// manager on this machine (a developer's local one).
pub(super) fn may_carry_account(base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

// ── Manager client ───────────────────────────────────────────────────────────

/// Typed client for the manager's managed-bot surface.
#[derive(Clone)]
pub struct ManagerClient {
    base: String,
    http: reqwest::Client,
}

impl ManagerClient {
    /// Build a client from the environment ([`MANAGER_URL_ENV`] → hosted default).
    pub fn from_env() -> Self {
        Self::with_base(manager_base())
    }

    pub fn with_base(base: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .expect("building reqwest client");
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Step 1: mint a pairing. The response carries the claim_secret, so nothing
    /// about this response may be logged or echoed.
    ///
    /// The manager pairs only for a signed-in Ryu account and tells the Telegram
    /// user which one, so this sends the account bearer this node holds (the one
    /// [`land_token`] writes the channel config with). A signed-out node gets
    /// [`ACCOUNT_REQUIRED`] and no request is made.
    pub async fn pair(&self, req: &PairRequest) -> Result<PairSession> {
        self.pair_as(req, crate::auth::load_token()).await
    }

    /// [`Self::pair`] with the account bearer handed in, so a test decides it.
    pub(super) async fn pair_as(
        &self,
        req: &PairRequest,
        account_token: Option<String>,
    ) -> Result<PairSession> {
        let Some(account_token) = account_token.filter(|token| !token.trim().is_empty()) else {
            bail!(ACCOUNT_REQUIRED);
        };
        // The bearer is a full account credential. It goes to the manager only
        // over https, or to a manager a developer runs on this machine.
        if !may_carry_account(&self.base) {
            bail!(INSECURE_MANAGER);
        }
        let resp = self
            .http
            .post(pair_url(&self.base))
            .bearer_auth(account_token.trim())
            .json(req)
            .send()
            .await
            .context("POST /managed-bot/pair on the managed-bot manager")?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            bail!(ACCOUNT_REFUSED);
        }
        if status == reqwest::StatusCode::NOT_IMPLEMENTED
            || status == reqwest::StatusCode::NOT_FOUND
        {
            // The manager answers 501 when Bot Management Mode is off, and 404 when
            // the managed-bot routes are not mounted at all. Both mean "no amount of
            // retrying helps", which is a different answer to the UI than "the
            // manager is having a bad minute" — hence a typed error, not a message.
            return Err(anyhow::Error::new(ManagerUnavailable {
                status: status.as_u16(),
            }));
        }
        if !status.is_success() {
            // Status only. A pair response body contains the claim_secret, and a
            // manager that errors with a partial body would leak it into the log.
            bail!("managed-bot manager POST /managed-bot/pair returned {status}");
        }
        let session: PairSession = resp
            .json()
            .await
            .context("decoding the managed-bot pair response")?;
        validate_nonce(&session.nonce).context("manager returned a malformed nonce")?;
        if session.claim_secret.is_empty() {
            bail!("manager returned an empty claim_secret");
        }
        Ok(session)
    }

    /// Step 6: poll for the token. 404 means unknown/expired and is a normal,
    /// terminal answer — not an error.
    pub async fn claim(&self, nonce: &str, claim_secret: &Secret) -> Result<ClaimStatus> {
        validate_nonce(nonce)?;
        let resp = self
            .http
            .get(claim_url(&self.base, nonce))
            .bearer_auth(claim_secret.expose())
            .send()
            .await
            .context("GET /managed-bot/claim/:nonce on the managed-bot manager")?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(ClaimStatus::Gone);
        }
        // Mid-flow the manager can go dark too (a redeploy with the BotFather switch
        // flipped back off), and the desktop needs the same fall-back-to-manual
        // answer here as it gets on `pair`.
        if status == reqwest::StatusCode::NOT_IMPLEMENTED {
            return Err(anyhow::Error::new(ManagerUnavailable {
                status: status.as_u16(),
            }));
        }
        if !status.is_success() {
            bail!("managed-bot manager claim returned {status}");
        }
        let body: Value = resp.json().await.context("decoding the claim response")?;
        claim_status_from_body(&body)
    }

    /// Step 8 (read): the CURRENT token, re-read from Telegram by the manager.
    ///
    /// This is also the retry lane after a claim succeeded but the local write
    /// failed: the one-shot `claim` will not hand the token over twice, but the
    /// managed-bot record survives, so `refresh` can.
    pub async fn refresh(&self, nonce: &str, claim_secret: &Secret) -> Result<ManagedBot> {
        self.action("refresh", nonce, claim_secret).await
    }

    /// Step 8 (rotate): `replaceManagedBotToken`. Destructive — the old token is
    /// revoked, so the caller MUST land the returned one.
    pub async fn rotate(&self, nonce: &str, claim_secret: &Secret) -> Result<ManagedBot> {
        self.action("rotate", nonce, claim_secret).await
    }

    /// Ryu's delete-my-bot obligation: Telegram gives users no native revocation
    /// UI, so forgetting the managed-bot record has to be reachable from here (and
    /// from `/deletebot` in the manager chat).
    pub async fn delete(&self, nonce: &str, claim_secret: &Secret) -> Result<()> {
        validate_nonce(nonce)?;
        let resp = self
            .http
            .post(action_url(&self.base, "delete"))
            .bearer_auth(claim_secret.expose())
            .json(&action_body(nonce))
            .send()
            .await
            .context("POST /managed-bot/delete on the managed-bot manager")?;
        let status = resp.status();
        // A record that is already gone is the outcome the caller wanted.
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        bail!("managed-bot manager delete returned {status}");
    }

    async fn action(&self, action: &str, nonce: &str, claim_secret: &Secret) -> Result<ManagedBot> {
        validate_nonce(nonce)?;
        let resp = self
            .http
            .post(action_url(&self.base, action))
            .bearer_auth(claim_secret.expose())
            .json(&action_body(nonce))
            .send()
            .await
            .with_context(|| format!("POST /managed-bot/{action} on the managed-bot manager"))?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_IMPLEMENTED {
            return Err(anyhow::Error::new(ManagerUnavailable {
                status: status.as_u16(),
            }));
        }
        if !status.is_success() {
            bail!("managed-bot manager {action} returned {status}");
        }
        let body: Value = resp
            .json()
            .await
            .with_context(|| format!("decoding the {action} response"))?;
        match claim_status_from_body(&body)? {
            ClaimStatus::Ready(bot) => Ok(*bot),
            ClaimStatus::Pending => bail!("managed-bot manager {action} answered pending"),
            // `refresh`/`rotate` read the token from Telegram rather than handing out
            // the stored one-shot copy, so neither can honestly answer "claimed".
            ClaimStatus::AlreadyClaimed | ClaimStatus::Gone => {
                bail!("managed-bot manager {action} reports no such managed bot")
            }
        }
    }
}

#[cfg(test)]
mod account_tests;
