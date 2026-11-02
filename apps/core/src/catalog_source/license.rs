//! Enable-time and background license re-checks for paid Ryu Marketplace items
//! (monetization spec §3 "Enforcement").
//!
//! Install already refuses a paid item the caller is not entitled to
//! (`require_install_entitlement`). A refund or chargeback happens *after*
//! install, so Core asks the control plane again whenever a Marketplace install
//! is enabled: `GET /api/marketplace/license-status?kind=&id=` answers
//! `free | active | refunded | disputed | expired | none`.
//!
//! Policy:
//! - online `free` / `active` → allow and remember it as the last-good answer;
//! - online `refunded` / `disputed` / `expired` → refuse and remember the revocation;
//! - online `none` → allow without caching (share-code installs and other
//!   publisher-granted access have no license row; only an explicit revocation
//!   or lapse blocks);
//! - control plane unreachable / signed out → fall back to the last answer:
//!   no answer ever recorded ⇒ allow (nothing says the item is paid); `free` ⇒
//!   allow; `active` ⇒ allow for [`LICENSE_OFFLINE_GRACE_SECS`] after the last
//!   successful check, then refuse until Core can re-check; a remembered
//!   revocation ⇒ refuse.
//!
//! The same decision ([`apply_license_probe`]) also runs in the background for
//! items that are already enabled ([`revalidate_items`], scheduled by
//! `server::marketplace_license_watch`), so a refund or dispute stops a running
//! paid item without waiting for the next enable. A revocation found there is
//! enforced through the normal disable path; an unreachable control plane is
//! never a revocation on its own.
//!
//! The cache is a local convenience, not a security boundary against the
//! machine owner; it exists so a refund is honored at the next online enable
//! and so offline use of a paid item is bounded.

use std::path::PathBuf;

use anyhow::{bail, Result};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::i18n::{messages, Message};

/// How long a remembered `active` answer keeps a paid item enable-able while the
/// control plane cannot be reached.
pub const LICENSE_OFFLINE_GRACE_SECS: u64 = 7 * 24 * 60 * 60;

const LICENSE_CACHE_DIR: &str = "ryu-marketplace-licenses";
const MAX_LICENSE_STATUS_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseState {
    Free,
    Active,
    Refunded,
    Disputed,
    Expired,
    None,
}

impl LicenseState {
    fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "free" => Self::Free,
            "active" => Self::Active,
            "refunded" => Self::Refunded,
            "disputed" => Self::Disputed,
            "expired" => Self::Expired,
            "none" => Self::None,
            _ => return None,
        })
    }

    fn is_revoked(self) -> bool {
        matches!(self, Self::Refunded | Self::Disputed | Self::Expired)
    }

    /// Why an item in this state may not run, as a localizable message.
    fn refusal(self, kind: &str, id: &str) -> Message {
        let template = match self {
            Self::Refunded => messages::LICENSE_REFUNDED_MESSAGE,
            Self::Disputed => messages::LICENSE_DISPUTED_MESSAGE,
            Self::Expired => messages::LICENSE_EXPIRED_MESSAGE,
            Self::Free | Self::Active | Self::None => messages::LICENSE_REFUSED_MESSAGE,
        };
        Message::new(template).text("item", item_label(kind, id))
    }
}

/// How a refusal names the item: `plugin/acme.paid`.
fn item_label(kind: &str, id: &str) -> String {
    format!("{kind}/{id}")
}

/// The last answer the control plane gave for one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedLicense {
    pub state: LicenseState,
    pub checked_at: u64,
}

/// What the online probe produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseProbe {
    Answer(LicenseState),
    Unavailable(String),
}

/// Pure enable decision. `Ok(Some(cache))` asks the caller to persist that
/// answer; `Ok(None)` allows without touching the cache; `Err` refuses with
/// the reason, rendered per reader (English for the HTTP error and logs).
pub fn decide_enable(
    kind: &str,
    id: &str,
    probe: &LicenseProbe,
    cached: Option<CachedLicense>,
    now: u64,
) -> std::result::Result<Option<CachedLicense>, Message> {
    match probe {
        LicenseProbe::Answer(LicenseState::None) => Ok(None),
        LicenseProbe::Answer(state) => {
            let record = CachedLicense {
                state: *state,
                checked_at: now,
            };
            if state.is_revoked() {
                // The caller persists the revocation before surfacing the error,
                // so an offline retry cannot fall back to an older `active`.
                Err(state.refusal(kind, id))
            } else {
                Ok(Some(record))
            }
        }
        LicenseProbe::Unavailable(reason) => match cached {
            None => Ok(None),
            Some(record) if record.state.is_revoked() => Err(record.state.refusal(kind, id)),
            Some(CachedLicense {
                state: LicenseState::Active,
                checked_at,
            }) if now.saturating_sub(checked_at) > LICENSE_OFFLINE_GRACE_SECS => {
                Err(Message::new(messages::LICENSE_OFFLINE_GRACE_ENDED_MESSAGE)
                    .text("item", item_label(kind, id))
                    .text("reason", reason.clone()))
            }
            Some(_) => Ok(None),
        },
    }
}

