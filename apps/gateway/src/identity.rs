//! Request identity and the identity the Gateway sends upstream.
//!
//! Every request gets an attributable identity: the resolved credential, a
//! JWT-verified Ryu user, a tenant's own end user named by `x-ryu-end-user`,
//! or a trusted forwarder's user. The raw end-user value is hashed per
//! organization as soon as the organization is known and never stored.
//!
//! On the hosted fleet the Gateway also tells the upstream who the request is
//! for, in the field that provider reads for abuse attribution. That value is
//! always derived by Ryu ([`IdentityKeys::upstream_subject`]); a tenant's own
//! `user`, `safety_identifier` or `metadata.user_id` is removed first, so a
//! tenant can neither impersonate another subject at a provider nor rotate the
//! identity Ryu's provider account is judged by. Self-hosted Gateways and
//! managed nodes forward the body as the caller sent it: they spend their
//! operator's own keys.
//!
//! Formats:
//! - org salt: `HMAC-SHA256(root, "ryu/eu-salt/v1" 0x00 org_id 0x00 be32(epoch))`
//! - end user: `eu1.<epoch>.<hex(HMAC-SHA256(org_salt, raw))[0..32]>`
//! - forwarded user: `fu1.<epoch>.<hex(HMAC-SHA256(org_salt, "fwd" 0x00 raw))[0..32]>`
//! - upstream subject: `ryu.<pv>.<hex(HMAC-SHA256(pepper[pv], "ryu/up/v1" 0x00 kind 0x00 ref))[0..32]>`
//!
//! End users are unlinkable across organizations because the salt is per org.
//! A verified Ryu user is global. Both formats fit OpenAI's 64 character
//! `safety_identifier` limit.

use std::sync::Arc;

use hmac::{Hmac, Mac};
use ryu_gw_contracts::end_user::{parse_end_user, EndUserKey, END_USER_HEADER};
use serde_json::Value;
use sha2::Sha256;

use crate::custody::GatewayCustody;
use crate::pipeline::RequestContext;

type HmacSha256 = Hmac<Sha256>;

/// The org salt root (32 or more bytes, base64). Required on the fleet.
pub const ENV_IDENTITY_ROOT: &str = "RYU_IDENTITY_ROOT";
/// The upstream subject pepper: a base64 secret of 32 or more bytes (version
/// 1), or `{"current":N,"keys":{"N":"<base64>",...}}`. Required on the fleet.
pub const ENV_IDENTITY_PEPPER: &str = "RYU_IDENTITY_PEPPER";
/// Shortest accepted secret, in decoded bytes.
const MIN_SECRET_BYTES: usize = 32;
/// The scope a request without an organization hashes its end user under.
const NODE_SCOPE: &str = "node:local";
/// Private body field that carries the Anthropic subject to the Anthropic
/// adapter, which copies it into `metadata.user_id` and never forwards the
/// field itself. Always removed before an attempt, so a tenant cannot set it.
pub(crate) const UPSTREAM_SUBJECT_FIELD: &str = "ryu_upstream_subject";

// ─── Credential and request identity ─────────────────────────────────────────

/// What the control plane's resolve said about the presenting `rgw_` key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialIdentity {
    pub credential_id: String,
    pub node_id: Option<String>,
    pub team_id: Option<String>,
    /// The member who owns a personal-node credential.
    pub owner_user_id: Option<String>,
    /// The member who minted the credential: a custodian, never an actor.
    pub created_by: Option<String>,
    pub service_account_id: Option<String>,
    /// Whether an org admin declared that this key serves the tenant's own end
    /// users, so `x-ryu-end-user` becomes the upstream subject.
    pub serves_end_users: bool,
    pub purpose: String,
}

/// The kind of subject an identity names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    User,
    ForwardedUser,
    EndUser,
    Credential,
    Org,
    Node,
}

impl SubjectKind {
    /// The one-letter kind mixed into the upstream subject, so two kinds with
    /// the same reference never collide.
    const fn code(self) -> &'static str {
        match self {
            Self::User => "u",
            Self::ForwardedUser => "f",
            Self::EndUser => "e",
            Self::Credential => "k",
            Self::Org => "o",
            Self::Node => "n",
        }
    }
}

/// The subject a request acts as, and therefore the one stamped upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub kind: SubjectKind,
    /// An internal reference: a user, credential or org id, or an already
    /// hashed end-user or forwarded-user id. Never a raw tenant value.
    pub subject_ref: String,
}

