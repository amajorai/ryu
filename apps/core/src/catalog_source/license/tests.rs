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
        assert!(refusal.render("en").contains("plugin/a"));
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
    assert!(stale.render("en").contains("offline grace"));
    // A remembered refund stays refused offline.
    assert!(decide_enable("app", "a", &offline, cached(LicenseState::Refunded, 0), NOW).is_err());
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

#[test]
fn a_revocation_keeps_english_for_logs_and_renders_for_the_reader() {
    let message = LicenseState::Refunded.refusal("plugin", "acme.paid");
    let revocation = LicenseRevocation::new(item("acme.paid"), message.clone());
    assert_eq!(
        revocation.reason,
        "The Marketplace purchase of plugin/acme.paid was refunded, so its license is revoked. Buy it again to enable it."
    );
    // Japanese uses the catalog translation once it lands, else English; the
    // item label is never translated.
    let japanese = revocation.message.render("ja");
    assert!(japanese.contains("plugin/acme.paid"), "{japanese}");
    assert_eq!(message.render("en"), revocation.reason);
}
