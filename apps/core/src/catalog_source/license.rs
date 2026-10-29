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

    fn refusal(self, kind: &str, id: &str) -> String {
        match self {
            Self::Refunded => format!(
                "`{kind}/{id}`: this Marketplace purchase was refunded, so the license is revoked; buy it again to enable it"
            ),
            Self::Disputed => format!(
                "`{kind}/{id}`: this Marketplace purchase is disputed, so the license is suspended"
            ),
            Self::Expired => format!(
                "`{kind}/{id}`: this Marketplace license has expired; renew it to enable the item"
            ),
            Self::Free | Self::Active | Self::None => {
                format!("`{kind}/{id}`: Marketplace license refused")
            }
        }
    }
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
/// answer; `Ok(None)` allows without touching the cache; `Err` refuses.
pub fn decide_enable(
    kind: &str,
    id: &str,
    probe: &LicenseProbe,
    cached: Option<CachedLicense>,
    now: u64,
) -> std::result::Result<Option<CachedLicense>, String> {
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
            }) if now.saturating_sub(checked_at) > LICENSE_OFFLINE_GRACE_SECS => Err(format!(
                "`{kind}/{id}`: the Marketplace license could not be re-checked ({reason}) and the offline grace period has ended; reconnect and sign in to enable this paid item"
            )),
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
) -> std::result::Result<(), String> {
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
        bail!(reason);
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
/// user-facing reason the enable-time check would have given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenseRevocation {
    pub item: LicensedItem,
    pub reason: String,
}