fn cache_path(kind: &str, id: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let key = format!("{}\n{kind}\n{id}", super::sources::ryu_marketplace_base());
    crate::paths::cache_path(LICENSE_CACHE_DIR).join(format!(
        "{}.json",
        hex::encode(Sha256::digest(key.as_bytes()))
    ))
}

fn read_cached(kind: &str, id: &str) -> Option<CachedLicense> {
    let raw = std::fs::read_to_string(cache_path(kind, id)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cached(kind: &str, id: &str, record: CachedLicense) {
    let path = cache_path(kind, id);
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(json) = serde_json::to_vec(&record) else {
        return;
    };
    let temporary = path.with_extension("json.tmp");
    if std::fs::write(&temporary, json).is_ok() {
        let _ = std::fs::rename(temporary, path);
    }
}

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// Remember the entitlement observed at install time, so the first offline
/// enable after a paid install is covered by the grace window.
pub fn remember_install_entitlement(kind: &str, id: &str, paid: bool) {
    write_cached(
        kind,
        id,
        CachedLicense {
            state: if paid {
                LicenseState::Active
            } else {
                LicenseState::Free
            },
            checked_at: now_unix_seconds(),
        },
    );
}

async fn probe_license_status(client: &reqwest::Client, kind: &str, id: &str) -> LicenseProbe {
    let Some(token) = super::sources::marketplace_buyer_token() else {
        return LicenseProbe::Unavailable("not signed in to the Marketplace".to_owned());
    };
    let url = format!(
        "{}/api/marketplace/license-status?kind={}&id={}",
        super::sources::ryu_marketplace_base(),
        urlencoding::encode(kind),
        urlencoding::encode(id.trim()),
    );
    let response = match client
        .get(&url)
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return LicenseProbe::Unavailable(format!("unreachable: {error}")),
    };
    if !response.status().is_success() {
        return LicenseProbe::Unavailable(format!("status {}", response.status()));
    }
    let body = match super::sources::read_bounded_reqwest_body(
        response,
        MAX_LICENSE_STATUS_BYTES,
        "Marketplace license status",
    )
    .await
    {
        Ok(body) => body,
        Err(error) => return LicenseProbe::Unavailable(error.to_string()),
    };
    serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("status")
                .and_then(serde_json::Value::as_str)
                .and_then(LicenseState::parse)
        })
        .map_or_else(
            || LicenseProbe::Unavailable("unrecognized license status".to_owned()),
            LicenseProbe::Answer,
        )
}

/// Where a license answer comes from. Production asks the control plane
/// ([`HttpLicenseOracle`]); tests substitute a fake so the enable-time check and
/// the background re-validation run the same decision code.
pub trait LicenseOracle: Send + Sync {
    fn probe<'a>(&'a self, kind: &'a str, id: &'a str) -> BoxFuture<'a, LicenseProbe>;
}

/// The last-good answer store behind the offline grace window.
pub trait LicenseCache: Send + Sync {
    fn read(&self, kind: &str, id: &str) -> Option<CachedLicense>;
    fn write(&self, kind: &str, id: &str, record: CachedLicense);
}

/// The control-plane `license-status` endpoint, authenticated with the buyer
/// token in scope (see `with_buyer_token`).
pub struct HttpLicenseOracle<'c> {
    pub client: &'c reqwest::Client,
}

impl LicenseOracle for HttpLicenseOracle<'_> {
    fn probe<'a>(&'a self, kind: &'a str, id: &'a str) -> BoxFuture<'a, LicenseProbe> {
        Box::pin(probe_license_status(self.client, kind, id))
    }
}

/// The on-disk cache under `RYU_DIR/cache/ryu-marketplace-licenses`.
pub struct DiskLicenseCache;

impl LicenseCache for DiskLicenseCache {
    fn read(&self, kind: &str, id: &str) -> Option<CachedLicense> {
        read_cached(kind, id)
    }
    fn write(&self, kind: &str, id: &str, record: CachedLicense) {
        write_cached(kind, id, record);
    }
}