/// The identity of one request. Built once at authentication.
///
/// The hashed end user, forwarded user and verified user are recorded even
/// when they are not the actor, so violation events and upstream blocks can
/// check every subject a request names; those readers land with the
/// violation ledger.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RequestIdentity {
    pub credential: Option<Arc<CredentialIdentity>>,
    /// The org's end-user salt epoch from the resolve (`1` when unsent).
    pub salt_epoch: u32,
    /// A JWT-verified Ryu user only.
    pub actor_user_id: Option<String>,
    /// A trusted forwarder's claimed user, hashed per org.
    pub forwarded_user_hash: Option<String>,
    /// The tenant end user from `x-ryu-end-user`, hashed per org.
    pub end_user_hash: Option<String>,
    pub actor: Actor,
    /// `ryu.<pv>.<hex32>` for the actor; `None` when this Gateway holds no
    /// pepper, in which case nothing is stamped upstream.
    pub upstream_subject: Option<String>,
}

impl RequestIdentity {
    /// The credential part only, set by the `rgw_` resolve branch and
    /// completed by [`attach`] once authentication returns.
    pub fn from_credential(credential: Option<Arc<CredentialIdentity>>, salt_epoch: u32) -> Self {
        Self {
            credential,
            salt_epoch,
            actor_user_id: None,
            forwarded_user_hash: None,
            end_user_hash: None,
            actor: Actor {
                kind: SubjectKind::Node,
                subject_ref: String::new(),
            },
            upstream_subject: None,
        }
    }
}

// ─── Keys ────────────────────────────────────────────────────────────────────

/// Why the identity secrets could not be loaded. Messages name the variable,
/// never its value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityKeysError(String);

impl std::fmt::Display for IdentityKeysError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for IdentityKeysError {}

/// The Gateway's identity secrets. `Debug` never prints them.
#[derive(Clone)]
pub struct IdentityKeys {
    root: Vec<u8>,
    /// `(version, key)` of the current pepper, or `None` (nothing stamped).
    pepper: Option<(u32, Vec<u8>)>,
}

impl std::fmt::Debug for IdentityKeys {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IdentityKeys")
            .field(
                "pepper_version",
                &self.pepper.as_ref().map(|(version, _)| version),
            )
            .finish_non_exhaustive()
    }
}

impl IdentityKeys {
    /// A process-local root and no pepper: end users are still hashed for
    /// local attribution, and nothing is stamped upstream.
    pub fn local() -> Self {
        Self {
            root: rand::random::<[u8; 32]>().to_vec(),
            pepper: None,
        }
    }

    /// Load from the process environment for `custody`.
    pub fn from_env(custody: GatewayCustody) -> Result<Self, IdentityKeysError> {
        Self::from_lookup(custody, |name| std::env::var(name).ok())
    }

    /// Load over an injected lookup, so tests never touch the process
    /// environment. The fleet refuses to start without both secrets, because
    /// it would otherwise send Ryu's provider accounts requests with no
    /// attributable identity. Any other custody may run without them; a
    /// malformed value is an error on every custody.
    pub fn from_lookup(
        custody: GatewayCustody,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, IdentityKeysError> {
        let read = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());
        let root = read(ENV_IDENTITY_ROOT)
            .map(|value| decode_secret(ENV_IDENTITY_ROOT, &value))
            .transpose()?;
        let pepper = read(ENV_IDENTITY_PEPPER)
            .map(|value| parse_pepper(&value))
            .transpose()?;
        if custody.is_fleet() {
            if pepper.is_none() {
                return Err(IdentityKeysError(format!(
                    "{ENV_IDENTITY_PEPPER} is required on a hosted fleet Gateway"
                )));
            }
            if root.is_none() {
                return Err(IdentityKeysError(format!(
                    "{ENV_IDENTITY_ROOT} is required on a hosted fleet Gateway"
                )));
            }
        }
        Ok(Self {
            root: root.unwrap_or_else(|| rand::random::<[u8; 32]>().to_vec()),
            pepper,
        })
    }

    /// Fixed keys for tests.
    #[cfg(test)]
    pub fn for_test(root: &[u8], pepper: Option<(u32, &[u8])>) -> Self {
        Self {
            root: root.to_vec(),
            pepper: pepper.map(|(version, key)| (version, key.to_vec())),
        }
    }

    pub fn has_pepper(&self) -> bool {
        self.pepper.is_some()
    }

