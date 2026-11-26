//! Core-issued inference identities: the agent scope and the session Box scope.
// test-exempt: moved verbatim out of lib.rs to keep it under the file size limit; its tests are in lib_test.rs.

use super::*;

/// Core-issued inference identity. The recipient can replay its own scope but
/// cannot choose another agent, user or session without Core's signing secret.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceScope {
    pub agent_id: String,
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    /// Unix timestamp after which the scoped credential must be rejected.
    pub expires_at: u64,
    /// The user's model providers this agent may use (registry ids). `None`
    /// is unrestricted; `Some` (even empty) limits the agent to these plus the
    /// platform-credit and keyless local slots, and a hosted organisation's
    /// fleet-served managed inference. Absent from tokens minted
    /// before the field existed, so their signed bytes are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_access: Option<Vec<String>>,
}

/// Whether `id` is a well-formed provider registry id for an agent's provider
/// access list: short, lowercase ASCII letters, digits, `-`, `_` or `.`. A
/// malformed id is dropped (Core) or rejected (a signed scope), so it can never
/// widen access or smuggle a separator into the CSV header form.
pub fn is_provider_access_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
}

impl InferenceScope {
    fn validate(&self) -> Result<()> {
        for value in [
            Some(self.agent_id.as_str()),
            self.user_id.as_deref(),
            self.session_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty()
                || value.trim() != value
                || value.len() > 256
                || value.chars().any(char::is_control)
            {
                bail!("invalid scoped inference identity");
            }
        }
        if self
            .provider_access
            .as_deref()
            .is_some_and(|ids| ids.len() > 256 || !ids.iter().all(|id| is_provider_access_id(id)))
        {
            bail!("invalid scoped inference provider access");
        }
        if self.expires_at <= unix_now() {
            bail!("scoped inference credential is expired");
        }
        Ok(())
    }

    pub fn sign(&self, core_key: &str) -> Result<String> {
        use hmac::Mac;
        self.validate()?;
        let payload = hex::encode(serde_json::to_vec(self)?);
        let signed = format!("gws1.{payload}");
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(core_key.as_bytes())?;
        mac.update(signed.as_bytes());
        Ok(format!(
            "{signed}.{}",
            hex::encode(mac.finalize().into_bytes())
        ))
    }

    pub fn verify(token: &str, core_key: &str) -> Result<Self> {
        use hmac::Mac;
        if token.len() > 4096 {
            bail!("scoped inference credential is too large");
        }
        let (signed, signature) = token
            .rsplit_once('.')
            .context("invalid scoped inference credential")?;
        let payload = signed
            .strip_prefix("gws1.")
            .context("invalid scoped inference version")?;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(core_key.as_bytes())?;
        mac.update(signed.as_bytes());
        mac.verify_slice(&hex::decode(signature)?)
            .map_err(|_| anyhow::anyhow!("invalid scoped inference signature"))?;
        let scope: Self = serde_json::from_slice(&hex::decode(payload)?)?;
        scope.validate()?;
        Ok(scope)
    }
}

/// Longest lifetime a `gwb1` Box inference key may have, in seconds.
pub const BOX_INFERENCE_MAX_TTL_SECS: u64 = 20 * 60;
const BOX_INFERENCE_PREFIX: &str = "gwb1.";

/// Core-issued inference identity for one session Box (`gwb1`). It is
/// inference-only, bound to an org, a session, a Box and the lease epoch the
/// Box runs under, and lives at most [`BOX_INFERENCE_MAX_TTL_SECS`]. Core
/// signs it with its Core proof key; the Gateway verifies it with the same key
/// (the org-derived key in the hosted fleet, the local trusted-forwarder key on
/// a local Gateway).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxInferenceScope {
    pub org_id: String,
    pub user_id: Option<String>,
    pub session_id: String,
    pub box_id: String,
    /// Bumped on every park and resume; a key for an old epoch dies with its TTL.
    pub lease_epoch: u64,
    /// Unix timestamp after which the key must be rejected.
    pub expires_at: u64,
    /// The org's Box proof-key epoch the signing key was derived at
    /// ([`derive_org_box_proof_key`]); omitted from the payload at 0.
    #[serde(default, skip_serializing_if = "org_box_proof::is_zero")]
    pub key_epoch: u64,
}

impl BoxInferenceScope {
    fn validate_at(&self, now: u64) -> Result<()> {
        for value in [
            Some(self.org_id.as_str()),
            self.user_id.as_deref(),
            Some(self.session_id.as_str()),
            Some(self.box_id.as_str()),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty()
                || value.trim() != value
                || value.len() > 256
                || value.chars().any(char::is_control)
            {
                bail!("invalid Box inference identity");
            }
        }
        if self.expires_at <= now {
            bail!("Box inference credential is expired");
        }
        if self.expires_at > now.saturating_add(BOX_INFERENCE_MAX_TTL_SECS) {
            bail!("Box inference credential lives longer than 20 minutes");
        }
        Ok(())
    }

    pub(crate) fn mac(signed: &str, core_key: &str) -> Result<hmac::Hmac<sha2::Sha256>> {
        use hmac::Mac;
        if core_key.is_empty() {
            bail!("Box inference signing key is empty");
        }
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(core_key.as_bytes())?;
        mac.update(signed.as_bytes());
        Ok(mac)
    }

    /// Sign as `gwb1.<hex payload>.<hex hmac>`.
    pub fn sign(&self, core_key: &str) -> Result<String> {
        self.sign_at(core_key, unix_now())
    }

    /// [`Self::sign`] with an explicit clock.
    pub fn sign_at(&self, core_key: &str, now: u64) -> Result<String> {
        use hmac::Mac;
        self.validate_at(now)?;
        let payload = hex::encode(serde_json::to_vec(self)?);
        let signed = format!("{BOX_INFERENCE_PREFIX}{payload}");
        let mac = Self::mac(&signed, core_key)?;
        Ok(format!(
            "{signed}.{}",
            hex::encode(mac.finalize().into_bytes())
        ))
    }

    /// Verify a `gwb1` key against `core_key`.
    pub fn verify(token: &str, core_key: &str) -> Result<Self> {
        Self::verify_at(token, core_key, unix_now())
    }

    /// [`Self::verify`] with an explicit clock.
    pub fn verify_at(token: &str, core_key: &str, now: u64) -> Result<Self> {
        use hmac::Mac;
        if token.len() > 4096 {
            bail!("Box inference credential is too large");
        }
        let (signed, signature) = token
            .rsplit_once('.')
            .context("invalid Box inference credential")?;
        let payload = signed
            .strip_prefix(BOX_INFERENCE_PREFIX)
            .context("invalid Box inference version")?;
        let mac = Self::mac(signed, core_key)?;
        mac.verify_slice(&hex::decode(signature)?)
            .map_err(|_| anyhow::anyhow!("invalid Box inference signature"))?;
        let scope: Self = serde_json::from_slice(&hex::decode(payload)?)?;
        scope.validate_at(now)?;
        Ok(scope)
    }

    /// Whether `token` has the `gwb1` shape (not whether it verifies).
    pub fn is_box_token(token: &str) -> bool {
        token.starts_with(BOX_INFERENCE_PREFIX)
    }
}
