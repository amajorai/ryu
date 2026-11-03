//! GitHub-topic discovery source (Plugin kind, **descriptor-only**).
//!
//! Anyone can publish a Ryu app or plugin by pushing a public GitHub repo and
//! tagging it with the `ryu-app` / `ryu-plugin` topic. This source turns those
//! two topics into a browsable catalog. A THIRD topic, `ryu-marketplace`,
//! discovers community MARKETPLACES — repos containing folders with a
//! `ryu.package.json`; each is rendered grouped under the marketplace's own
//! heading. A legacy `marketplace.json` reader remains only as a compatibility
//! fallback. It is deliberately the *least trusted* Plugin
//! source in the registry, and its shape encodes that:
//!
//! - **No `raw.manifest` in the install descriptor.** `resolve_plugin_from_catalog`
//!   parses `descriptor.raw["manifest"]` into a `PluginManifest` and skips a source
//!   that can't produce one — so omitting it keeps install-by-id *fail-closed*. If a
//!   future refactor "helpfully" carried the repo's `plugin.json` here, every
//!   topic-squatting repo would become an unsigned install path. The unit test
//!   `install_descriptor_never_carries_a_manifest` is the regression guard.
//! - **Every card is stamped `origin:"community"` + `reviewed:false`.** That is the
//!   one discriminator the store's trust notice keys on; see
//!   `packages/marketplace/src/catalog/apps-catalog-section.tsx` (`isCommunityEntry`).
//! - **Never lift runnable code.** Manifest enrichment in `detail` copies an
//!   allowlist of display fields only — `ui_code` / `backend_code` / `*_sha256`
//!   are dropped, mirroring the trust ladder in `gate_plugin_ui_code`.
//! - **Ids are namespaced `gh:<owner>/<repo>`.** Core's install path probes *every*
//!   registered Plugin source for *every* install-by-id, so a foreign id must be
//!   rejected in O(1), before any network call, or an unrelated install burns the
//!   GitHub Search rate-limit budget.
//!
//! "Nothing hardcoded": the API base, both topic strings, and the cache TTL are all
//! env-overridable. The BYOK personal access token is host-scoped — it is only ever
//! attached to the *default* `api.github.com` base, never to a custom one.

use anyhow::Result;
use serde_json::Value;
use std::sync::OnceLock;

use super::{CatalogKind, CatalogQuery, CatalogSource, InstallDescriptor};

/// Default GitHub REST base. Overridable for a mirror/enterprise host — which
/// **suppresses the token** (see [`GithubTopicSource::resolve_token`]).
const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_API_BASE_ENV: &str = "RYU_GITHUB_API_URL";

/// The two discovery topics. A repo carrying `ryu-app` is classified as an app
/// (it ships a companion UI surface); `ryu-plugin` is everything else.
const GITHUB_TOPIC_APP: &str = "ryu-app";
const GITHUB_TOPIC_PLUGIN: &str = "ryu-plugin";
const GITHUB_TOPIC_APP_ENV: &str = "RYU_GITHUB_TOPIC_APP";
const GITHUB_TOPIC_PLUGIN_ENV: &str = "RYU_GITHUB_TOPIC_PLUGIN";

/// The third discovery topic: a community MARKETPLACE. A repo tagged
/// `ryu-marketplace` is a collection, not a single plugin — it hosts package
/// folders whose `ryu.package.json` files are the individual listings. The store
/// renders its entries grouped under the marketplace's own heading (see
/// [`GithubMarketplace`]).
const GITHUB_TOPIC_MARKETPLACE: &str = "ryu-marketplace";
const GITHUB_TOPIC_MARKETPLACE_ENV: &str = "RYU_GITHUB_TOPIC_MARKETPLACE";

/// The `ghmp:` id namespace for a marketplace ENTRY:
/// `ghmp:<mkt-owner>/<mkt-repo>:<entry-name>`. Distinct from `gh:` so a
/// marketplace entry can never collide with (or masquerade as) a single-plugin
/// listing, and foreign-id rejection stays O(1) before any network call.
const GHMP_ID_PREFIX: &str = "ghmp:";

const GITHUB_TOPIC_TTL_ENV: &str = "RYU_GITHUB_TOPIC_CACHE_TTL_SECS";
/// 6h. One refresh costs 2 Search API calls; the unauthenticated Search budget is
/// 10 req/min (30 authenticated) in a bucket separate from the 60/hr core limit, so
/// this plus stale-serve keeps discovery far inside budget however often the store
/// is opened.
const GITHUB_TOPIC_DEFAULT_TTL_SECS: u64 = 6 * 60 * 60;

/// GitHub's `per_page` ceiling for the Search API.
const GITHUB_TOPIC_PER_PAGE: usize = 100;

