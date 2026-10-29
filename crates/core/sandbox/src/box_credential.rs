//! Where Core gets the credential it calls the Ryu Box service with
//! (design `docs/box-per-session-desktop.md` §7.8).
//!
//! A self-hosted node configures `RYU_SANDBOX_BOX_URL` / `RYU_SANDBOX_BOX_TOKEN`
//! ([`EnvCredentialSource`]). A managed node has the control plane mint a
//! tenant token instead; the host installs that source with
//! [`install_source`]. The env token always wins when it is set, so an operator
//! override keeps working on managed nodes too.
//!
//! [`ControlPlaneCredentialSource`] is that managed-node source: it asks the
//! control plane for the org's `core:<org>` tenant token
//! (`POST {RYU_CONTROL_PLANE_URL}/api/box/node-credential`, design §8.2),
//! authenticated with the node's durable control-plane key, caches it, and
//! refreshes it at half its lifetime.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};

use anyhow::{bail, Context, Result};
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::box_backend;
use crate::box_types::SecretString;

/// Who meters this credential's Box time. Exactly one owner per tenant, so a
/// Box is never charged twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BillingOwner {
    /// Core's Gateway heartbeat ticks (the `core:<org>` tenant).
    CoreTick,
    /// Hourly settlement of `/v1/usage` (the `org:<org>` tenant).
    Settlement,
    /// An upstream subscription pays; Ryu does not meter.
    Subscription,
    /// No billing (self-hosted).
    None,
}

impl BillingOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CoreTick => "core_tick",
            Self::Settlement => "settlement",
            Self::Subscription => "subscription",
            Self::None => "none",
        }
    }

    /// Parse the wire name; unknown names are refused.
    pub fn from_wire(value: &str) -> Result<Self> {
        match value.trim() {
            "core_tick" => Ok(Self::CoreTick),
            "settlement" => Ok(Self::Settlement),
            "subscription" => Ok(Self::Subscription),
            "none" => Ok(Self::None),
            other => bail!("unknown Box billing owner {other:?}"),
        }
    }
}

/// A resolved Box service credential.
#[derive(Clone, PartialEq, Eq)]
pub struct BoxCredential {
    /// API base URL, including `/v1`.
    pub base: Url,
    /// The tenant bearer. It never leaves Core.
    pub token: SecretString,
    /// The public `wss://` ingress for direct desktop streams. `None` means
    /// desktop streams are relayed through Core.
    pub public_base: Option<Url>,
    pub billing_owner: BillingOwner,
    /// Unix seconds after which the token is no longer valid, when known.
    pub expires_at: Option<u64>,
}

impl BoxCredential {
    /// Whether the credential is past its expiry at `now` (Unix seconds).
    pub fn is_expired_at(&self, now: u64) -> bool {
        self.expires_at.is_some_and(|expires_at| expires_at <= now)
    }
}

impl fmt::Debug for BoxCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoxCredential")
            .field("base", &self.base.as_str())
            .field("token", &self.token)
            .field("public_base", &self.public_base.as_ref().map(Url::as_str))
            .field("billing_owner", &self.billing_owner)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// The future a [`BoxCredentialSource`] returns.
pub type CredentialFuture<'a> = Pin<Box<dyn Future<Output = Result<BoxCredential>> + Send + 'a>>;

/// A provider of the current Box credential. Implementations cache and refresh
/// as they need; [`current`] is called before every Box request.
pub trait BoxCredentialSource: Send + Sync {
    fn current(&self) -> CredentialFuture<'_>;
}

/// `RYU_SANDBOX_BOX_URL` / `RYU_SANDBOX_BOX_TOKEN`, read on every call so a
/// changed configuration applies without a restart.
#[derive(Debug, Clone, Copy, Default)]
pub struct EnvCredentialSource;

impl EnvCredentialSource {
    /// Resolve synchronously from the environment.
    pub fn resolve() -> Result<BoxCredential> {
        let token = box_backend::box_token().with_context(|| {
            format!(
                "the Ryu Box service is not configured: set {}",
                box_backend::ENV_BOX_TOKEN
            )
        })?;
        let raw_base = box_backend::box_base_url();
        let base = Url::parse(&raw_base)
            .with_context(|| format!("{} is not a valid URL", box_backend::ENV_BOX_URL))?;
        if !matches!(base.scheme(), "http" | "https") {
            bail!("{} must be an http(s) URL", box_backend::ENV_BOX_URL);
        }
        let billing_owner = if box_backend::subscription_passthrough() {
            BillingOwner::Subscription
        } else {
            BillingOwner::None
        };
        Ok(BoxCredential {
            base,
            token: SecretString::new(token),
            public_base: None,
            billing_owner,
            expires_at: None,
        })
    }
}

impl BoxCredentialSource for EnvCredentialSource {
    fn current(&self) -> CredentialFuture<'_> {
        Box::pin(async { Self::resolve() })
    }
}

mod control_plane;

pub use control_plane::{
    parse_rfc3339_unix, ControlPlaneCredentialSource, NodeKeyProvider, UnixClock,
    ENV_CONTROL_PLANE_URL, ENV_NODE_KEY, NODE_CREDENTIAL_PATH,
};

type InstalledSource = RwLock<Option<Arc<dyn BoxCredentialSource>>>;

fn installed() -> &'static InstalledSource {
    static SOURCE: OnceLock<InstalledSource> = OnceLock::new();
    SOURCE.get_or_init(|| RwLock::new(None))
}

/// Install the process-wide credential source (the control-plane source on
/// managed nodes). A later call replaces the earlier source.
pub fn install_source(source: Arc<dyn BoxCredentialSource>) {
    let mut slot = installed()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *slot = Some(source);
}

/// Remove the installed source, falling back to the environment.
pub fn clear_source() {
    let mut slot = installed()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *slot = None;
}

fn installed_source() -> Option<Arc<dyn BoxCredentialSource>> {
    installed()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// The credential to call the Box service with now.
///
/// `RYU_SANDBOX_BOX_TOKEN` wins whenever it is set. Otherwise the installed
/// source answers; with none installed, the environment is used (and reports
/// that the Box service is not configured).
pub async fn current() -> Result<BoxCredential> {
    if box_backend::box_token().is_some() {
        return EnvCredentialSource::resolve();
    }
    match installed_source() {
        Some(source) => source.current().await,
        None => EnvCredentialSource::resolve(),
    }
}

#[cfg(test)]
mod tests;
