// Each split-out module is named here so its suite is visible from the module
// it covers; everything else arrives through the parent's glob.
use super::banner::scrub_banner;
use super::card::record_to_item;
use super::detail_fields::manifest_display_fields;
use super::github_api::{repo_item_to_record, GithubLicense, GithubOwner, GithubRepoItem};
use super::manifest_display::RepoManifestDisplay;
use super::marketplace::GithubMarketplace;
use super::record::GithubTopicRecord;
use super::records::{carry_manifests, parse_gh_id};
use super::scrub::{scrub_css_color, scrub_icon_id};
use super::*;

fn repo(full_name: &str, stars: u64) -> GithubRepoItem {
    GithubRepoItem {
        full_name: full_name.to_string(),
        description: Some("a thing".to_string()),
        html_url: format!("https://github.com/{full_name}"),
        stargazers_count: stars,
        owner: GithubOwner {
            login: full_name.split('/').next().unwrap_or("").to_string(),
            avatar_url: Some("https://avatars.githubusercontent.com/u/1".to_string()),
        },
        topics: vec!["ryu-plugin".to_string()],
        license: Some(GithubLicense {
            spdx_id: Some("MIT".to_string()),
            name: Some("MIT License".to_string()),
        }),
        archived: false,
        fork: false,
        pushed_at: Some("2026-07-01T00:00:00Z".to_string()),
        homepage: None,
    }
}

/// A record whose manifest has already been probed, for the card-projection
/// tests below.
fn hydrated(full_name: &str, manifest: serde_json::Value) -> GithubTopicRecord {
    let mut record = repo_item_to_record(&repo(full_name, 4), false).unwrap();
    record.manifest = RepoManifestDisplay::from_manifest(&manifest);
    record.manifest_probed_at = unix_now();
    record
}

// ── Community marketplaces (`ryu-marketplace` topic) ──────────────────────

fn marketplace_repo(full_name: &str) -> GithubTopicRecord {
    let mut record = repo_item_to_marketplace_record(&repo(full_name, 6)).unwrap();
    record.marketplace = GithubMarketplace::from_manifest(
        &serde_json::json!({
            "name": "The Bazaar",
            "plugins": [
                {
                    "name": "thing-tool",
                    "displayName": "Thing Tool",
                    "description": "Does the thing.",
                    "version": "1.2.0",
                    "source": "acme/thing-tool",
                    "icon": "lucide:brain",
                    "category": "Productivity",
                    "hasCompanion": false,
                },
                {
                    "name": "canvas",
                    "displayName": "Canvas",
                    "source": { "repo": "acme/canvas" },
                    "hasCompanion": true,
                },
            ],
        }),
        full_name,
    );
    record.marketplace_probed_at = unix_now();
    record
}

mod brand;
mod cards;
mod discovery;
mod identity;
mod marketplaces;