/// What one background pass found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
            pass.revoked.push(LicenseRevocation { item, reason });
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
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn cached(state: LicenseState, age: u64) -> Option<CachedLicense> {
        Some(CachedLicense {
            state,
            checked_at: NOW - age,
        })
    }

    #[test]
    fn online_answers_allow_or_revoke() {
        for state in [LicenseState::Free, LicenseState::Active] {
            assert_eq!(
                decide_enable("plugin", "a", &LicenseProbe::Answer(state), None, NOW),
                Ok(Some(CachedLicense {
                    state,
                    checked_at: NOW
                }))
            );
        }
        for state in [
            LicenseState::Refunded,
            LicenseState::Disputed,
            LicenseState::Expired,
        ] {
            let refusal = decide_enable(
                "plugin",
                "a",
                &LicenseProbe::Answer(state),
                cached(LicenseState::Active, 0),
                NOW,
            )
            .expect_err("a revoked license must refuse even with a fresh active cache");
            assert!(refusal.contains("plugin/a"));
        }
        // No license row (e.g. a publisher-granted share-code install) is not a
        // revocation and does not overwrite the last-good answer.
        assert_eq!(
            decide_enable(
                "plugin",
                "a",
                &LicenseProbe::Answer(LicenseState::None),
                None,
                NOW
            ),
            Ok(None)
        );
    }

    #[test]
    fn offline_falls_back_to_a_bounded_last_good_answer() {
        let offline = LicenseProbe::Unavailable("unreachable".to_owned());
        // Never observed as paid: allow.
        assert_eq!(decide_enable("app", "a", &offline, None, NOW), Ok(None));
        // Free never expires.
        assert_eq!(
            decide_enable(
                "app",
                "a",
                &offline,
                cached(LicenseState::Free, 10 * LICENSE_OFFLINE_GRACE_SECS),
                NOW
            ),
            Ok(None)
        );
        // Active within the grace window: allow.
        assert_eq!(
            decide_enable(
                "app",
                "a",
                &offline,
                cached(LicenseState::Active, LICENSE_OFFLINE_GRACE_SECS),
                NOW
            ),
            Ok(None)
        );
        // Active past the grace window: refuse until re-checked.
        let stale = decide_enable(
            "app",
            "a",
            &offline,
            cached(LicenseState::Active, LICENSE_OFFLINE_GRACE_SECS + 1),
            NOW,
        )
        .expect_err("stale active license must not enable forever offline");
        assert!(stale.contains("offline grace"));
        // A remembered refund stays refused offline.
        assert!(
            decide_enable("app", "a", &offline, cached(LicenseState::Refunded, 0), NOW).is_err()
        );
    }

    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A scripted control plane: one answer per `kind/id`, recording each probe.
    #[derive(Default)]
    struct FakeOracle {
        answers: HashMap<String, LicenseProbe>,
        probed: Mutex<Vec<String>>,
    }

    impl FakeOracle {
        fn with(mut self, id: &str, probe: LicenseProbe) -> Self {
            self.answers.insert(format!("plugin/{id}"), probe);
            self
        }
    }

    impl LicenseOracle for FakeOracle {
        fn probe<'a>(&'a self, kind: &'a str, id: &'a str) -> BoxFuture<'a, LicenseProbe> {
            let key = format!("{kind}/{id}");
            self.probed.lock().unwrap().push(key.clone());
            let answer = self
                .answers
                .get(&key)
                .cloned()
                .unwrap_or_else(|| LicenseProbe::Unavailable("unscripted".to_owned()));
            Box::pin(async move { answer })
        }
    }

    #[derive(Default)]
    struct MemoryCache(Mutex<HashMap<String, CachedLicense>>);

    impl MemoryCache {
        fn seeded(id: &str, state: LicenseState, age: u64) -> Self {
            let cache = Self::default();
            cache.write("plugin", id, cached(state, age).unwrap());
            cache
        }
    }

    impl LicenseCache for MemoryCache {
        fn read(&self, kind: &str, id: &str) -> Option<CachedLicense> {
            self.0.lock().unwrap().get(&format!("{kind}/{id}")).copied()
        }
        fn write(&self, kind: &str, id: &str, record: CachedLicense) {
            self.0
                .lock()
                .unwrap()
                .insert(format!("{kind}/{id}"), record);
        }
    }

    fn item(id: &str) -> LicensedItem {
        LicensedItem {
            kind: "plugin".to_owned(),
            id: id.to_owned(),
        }
    }

    async fn pass(oracle: &FakeOracle, cache: &MemoryCache, id: &str) -> RevalidationPass {
        revalidate_items(oracle, cache, vec![item(id)], NOW, 4).await
    }

    #[tokio::test]
    async fn background_pass_leaves_a_still_active_license_running() {
        let oracle = FakeOracle::default().with("a", LicenseProbe::Answer(LicenseState::Active));
        let cache = MemoryCache::seeded("a", LicenseState::Active, 3 * 24 * 60 * 60);
        let result = pass(&oracle, &cache, "a").await;
        assert_eq!(result.checked, 1);
        assert!(result.revoked.is_empty());
        assert!(!result.unreachable);
        // The fresh online answer becomes the new last-good answer.
        assert_eq!(cache.read("plugin", "a"), cached(LicenseState::Active, 0));
    }

    #[tokio::test]
    async fn background_pass_revokes_a_refunded_license_with_its_reason() {
        let oracle = FakeOracle::default().with("a", LicenseProbe::Answer(LicenseState::Refunded));
        let cache = MemoryCache::seeded("a", LicenseState::Active, 60);
        let result = pass(&oracle, &cache, "a").await;
        assert_eq!(result.revoked.len(), 1);
        assert_eq!(result.revoked[0].item, item("a"));
        assert!(result.revoked[0].reason.contains("refunded"));
        // The revocation is persisted so an offline enable cannot undo it.
        assert_eq!(
            cache.read("plugin", "a").map(|record| record.state),
            Some(LicenseState::Refunded)
        );
    }

    #[tokio::test]
    async fn background_pass_tolerates_a_network_error_inside_the_grace_window() {
        let oracle = FakeOracle::default().with(
            "a",
            LicenseProbe::Unavailable("unreachable: connection reset".to_owned()),
        );
        let cache = MemoryCache::seeded("a", LicenseState::Active, LICENSE_OFFLINE_GRACE_SECS);
        let result = pass(&oracle, &cache, "a").await;
        assert!(result.revoked.is_empty());
        assert!(result.unreachable);
        // The last-good answer is not refreshed by an offline pass.
        assert_eq!(
            cache.read("plugin", "a"),
            cached(LicenseState::Active, LICENSE_OFFLINE_GRACE_SECS)
        );
    }

    #[tokio::test]
    async fn background_pass_revokes_once_the_offline_grace_has_ended() {
        let oracle = FakeOracle::default().with(
            "a",
            LicenseProbe::Unavailable("unreachable: timed out".to_owned()),
        );
        let cache = MemoryCache::seeded("a", LicenseState::Active, LICENSE_OFFLINE_GRACE_SECS + 1);
        let result = pass(&oracle, &cache, "a").await;
        assert_eq!(result.revoked.len(), 1);
        assert!(result.revoked[0].reason.contains("offline grace"));
        assert!(result.unreachable);
    }

    #[tokio::test]
    async fn background_pass_skips_free_items_and_probes_unknown_ones_once() {
        let oracle = FakeOracle::default()
            .with("free", LicenseProbe::Answer(LicenseState::Free))
            .with("legacy", LicenseProbe::Answer(LicenseState::Free))
            .with("gone", LicenseProbe::Answer(LicenseState::Disputed));
        let cache = MemoryCache::seeded("free", LicenseState::Free, 0);
        let result = revalidate_items(
            &oracle,
            &cache,
            vec![item("free"), item("legacy"), item("gone")],
            NOW,
            2,
        )
        .await;
        let mut probed = oracle.probed.lock().unwrap().clone();
        probed.sort();
        assert_eq!(probed, vec!["plugin/gone", "plugin/legacy"]);
        assert_eq!(result.checked, 2);
        assert_eq!(result.revoked.len(), 1);
        assert_eq!(result.revoked[0].item, item("gone"));
        assert!(result.revoked[0].reason.contains("disputed"));
        // An item installed before the cache existed is remembered after one probe.
        assert_eq!(
            cache.read("plugin", "legacy").map(|record| record.state),
            Some(LicenseState::Free)
        );
    }

    #[test]
    fn status_vocabulary_matches_the_control_plane() {
        for (raw, state) in [
            ("free", LicenseState::Free),
            ("active", LicenseState::Active),
            ("refunded", LicenseState::Refunded),
            ("disputed", LicenseState::Disputed),
            ("expired", LicenseState::Expired),
            ("none", LicenseState::None),
        ] {
            assert_eq!(LicenseState::parse(raw), Some(state));
        }
        assert_eq!(LicenseState::parse("revoked"), None);
    }
}