/// Preferences key holding the BYOK GitHub personal access token. Mirrors
/// `SMITHERY_API_KEY_PREF`: the route reads the pref and rewrites the source
/// before use, so the token never lives in the persisted registry.
pub const GITHUB_TOKEN_PREF: &str = "github-api-token";

/// Env fallbacks for the token, in order. `RYU_GITHUB_TOKEN` is the documented
/// primary so an ambient CI `GITHUB_TOKEN` is never the surprising default.
const GITHUB_TOKEN_ENVS: [&str; 2] = ["RYU_GITHUB_TOKEN", "GITHUB_TOKEN"];

/// The `origin` discriminator stamped on every card. The store's trust notice and
/// its "Community" section filter both key on this exact string — it must stay in
/// sync with `isCommunityEntry` in `@ryu/marketplace`.
pub const COMMUNITY_ORIGIN: &str = "community";

/// Stable source id, also the `?origin=community` browse dispatch target.
pub const GITHUB_TOPIC_SOURCE_ID: &str = "github-topic";

/// `gh:` id namespace. Guarantees no collision with a real plugin id in
/// `merge_plugin_catalog_entries` and makes foreign-id rejection free.
const GH_ID_PREFIX: &str = "gh:";

/// Manifest paths tried (in order) when enriching a detail view. First hit wins;
/// all missing is NOT an error.
const REPO_MANIFEST_PATHS: [&str; 7] = [
    // `manifest.json` is the canonical name (MANIFEST_FILE_NAMES[0]); the older
    // `plugin.json` / `ryu.json` stay for third-party repos that predate the
    // rename, matching the loader's own back-compat order.
    "manifest.json",
    "plugin.json",
    "ryu.json",
    ".ryu-plugin/manifest.json",
    ".ryu-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
];

/// Legacy marketplace manifest paths tried only after no portable package folder
/// was found. New discovery never depends on a central index.
const REPO_MARKETPLACE_PATHS: [&str; 4] = [
    ".ryu-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
];
const PACKAGE_MANIFEST_FILE: &str = "ryu.package.json";

/// Display fields lifted from a third-party manifest. Everything outside this
/// allowlist is dropped — in particular `ui_code`, `backend_code`, and any
/// `*_sha256`, which must never travel from an unsigned source.
/// How long a repo's manifest probe result stays authoritative before it is
/// re-checked. This is the **negative** cache that makes list-time hydration
/// affordable: most `ryu-plugin` repos carry no manifest at any of the seven
/// [`REPO_MANIFEST_PATHS`], and without a remembered miss every 6h refresh would
/// re-pay seven raw fetches per manifest-less repo, forever. A repo that later
/// adds a manifest is picked up on the next re-probe.
const MANIFEST_PROBE_TTL_SECS: u64 = 7 * 24 * 60 * 60;

/// In-flight raw fetches while hydrating a refreshed record set.
const MANIFEST_HYDRATE_CONCURRENCY: usize = 8;

/// Wall-clock ceiling on one hydration pass. `search()` awaits `records()`, so an
/// unbounded pass would turn "the store is slow" into a regression of this
/// source's whole degradation story (an unreachable GitHub must cost a note, not
/// the page). Records the deadline cuts short keep `manifest_probed_at: 0` and are
/// retried on the next refresh — never silently marked as "no manifest".
const MANIFEST_HYDRATE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

// Bounds on every manifest-declared string that reaches a card. A community
// manifest is attacker-controlled free text — the same posture
// `truncate_description` already applies to the repo description.
const MAX_NAME_CHARS: usize = 80;
const MAX_TAGLINE_CHARS: usize = 140;
const MAX_CATEGORY_CHARS: usize = 40;
const MAX_VERSION_CHARS: usize = 32;
const MAX_ICON_ID_CHARS: usize = 64;
const MAX_KEYWORDS: usize = 16;
const MAX_TAGS: usize = 16;
const MAX_SCREENSHOTS: usize = 8;
const MAX_EXAMPLE_PROMPTS: usize = 8;
const MAX_CAPABILITIES: usize = 16;
const MAX_LAYERS: usize = 16;
const MAX_LAYER_VERBS: usize = 32;
const MAX_CAPABILITY_CHARS: usize = 80;

// Split by responsibility; every item keeps its `github_topic::` path through
// the re-export below.
mod banner;
mod card;
mod catalog;
mod detail_fields;
mod github_api;
mod manifest_display;
mod marketplace;
mod record;
mod records;
mod scrub;
mod source;
mod source_cache;

pub use self::github_api::GithubTopicSource;
#[allow(unused_imports)]
pub(crate) use self::{
    banner::*, card::*, catalog::*, detail_fields::*, github_api::*, manifest_display::*,
    marketplace::*, record::*, records::*, scrub::*, source::*, source_cache::*,
};

#[cfg(test)]
mod tests;