    fn org_salt(&self, org_id: &str, epoch: u32) -> Vec<u8> {
        let mut mac = mac_for(&self.root);
        mac.update(b"ryu/eu-salt/v1");
        mac.update(&[0]);
        mac.update(org_id.as_bytes());
        mac.update(&[0]);
        mac.update(&epoch.to_be_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    /// `eu1.<epoch>.<hex32>` for a raw tenant end-user id in `org_id`.
    pub fn end_user_hash(&self, org_id: &str, epoch: u32, raw: &str) -> String {
        let mut mac = mac_for(&self.org_salt(org_id, epoch));
        mac.update(raw.as_bytes());
        format!("eu1.{epoch}.{}", hex32(mac))
    }

    /// `fu1.<epoch>.<hex32>` for a trusted forwarder's claimed user in `org_id`.
    pub fn forwarded_user_hash(&self, org_id: &str, epoch: u32, raw: &str) -> String {
        let mut mac = mac_for(&self.org_salt(org_id, epoch));
        mac.update(b"fwd");
        mac.update(&[0]);
        mac.update(raw.as_bytes());
        format!("fu1.{epoch}.{}", hex32(mac))
    }

    /// `ryu.<pv>.<hex32>` for a subject, or `None` without a pepper.
    pub fn upstream_subject(&self, kind: SubjectKind, subject_ref: &str) -> Option<String> {
        let (version, key) = self.pepper.as_ref()?;
        let mut mac = mac_for(key);
        mac.update(b"ryu/up/v1");
        mac.update(&[0]);
        mac.update(kind.code().as_bytes());
        mac.update(&[0]);
        mac.update(subject_ref.as_bytes());
        Some(format!("ryu.{version}.{}", hex32(mac)))
    }

    /// `evh1.<hex64>`: the keyed hash of normalized violation evidence (spec
    /// 00.8), so a short span cannot be reversed by dictionary. Keyed under
    /// the root with its own label, so it never equals an identity hash. On
    /// the fleet every replica holds the same root, so one input hashes alike
    /// on every replica.
    pub fn evidence_hmac(&self, normalized: &str) -> String {
        let mut key = mac_for(&self.root);
        key.update(b"ryu/evidence/v1");
        let mut mac = mac_for(&key.finalize().into_bytes());
        mac.update(normalized.as_bytes());
        format!("evh1.{}", hex::encode(mac.finalize().into_bytes()))
    }
}

fn mac_for(key: &[u8]) -> HmacSha256 {
    // HMAC accepts a key of any length, so this cannot fail.
    HmacSha256::new_from_slice(key).expect("HMAC accepts any key length")
}

fn hex32(mac: HmacSha256) -> String {
    let digest = hex::encode(mac.finalize().into_bytes());
    digest[..32].to_owned()
}

fn decode_secret(name: &str, value: &str) -> Result<Vec<u8>, IdentityKeysError> {
    use base64::Engine as _;
    let value = value.trim();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(value))
        .map_err(|_| IdentityKeysError(format!("{name} must be base64")))?;
    if decoded.len() < MIN_SECRET_BYTES {
        return Err(IdentityKeysError(format!(
            "{name} must decode to at least {MIN_SECRET_BYTES} bytes"
        )));
    }
    Ok(decoded)
}

/// A bare base64 secret is version 1; the versioned form names the current
/// version and holds every version still in use.
fn parse_pepper(value: &str) -> Result<(u32, Vec<u8>), IdentityKeysError> {
    let trimmed = value.trim();
    if !trimmed.starts_with('{') {
        return Ok((1, decode_secret(ENV_IDENTITY_PEPPER, trimmed)?));
    }
    #[derive(serde::Deserialize)]
    struct Versioned {
        current: u32,
        keys: std::collections::HashMap<String, String>,
    }
    let parsed: Versioned = serde_json::from_str(trimmed).map_err(|_| {
        IdentityKeysError(format!(
            "{ENV_IDENTITY_PEPPER} must be base64 or {{\"current\":N,\"keys\":{{...}}}}"
        ))
    })?;
    if parsed.current == 0 {
        return Err(IdentityKeysError(format!(
            "{ENV_IDENTITY_PEPPER} current version must be 1 or greater"
        )));
    }
    for (version, key) in &parsed.keys {
        if version.parse::<u32>().map_or(true, |version| version == 0) {
            return Err(IdentityKeysError(format!(
                "{ENV_IDENTITY_PEPPER} key versions must be positive integers"
            )));
        }
        decode_secret(ENV_IDENTITY_PEPPER, key)?;
    }
    let current = parsed
        .keys
        .get(&parsed.current.to_string())
        .ok_or_else(|| {
            IdentityKeysError(format!(
                "{ENV_IDENTITY_PEPPER} has no key for its current version"
            ))
        })?;
    Ok((parsed.current, decode_secret(ENV_IDENTITY_PEPPER, current)?))
}

// ─── The end-user header ─────────────────────────────────────────────────────

tokio::task_local! {
    /// The request's parsed `x-ryu-end-user`, held only until authentication
    /// hashes it. Never copied onto the request context.
    static END_USER: Option<EndUserKey>;
}

fn current_end_user() -> Option<EndUserKey> {
    END_USER.try_with(Clone::clone).ok().flatten()
}

/// Router middleware: parse `x-ryu-end-user` (contract
/// `ryu_gw_contracts::end_user`) and serve the request inside it. A malformed
/// header is refused with `400 invalid_end_user` before any handler runs.
pub async fn scope_end_user(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, crate::error::GatewayError> {
    let mut values = request.headers().get_all(END_USER_HEADER).iter();
    let first = values.next();
    if values.next().is_some() {
        return Err(invalid_end_user());
    }
    let key = parse_end_user(first.map(axum::http::HeaderValue::as_bytes))
        .map_err(|_| invalid_end_user())?;
    Ok(END_USER.scope(key, next.run(request)).await)
}

fn invalid_end_user() -> crate::error::GatewayError {
    crate::error::GatewayError::InvalidRequest {
        code: "invalid_end_user",
        message: "x-ryu-end-user must be sent once, as 1 to 128 printable ASCII characters with no spaces.",
    }
}

// ─── Building the identity ───────────────────────────────────────────────────

/// Complete `ctx.identity` once authentication has bound the org: hash the
/// end user and any trusted forwarder's user, choose the actor and derive its
/// upstream subject.
///
/// Actor precedence (first match wins):
/// 1. a JWT-verified Ryu user, unless the credential serves end users;
/// 2. the tenant end user, only on a credential that serves end users, so a
///    verified user on an ordinary key cannot rotate its upstream identity
///    per request;
/// 3. a trusted forwarder's user, hashed per org;
/// 4. the resolved credential;
/// 5. the org;
/// 6. the node (the static key's name, or `anonymous`).
pub fn attach(keys: &IdentityKeys, ctx: &mut RequestContext) {
    let (credential, salt_epoch) = ctx.identity.as_deref().map_or((None, 1), |identity| {
        (identity.credential.clone(), identity.salt_epoch)
    });
    // A dynamic `rgw_` context carries a user id only when the forwarded JWT
    // verified; every other path's `user_id` is caller input or a key name.
    let dynamic = ctx.org_limits.is_some();
    let forwarder = ctx
        .key_config
        .as_ref()
        .is_some_and(|key| key.trusted_forwarder)
        || ctx.api_key.starts_with("gws1.");
    let scope = ctx.org_id.clone().unwrap_or_else(|| NODE_SCOPE.to_owned());
    let actor_user_id = if dynamic { ctx.user_id.clone() } else { None };
    let forwarded_user_hash = (!dynamic && forwarder)
        .then(|| ctx.user_id.as_deref())
        .flatten()
        .map(|user| keys.forwarded_user_hash(&scope, salt_epoch, user));
    let end_user_hash =
        current_end_user().map(|key| keys.end_user_hash(&scope, salt_epoch, key.expose()));
    let serves_end_users = credential
        .as_deref()
        .is_some_and(|credential| credential.serves_end_users);

    let actor = match (&actor_user_id, &end_user_hash) {
        (Some(user), _) if !serves_end_users => Actor {
            kind: SubjectKind::User,
            subject_ref: user.clone(),
        },
        (_, Some(hash)) if serves_end_users => Actor {
            kind: SubjectKind::EndUser,
            subject_ref: hash.clone(),
        },
        _ => fallback_actor(ctx, forwarded_user_hash.as_deref(), credential.as_deref()),
    };
    let upstream_subject = keys.upstream_subject(actor.kind, &actor.subject_ref);
    ctx.identity = Some(Arc::new(RequestIdentity {
        credential,
        salt_epoch,
        actor_user_id,
        forwarded_user_hash,
        end_user_hash,
        actor,
        upstream_subject,
    }));
}

fn fallback_actor(
    ctx: &RequestContext,
    forwarded_user_hash: Option<&str>,
    credential: Option<&CredentialIdentity>,
) -> Actor {
    if let Some(hash) = forwarded_user_hash {
        return Actor {
            kind: SubjectKind::ForwardedUser,
            subject_ref: hash.to_owned(),
        };
    }
    if let Some(credential) = credential {
        return Actor {
            kind: SubjectKind::Credential,
            subject_ref: credential.credential_id.clone(),
        };
    }
    if let Some(org_id) = ctx.org_id.as_deref() {
        return Actor {
            kind: SubjectKind::Org,
            subject_ref: org_id.to_owned(),
        };
    }
    Actor {
        kind: SubjectKind::Node,
        subject_ref: ctx
            .user_name
            .clone()
            .unwrap_or_else(|| "anonymous".to_owned()),
    }
}

// ─── Upstream stamping ───────────────────────────────────────────────────────

/// The kind of call an attempt makes, because one provider reads a different
/// identifier per endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamSurface {
    Chat,
    Embedding,
    /// Rerank APIs read no end-user identifier.
    Rerank,
    Image,
    Speech,
    Transcription,
    Video,
}

impl UpstreamSurface {
    pub fn for_modality(modality: &crate::config::Modality) -> Self {
        match modality {
            crate::config::Modality::Chat => Self::Chat,
            crate::config::Modality::Image => Self::Image,
            crate::config::Modality::Tts => Self::Speech,
            crate::config::Modality::Stt => Self::Transcription,
            // Job-based media (video and generated audio) share one upstream
            // surface: the queued-job submission.
            crate::config::Modality::Video | crate::config::Modality::Audio => Self::Video,
        }
    }
}

/// The upstream field a subject is written into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamField {
    /// Anthropic Messages `metadata.user_id`, written by the Anthropic adapter
    /// from [`UPSTREAM_SUBJECT_FIELD`].
    AnthropicMetadataUserId,
    /// OpenAI-style top-level `safety_identifier`.
    SafetyIdentifier,
    /// OpenAI-style top-level `user`.
    User,
}

