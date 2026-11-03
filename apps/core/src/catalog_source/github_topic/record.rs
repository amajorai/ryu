//! The cached topic hit and its on-disk cache envelope.

use super::*;

pub(super) static GITHUB_TOPIC_CACHE: OnceLock<tokio::sync::Mutex<Option<GithubTopicCache>>> =
    OnceLock::new();

#[derive(Clone)]
pub(super) struct GithubTopicCache {
    pub(super) fetched_at: std::time::Instant,
    pub(super) records: Vec<GithubTopicRecord>,
    pub(super) source_url: String,
    /// True when this copy was served past its TTL because the refresh failed
    /// (offline, or a 403/429 rate limit). The note explains it to the user.
    pub(super) stale: bool,
    pub(super) note: Option<String>,
}

/// Disk envelope so a cold start while offline or rate-limited is not blank.
/// (`Instant` doesn't survive a restart; this does.)
#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct DiskCacheEnvelope {
    pub(super) fetched_at: u64,
    pub(super) records: Vec<GithubTopicRecord>,
    pub(super) source_url: String,
}

/// A normalized topic hit. Deliberately much smaller than GitHub's repo payload so
/// the cache is cheap and stable across upstream schema drift.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct GithubTopicRecord {
    /// `gh:<owner>/<repo>`.
    pub(super) id: String,
    pub(super) owner: String,
    pub(super) repo: String,
    pub(super) full_name: String,
    #[serde(default)]
    pub(super) description: Option<String>,
    pub(super) stars: u64,
    pub(super) html_url: String,
    #[serde(default)]
    pub(super) avatar_url: Option<String>,
    #[serde(default)]
    pub(super) topics: Vec<String>,
    #[serde(default)]
    pub(super) license: Option<String>,
    #[serde(default)]
    pub(super) pushed_at: Option<String>,
    #[serde(default)]
    pub(super) homepage: Option<String>,
    #[serde(default)]
    pub(super) is_fork: bool,
    /// Which topic query produced this row — the ground truth for app-vs-plugin.
    /// The repo's own `topics` array is publisher-controlled and is NOT trusted here.
    pub(super) is_app: bool,
    /// True when this row was discovered under the `ryu-marketplace` topic — i.e.
    /// it is a COLLECTION, not a single plugin. Its entries render grouped under
    /// the marketplace's heading (see [`GithubMarketplace`]) instead of the repo
    /// appearing as one bare listing.
    #[serde(default)]
    pub(super) is_marketplace: bool,
    /// The parsed `marketplace.json` (name + entries) when the repo hosts one.
    /// `None` = probed and absent, or not probed yet — the two are distinguished
    /// by [`marketplace_probed_at`](GithubTopicRecord::marketplace_probed_at).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) marketplace: Option<GithubMarketplace>,
    /// Unix seconds of the last marketplace.json probe; `0` = never probed.
    #[serde(default)]
    pub(super) marketplace_probed_at: u64,
    /// What the repo's own `manifest.json` declares about how it should be
    /// presented. `None` = probed and absent, or not probed yet — the two are
    /// distinguished by [`manifest_probed_at`](GithubTopicRecord::manifest_probed_at).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) manifest: Option<RepoManifestDisplay>,
    /// Unix seconds of the last manifest probe; `0` = never probed. Persisted in
    /// the disk cache so a restart does not re-pay the whole hydration pass, and so
    /// a manifest-less repo is remembered as such (see [`MANIFEST_PROBE_TTL_SECS`]).
    #[serde(default)]
    pub(super) manifest_probed_at: u64,
}

impl GithubTopicRecord {
    /// Whether this record's manifest should be (re-)probed. Never probed, or the
    /// last probe is older than [`MANIFEST_PROBE_TTL_SECS`] — the second arm is
    /// what lets a repo that ADDS a manifest later still be picked up, rather than
    /// being cached as manifest-less forever.
    pub(super) fn manifest_probe_is_due(&self, now: u64) -> bool {
        self.manifest_probed_at == 0
            || now.saturating_sub(self.manifest_probed_at) >= MANIFEST_PROBE_TTL_SECS
    }

    /// Same TTL as the manifest probe: a repo that adds package folders later
    /// (or fills an existing one) is picked up on the next re-probe.
    pub(super) fn marketplace_probe_is_due(&self, now: u64) -> bool {
        self.marketplace_probed_at == 0
            || now.saturating_sub(self.marketplace_probed_at) >= MANIFEST_PROBE_TTL_SECS
    }
}