/// Apply one probe to the cache and decide. The single code path shared by the
/// enable-time check and the background re-validation: a revocation is persisted
/// before it is reported (so an offline retry cannot fall back to an older
/// `active`), an allowed online answer becomes the new last-good answer, and an
/// unreachable control plane falls back to the cache under the grace rules.
pub fn apply_license_probe(
    cache: &dyn LicenseCache,
    kind: &str,
    id: &str,
    probe: &LicenseProbe,
    now: u64,
) -> std::result::Result<(), Message> {
    let cached = cache.read(kind, id);
    if let LicenseProbe::Answer(state) = probe {
        if state.is_revoked() {
            cache.write(
                kind,
                id,
                CachedLicense {
                    state: *state,
                    checked_at: now,
                },
            );
        }
    }
    match decide_enable(kind, id, probe, cached, now) {
        Ok(Some(record)) => {
            cache.write(kind, id, record);
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(reason) => Err(reason),
    }
}

/// Refuse to enable a Marketplace install whose license was revoked (refund,
/// dispute, lapse), tolerating an unreachable control plane within the bounded
/// offline grace. Uses the per-request buyer token (see `with_buyer_token`).
pub async fn require_enable_license(client: &reqwest::Client, kind: &str, id: &str) -> Result<()> {
    let probe = HttpLicenseOracle { client }.probe(kind, id).await;
    if let Err(reason) =
        apply_license_probe(&DiskLicenseCache, kind, id, &probe, now_unix_seconds())
    {
        bail!(reason.render("en"));
    }
    Ok(())
}

// ── Background re-validation ────────────────────────────────────────────────

/// One enabled Marketplace item the background pass re-checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicensedItem {
    pub kind: String,
    pub id: String,
}

/// An enabled item whose license no longer allows it to run, with the same
/// reason the enable-time check would have given: `message` renders it for
/// the reader, `reason` is its English text for logs and activity metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct LicenseRevocation {
    pub item: LicensedItem,
    pub reason: String,
    pub message: Message,
}

impl LicenseRevocation {
    pub fn new(item: LicensedItem, message: Message) -> Self {
        Self {
            item,
            reason: message.render("en"),
            message,
        }
    }
}

/// What one background pass found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RevalidationPass {
    /// Items probed (free items with a remembered `free` answer are skipped).
    pub checked: usize,
    /// Items that must now be disabled.
    pub revoked: Vec<LicenseRevocation>,
    /// True when at least one probe could not reach the control plane, so the
    /// caller can retry sooner and pick up a reconnect.
    pub unreachable: bool,
}

/// Re-check every enabled Marketplace item with at most `concurrency` probes in
/// flight. Items remembered as `free` are skipped (a free item has nothing to
/// revoke); everything else, including items installed before the cache
/// existed, is probed once and goes through [`apply_license_probe`], so a
/// transient network error never revokes an item inside the offline grace.
pub async fn revalidate_items(
    oracle: &dyn LicenseOracle,
    cache: &dyn LicenseCache,
    items: Vec<LicensedItem>,
    now: u64,
    concurrency: usize,
) -> RevalidationPass {
    use futures_util::stream::{self, StreamExt};

    let due: Vec<LicensedItem> = items
        .into_iter()
        .filter(|item| {
            cache
                .read(&item.kind, &item.id)
                .is_none_or(|record| record.state != LicenseState::Free)
        })
        .collect();
    let checked = due.len();
    let outcomes: Vec<(LicensedItem, LicenseProbe)> = stream::iter(due)
        .map(|item| async move {
            let probe = oracle.probe(&item.kind, &item.id).await;
            (item, probe)
        })
        .buffer_unordered(concurrency.max(1))
        .collect()
        .await;

    let mut pass = RevalidationPass {
        checked,
        ..RevalidationPass::default()
    };
    for (item, probe) in outcomes {
        if matches!(probe, LicenseProbe::Unavailable(_)) {
            pass.unreachable = true;
        }
        if let Err(reason) = apply_license_probe(cache, &item.kind, &item.id, &probe, now) {
            pass.revoked.push(LicenseRevocation::new(item, reason));
        }
    }
    pass.revoked
        .sort_by(|a, b| (&a.item.kind, &a.item.id).cmp(&(&b.item.kind, &b.item.id)));
    pass
}

/// [`revalidate_items`] against the control plane and the on-disk cache.
///
/// A background pass has no request to borrow a buyer token from. An explicit
/// `RYU_MARKETPLACE_TOKEN` (headless) is used as-is; otherwise the node's
/// signed-in session token — the same bearer the desktop presents to the
/// Marketplace — is put in scope. With neither, every probe is `Unavailable`
/// and the offline-grace rules decide.
pub async fn revalidate_enabled_items(
    client: &reqwest::Client,
    session_token: Option<String>,
    items: Vec<LicensedItem>,
    concurrency: usize,
) -> RevalidationPass {
    let token = if super::sources::marketplace_buyer_token().is_some() {
        None
    } else {
        session_token
    };
    super::sources::with_buyer_token(
        token,
        revalidate_items(
            &HttpLicenseOracle { client },
            &DiskLicenseCache,
            items,
            now_unix_seconds(),
            concurrency,
        ),
    )
    .await
}

#[cfg(test)]
mod tests;