/// What [`stamp_upstream_identity`] did to one attempt's body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StampOutcome {
    /// Tenant identifiers were removed and Ryu's subject was written here.
    Stamped(UpstreamField),
    /// Tenant identifiers were removed; this provider reads no identifier (or
    /// this Gateway holds no pepper), so the identity stays in Ryu's records.
    LocalOnly,
    /// Not a hosted fleet attempt: the body is forwarded as the caller sent it.
    Skipped,
}

/// Which identifier each provider reads, per surface. A provider missing here
/// gets none: every OpenAI-compatible adapter clones the body verbatim, so an
/// unknown field could make a strict endpoint answer 400.
///
/// | Provider id | Chat | Embeddings | Images | Speech, transcription | Video |
/// |---|---|---|---|---|---|
/// | `anthropic`, `anthropic-credits` | `metadata.user_id` | n/a | n/a | n/a | n/a |
/// | `openai`, `openai-credits` | `safety_identifier` | `user` | `user` | none (the audio APIs take no identifier) | none |
/// | `openrouter` | `user` | `user` | `user` | `user` (the adapter forwards it) | none |
/// | `vercel` | `safety_identifier` (OpenAI-compatible; no adapter in this tree yet) | none | none | none | none |
/// | `fireworks` | `user` (documented on its chat API) | none | none | none | none |
/// | `bedrock` | none: Anthropic on Bedrock, identifier support unconfirmed | | | | |
/// | `vertex`, `cloudflare`, `litellm` | none: unconfirmed | | | | |
/// | `mistral`, `together` | none: their chat APIs document no identifier | | | | |
/// | `voyage`, `jina`, `huggingface`, `nvidia`, `chutes`, `hyperbolic`, `siliconflow`, `venice`, `featherless`, `qwen` | none: unconfirmed | | | | |
/// | Gemini and other SDK slots, Cohere, Kiro, Qoder, MiniMax, local and Core | none | | | | |
/// | Replicate, Fal, BFL, Stability, Recraft, Runway, Topaz, Modal, speech vendors | none | | | | |
pub fn upstream_field(provider: &str, surface: UpstreamSurface) -> Option<UpstreamField> {
    use UpstreamSurface as S;
    match (provider, surface) {
        ("anthropic" | crate::config::ANTHROPIC_CREDITS_PROVIDER_ID, S::Chat) => {
            Some(UpstreamField::AnthropicMetadataUserId)
        }
        ("openai" | crate::config::OPENAI_CREDITS_PROVIDER_ID, S::Chat) => {
            Some(UpstreamField::SafetyIdentifier)
        }
        ("openai" | crate::config::OPENAI_CREDITS_PROVIDER_ID, S::Embedding | S::Image) => {
            Some(UpstreamField::User)
        }
        ("openrouter", S::Chat | S::Embedding | S::Image | S::Speech | S::Transcription) => {
            Some(UpstreamField::User)
        }
        ("vercel", S::Chat) => Some(UpstreamField::SafetyIdentifier),
        ("fireworks", S::Chat) => Some(UpstreamField::User),
        _ => None,
    }
}

/// Write Ryu's upstream identity into one provider attempt's body.
///
/// Runs per attempt, because the body is shared across fallback attempts and
/// each provider reads a different field: it first removes everything a
/// previous attempt or the tenant put in any identity field, then writes only
/// this provider's field. Off the fleet it removes only the private
/// [`UPSTREAM_SUBJECT_FIELD`] and leaves the caller's body unchanged.
///
/// Never touches `messages`, `system`, `tools`, `cache_control` or
/// `prompt_cache_key`, and is constant per subject, so prompt-cache
/// breakpoints and hit rates are unaffected.
pub fn stamp_upstream_identity(
    body: &mut Value,
    provider: &str,
    surface: UpstreamSurface,
    custody: GatewayCustody,
    identity: Option<&RequestIdentity>,
) -> StampOutcome {
    let Some(object) = body.as_object_mut() else {
        return StampOutcome::Skipped;
    };
    object.remove(UPSTREAM_SUBJECT_FIELD);
    if !custody.is_fleet() {
        return StampOutcome::Skipped;
    }
    object.remove("user");
    object.remove("safety_identifier");
    let metadata_empty = match object.get_mut("metadata") {
        Some(Value::Object(metadata)) => {
            metadata.remove("user_id");
            metadata.is_empty()
        }
        _ => false,
    };
    if metadata_empty {
        object.remove("metadata");
    }
    let (Some(field), Some(subject)) = (
        upstream_field(provider, surface),
        identity.and_then(|identity| identity.upstream_subject.as_deref()),
    ) else {
        return StampOutcome::LocalOnly;
    };
    let key = match field {
        UpstreamField::AnthropicMetadataUserId => UPSTREAM_SUBJECT_FIELD,
        UpstreamField::SafetyIdentifier => "safety_identifier",
        UpstreamField::User => "user",
    };
    object.insert(key.to_owned(), Value::String(subject.to_owned()));
    StampOutcome::Stamped(field)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    const ROOT: &[u8] = &[7; 32];
    const PEPPER: &[u8] = &[9; 32];

    fn keys() -> IdentityKeys {
        IdentityKeys::for_test(ROOT, Some((1, PEPPER)))
    }

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn load(
        custody: GatewayCustody,
        vars: &[(&str, String)],
    ) -> Result<IdentityKeys, IdentityKeysError> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(name, value)| ((*name).to_owned(), value.clone()))
            .collect();
        IdentityKeys::from_lookup(custody, |name| vars.get(name).cloned())
    }

    fn is_hex32(text: &str) -> bool {
        text.len() == 32 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    #[test]
    fn fleet_refuses_to_start_without_the_pepper_or_root() {
        let error = load(GatewayCustody::Fleet, &[(ENV_IDENTITY_ROOT, b64(ROOT))]).unwrap_err();
        assert!(error.to_string().contains(ENV_IDENTITY_PEPPER), "{error}");
        let error = load(GatewayCustody::Fleet, &[(ENV_IDENTITY_PEPPER, b64(PEPPER))]).unwrap_err();
        assert!(error.to_string().contains(ENV_IDENTITY_ROOT), "{error}");
        assert!(load(
            GatewayCustody::Fleet,
            &[(ENV_IDENTITY_PEPPER, "  ".to_owned())]
        )
        .is_err());
        let loaded = load(
            GatewayCustody::Fleet,
            &[
                (ENV_IDENTITY_ROOT, b64(ROOT)),
                (ENV_IDENTITY_PEPPER, b64(PEPPER)),
            ],
        )
        .unwrap();
        assert!(loaded.has_pepper());
    }

    #[test]
    fn other_custodies_start_without_secrets_and_stamp_nothing() {
        for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
            let loaded = load(custody, &[]).unwrap();
            assert!(!loaded.has_pepper());
            assert_eq!(loaded.upstream_subject(SubjectKind::Org, "org_a"), None);
            assert!(loaded.end_user_hash("org_a", 1, "u").starts_with("eu1.1."));
        }
    }

    #[test]
    fn malformed_secrets_refuse_on_every_custody() {
        for custody in [
            GatewayCustody::Fleet,
            GatewayCustody::SelfHosted,
            GatewayCustody::ManagedNode,
        ] {
            for (name, value) in [
                (ENV_IDENTITY_ROOT, "not base64 !".to_owned()),
                (ENV_IDENTITY_ROOT, b64(&[1; 16])),
                (ENV_IDENTITY_PEPPER, b64(&[1; 8])),
                (
                    ENV_IDENTITY_PEPPER,
                    "{\"current\":2,\"keys\":{}}".to_owned(),
                ),
                (
                    ENV_IDENTITY_PEPPER,
                    "{\"current\":0,\"keys\":{}}".to_owned(),
                ),
                (ENV_IDENTITY_PEPPER, "{broken".to_owned()),
            ] {
                let mut vars = vec![
                    (ENV_IDENTITY_ROOT, b64(ROOT)),
                    (ENV_IDENTITY_PEPPER, b64(PEPPER)),
                ];
                vars.retain(|(existing, _)| *existing != name);
                vars.push((name, value.clone()));
                assert!(load(custody, &vars).is_err(), "{custody:?} {name}={value}");
            }
        }
    }

    #[test]
    fn versioned_pepper_uses_its_current_key() {
        let versioned = format!(
            "{{\"current\":2,\"keys\":{{\"1\":\"{}\",\"2\":\"{}\"}}}}",
            b64(&[1; 32]),
            b64(PEPPER)
        );
        let loaded = load(
            GatewayCustody::Fleet,
            &[
                (ENV_IDENTITY_ROOT, b64(ROOT)),
                (ENV_IDENTITY_PEPPER, versioned),
            ],
        )
        .unwrap();
        let subject = loaded
            .upstream_subject(SubjectKind::Credential, "cred_a")
            .unwrap();
        let same_key_v2 = IdentityKeys::for_test(ROOT, Some((2, PEPPER)))
            .upstream_subject(SubjectKind::Credential, "cred_a")
            .unwrap();
        assert_eq!(subject, same_key_v2);
        assert!(subject.starts_with("ryu.2."));
    }

    #[test]
    fn hash_formats_match_the_contract() {
        let keys = keys();
        let end_user = keys.end_user_hash("org_a", 3, "tenant-user-42");
        let (prefix, digest) = end_user.split_at("eu1.3.".len());
        assert_eq!(prefix, "eu1.3.");
        assert!(is_hex32(digest), "{end_user}");
        let subject = keys
            .upstream_subject(SubjectKind::EndUser, &end_user)
            .unwrap();
        let (prefix, digest) = subject.split_at("ryu.1.".len());
        assert_eq!(prefix, "ryu.1.");
        assert!(is_hex32(digest), "{subject}");
        assert!(subject.len() <= 64, "fits OpenAI's safety_identifier limit");
        assert!(!end_user.contains("tenant-user-42"));
    }

    #[test]
    fn the_same_end_user_in_two_orgs_is_unlinkable() {
        let keys = keys();
        let in_a = keys.end_user_hash("org_a", 1, "tenant-user-42");
        let in_b = keys.end_user_hash("org_b", 1, "tenant-user-42");
        assert_ne!(in_a, in_b);
        assert_ne!(
            keys.upstream_subject(SubjectKind::EndUser, &in_a),
            keys.upstream_subject(SubjectKind::EndUser, &in_b)
        );
        // Stable within an org and epoch, different after a salt rotation.
        assert_eq!(in_a, keys.end_user_hash("org_a", 1, "tenant-user-42"));
        assert_ne!(in_a, keys.end_user_hash("org_a", 2, "tenant-user-42"));
        // Rotating the pepper does not change end-user hashes.
        let other_pepper = IdentityKeys::for_test(ROOT, Some((2, &[3; 32])));
        assert_eq!(
            in_a,
            other_pepper.end_user_hash("org_a", 1, "tenant-user-42")
        );
    }

    #[test]
    fn subject_kinds_never_collide() {
        let keys = keys();
        assert_ne!(
            keys.upstream_subject(SubjectKind::User, "same"),
            keys.upstream_subject(SubjectKind::Credential, "same")
        );
    }

    #[test]
    fn debug_never_prints_secrets() {
        let printed = format!("{:?}", keys());
        assert!(!printed.contains("9, 9"), "{printed}");
        assert!(printed.contains("pepper_version"));
    }

    fn identity_with_subject(subject: Option<&str>) -> RequestIdentity {
        let mut identity = RequestIdentity::from_credential(None, 1);
        identity.upstream_subject = subject.map(str::to_owned);
        identity
    }

    fn tenant_body() -> Value {
        json!({
            "model": "m",
            "messages": [{ "role": "user", "content": "hi", "cache_control": { "type": "ephemeral" } }],
            "user": "RYU_TEST_LEXICON-user",
            "safety_identifier": "RYU_TEST_LEXICON-safety",
            "metadata": { "user_id": "RYU_TEST_LEXICON-meta" },
            UPSTREAM_SUBJECT_FIELD: "RYU_TEST_LEXICON-private"
        })
    }

    #[test]
    fn fleet_stamps_each_provider_in_its_own_field() {
        let identity = identity_with_subject(Some("ryu.1.0123456789abcdef0123456789abcdef"));
        let cases = [
            ("anthropic", UpstreamSurface::Chat, UPSTREAM_SUBJECT_FIELD),
            (
                "anthropic-credits",
                UpstreamSurface::Chat,
                UPSTREAM_SUBJECT_FIELD,
            ),
            ("openai", UpstreamSurface::Chat, "safety_identifier"),
            ("openai-credits", UpstreamSurface::Chat, "safety_identifier"),
            ("openai", UpstreamSurface::Embedding, "user"),
            ("openai", UpstreamSurface::Image, "user"),
            ("openrouter", UpstreamSurface::Chat, "user"),
            ("openrouter", UpstreamSurface::Embedding, "user"),
            ("vercel", UpstreamSurface::Chat, "safety_identifier"),
            ("fireworks", UpstreamSurface::Chat, "user"),
        ];
        for (provider, surface, field) in cases {
            let mut body = tenant_body();
            let messages = body["messages"].clone();
            let outcome = stamp_upstream_identity(
                &mut body,
                provider,
                surface,
                GatewayCustody::Fleet,
                Some(&identity),
            );
            assert!(matches!(outcome, StampOutcome::Stamped(_)), "{provider}");
            assert_eq!(
                body[field],
                json!("ryu.1.0123456789abcdef0123456789abcdef"),
                "{provider} {surface:?}"
            );
            assert!(
                !body.to_string().contains("RYU_TEST_LEXICON"),
                "{provider}: {body}"
            );
            assert!(body.get("metadata").is_none());
            assert_eq!(body["messages"], messages, "messages untouched");
            // Only the one field is written.
            let identity_fields = ["user", "safety_identifier", UPSTREAM_SUBJECT_FIELD]
                .iter()
                .filter(|key| body.get(**key).is_some())
                .count();
            assert_eq!(identity_fields, 1, "{provider}: {body}");
        }
    }

    #[test]
    fn fleet_strips_tenant_identifiers_for_providers_without_a_field() {
        let identity = identity_with_subject(Some("ryu.1.0123456789abcdef0123456789abcdef"));
        for (provider, surface) in [
            ("bedrock", UpstreamSurface::Chat),
            ("mistral", UpstreamSurface::Chat),
            ("openai", UpstreamSurface::Speech),
            ("replicate", UpstreamSurface::Image),
            ("genai", UpstreamSurface::Chat),
        ] {
            let mut body = tenant_body();
            let outcome = stamp_upstream_identity(
                &mut body,
                provider,
                surface,
                GatewayCustody::Fleet,
                Some(&identity),
            );
            assert_eq!(outcome, StampOutcome::LocalOnly, "{provider}");
            assert!(!body.to_string().contains("RYU_TEST_LEXICON"), "{body}");
            assert!(!body.to_string().contains("ryu.1."), "{body}");
        }
        // No pepper: still stripped, nothing stamped.
        let mut body = tenant_body();
        let outcome = stamp_upstream_identity(
            &mut body,
            "openai",
            UpstreamSurface::Chat,
            GatewayCustody::Fleet,
            Some(&identity_with_subject(None)),
        );
        assert_eq!(outcome, StampOutcome::LocalOnly);
        assert!(!body.to_string().contains("RYU_TEST_LEXICON"));
    }

    #[test]
    fn fleet_keeps_other_metadata_keys() {
        let mut body = json!({ "metadata": { "user_id": "RYU_TEST_LEXICON", "trace": "t1" } });
        stamp_upstream_identity(
            &mut body,
            "openai",
            UpstreamSurface::Chat,
            GatewayCustody::Fleet,
            None,
        );
        assert_eq!(body["metadata"], json!({ "trace": "t1" }));
    }

    #[test]
    fn a_fallback_attempt_replaces_the_previous_providers_field() {
        let identity = identity_with_subject(Some("ryu.1.0123456789abcdef0123456789abcdef"));
        let mut body = tenant_body();
        stamp_upstream_identity(
            &mut body,
            "anthropic",
            UpstreamSurface::Chat,
            GatewayCustody::Fleet,
            Some(&identity),
        );
        assert!(body.get(UPSTREAM_SUBJECT_FIELD).is_some());
        stamp_upstream_identity(
            &mut body,
            "openai",
            UpstreamSurface::Chat,
            GatewayCustody::Fleet,
            Some(&identity),
        );
        assert!(body.get(UPSTREAM_SUBJECT_FIELD).is_none());
        assert!(body.get("user").is_none());
        assert_eq!(
            body["safety_identifier"],
            json!("ryu.1.0123456789abcdef0123456789abcdef")
        );
    }

    #[test]
    fn off_fleet_the_body_is_forwarded_as_sent() {
        let identity = identity_with_subject(Some("ryu.1.0123456789abcdef0123456789abcdef"));
        for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
            let mut body = tenant_body();
            let outcome = stamp_upstream_identity(
                &mut body,
                "openai",
                UpstreamSurface::Chat,
                custody,
                Some(&identity),
            );
            assert_eq!(outcome, StampOutcome::Skipped);
            let mut expected = tenant_body();
            expected
                .as_object_mut()
                .unwrap()
                .remove(UPSTREAM_SUBJECT_FIELD);
            assert_eq!(body, expected, "{custody:?}");
        }
    }
}
