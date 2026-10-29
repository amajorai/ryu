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

fn manifest_interface_value<'a>(
    obj: &'a serde_json::Map<String, Value>,
    interface_key: &str,
    top_level_keys: &[&str],
) -> Option<&'a Value> {
    obj.get("interface")
        .and_then(Value::as_object)
        .and_then(|interface| interface.get(interface_key))
        .filter(|value| !value.is_null())
        .or_else(|| {
            top_level_keys
                .iter()
                .find_map(|key| obj.get(*key).filter(|value| !value.is_null()))
        })
}

fn manifest_text(
    obj: &serde_json::Map<String, Value>,
    interface_key: &str,
    top_level_keys: &[&str],
    max_chars: usize,
) -> Option<String> {
    manifest_interface_value(obj, interface_key, top_level_keys)
        .and_then(Value::as_str)
        .and_then(|value| scrub_text(value, max_chars))
}

fn manifest_url(
    obj: &serde_json::Map<String, Value>,
    interface_key: &str,
    top_level_keys: &[&str],
) -> Option<String> {
    manifest_interface_value(obj, interface_key, top_level_keys)
        .and_then(Value::as_str)
        .and_then(sanitize_url)
}

fn scrub_string_list(value: Option<&Value>, max_items: usize, max_chars: usize) -> Vec<String> {
    let values = match value {
        Some(Value::Array(values)) => values.iter().collect::<Vec<_>>(),
        Some(value) => vec![value],
        None => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(Value::as_str)
        .filter_map(|value| scrub_text(value, max_chars))
        .take(max_items)
        .collect()
}

fn scrub_url_list(value: Option<&Value>) -> Vec<String> {
    scrub_string_list(value, MAX_SCREENSHOTS, MAX_URL_CHARS)
        .into_iter()
        .filter_map(|value| sanitize_url(&value))
        .collect()
}

fn scrub_author(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(name) => scrub_text(name, MAX_NAME_CHARS).map(Value::String),
        Value::Object(author) => {
            let mut out = serde_json::Map::new();
            if let Some(name) = author
                .get("name")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_NAME_CHARS))
            {
                out.insert("name".to_owned(), Value::String(name));
            }
            if let Some(url) = author
                .get("url")
                .and_then(Value::as_str)
                .and_then(sanitize_url)
            {
                out.insert("url".to_owned(), Value::String(url));
            }
            (!out.is_empty()).then_some(Value::Object(out))
        }
        _ => None,
    }
}

fn author_developer_string(author: &Value) -> Option<String> {
    match author {
        Value::String(name) => Some(name.clone()),
        Value::Object(author) => author
            .get("name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        _ => None,
    }
}

fn scrub_layers(value: Option<&Value>) -> Vec<Value> {
    let Some(provides) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    provides
        .iter()
        .filter_map(|provided| {
            let object = provided.as_object()?;
            let capability = object
                .get("capability")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_CAPABILITY_CHARS))?;
            let mut layer = serde_json::Map::new();
            layer.insert("capability".to_owned(), Value::String(capability.clone()));
            if let Some(title) = object
                .get("title")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_NAME_CHARS))
            {
                layer.insert("title".to_owned(), Value::String(title));
            }
            layer.insert(
                "toolkit".to_owned(),
                Value::Bool(
                    capability == "browser.control"
                        || capability == "computer.control"
                        || capability.starts_with("web."),
                ),
            );
            if let Some(selectable) = object.get("selectable").and_then(Value::as_bool) {
                layer.insert("selectable".to_owned(), Value::Bool(selectable));
            }
            if let Some(target) = object
                .get("target")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_NAME_CHARS))
            {
                layer.insert("target".to_owned(), Value::String(target));
            }
            if let Some(tools) = object.get("tools").and_then(Value::as_object) {
                let verbs = tools
                    .keys()
                    .filter_map(|verb| scrub_text(verb, MAX_CAPABILITY_CHARS))
                    .take(MAX_LAYER_VERBS)
                    .map(Value::String)
                    .collect::<Vec<_>>();
                if !verbs.is_empty() {
                    layer.insert("verbs".to_owned(), Value::Array(verbs));
                }
            }
            Some(Value::Object(layer))
        })
        .take(MAX_LAYERS)
        .collect()
}

static GITHUB_TOPIC_CACHE: OnceLock<tokio::sync::Mutex<Option<GithubTopicCache>>> = OnceLock::new();

#[derive(Clone)]
struct GithubTopicCache {
    fetched_at: std::time::Instant,
    records: Vec<GithubTopicRecord>,
    source_url: String,
    /// True when this copy was served past its TTL because the refresh failed
    /// (offline, or a 403/429 rate limit). The note explains it to the user.
    stale: bool,
    note: Option<String>,
}

/// Disk envelope so a cold start while offline or rate-limited is not blank.
/// (`Instant` doesn't survive a restart; this does.)
#[derive(serde::Serialize, serde::Deserialize)]
struct DiskCacheEnvelope {
    fetched_at: u64,
    records: Vec<GithubTopicRecord>,
    source_url: String,
}

/// A normalized topic hit. Deliberately much smaller than GitHub's repo payload so
/// the cache is cheap and stable across upstream schema drift.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct GithubTopicRecord {
    /// `gh:<owner>/<repo>`.
    id: String,
    owner: String,
    repo: String,
    full_name: String,
    #[serde(default)]
    description: Option<String>,
    stars: u64,
    html_url: String,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    is_fork: bool,
    /// Which topic query produced this row — the ground truth for app-vs-plugin.
    /// The repo's own `topics` array is publisher-controlled and is NOT trusted here.
    is_app: bool,
    /// True when this row was discovered under the `ryu-marketplace` topic — i.e.
    /// it is a COLLECTION, not a single plugin. Its entries render grouped under
    /// the marketplace's heading (see [`GithubMarketplace`]) instead of the repo
    /// appearing as one bare listing.
    #[serde(default)]
    is_marketplace: bool,
    /// The parsed `marketplace.json` (name + entries) when the repo hosts one.
    /// `None` = probed and absent, or not probed yet — the two are distinguished
    /// by [`marketplace_probed_at`](GithubTopicRecord::marketplace_probed_at).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    marketplace: Option<GithubMarketplace>,
    /// Unix seconds of the last marketplace.json probe; `0` = never probed.
    #[serde(default)]
    marketplace_probed_at: u64,
    /// What the repo's own `manifest.json` declares about how it should be
    /// presented. `None` = probed and absent, or not probed yet — the two are
    /// distinguished by [`manifest_probed_at`](GithubTopicRecord::manifest_probed_at).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest: Option<RepoManifestDisplay>,
    /// Unix seconds of the last manifest probe; `0` = never probed. Persisted in
    /// the disk cache so a restart does not re-pay the whole hydration pass, and so
    /// a manifest-less repo is remembered as such (see [`MANIFEST_PROBE_TTL_SECS`]).
    #[serde(default)]
    manifest_probed_at: u64,
}

/// The presentation a community repo DECLARES for itself, lifted from its own
/// `manifest.json` at list-refresh time.
///
/// Why this exists: a card used to be titled `<repo>` and iconed with the repo
/// OWNER's GitHub avatar, so every listing from one org looked identical and none
/// of them matched the name the plugin actually ships under. A listing's name and
/// icon are declared by its manifest — the rule every other catalog source already
/// follows — and `detail` was ALREADY lifting `icon` from the manifest
/// so the list path was simply not doing what the detail path did.
///
/// Three constraints shape what is in here:
///
/// - **Display only.** No `ui_code`, `backend_code`, `*_sha256`,
///   `permission_grants` or `mcp_servers`. Nothing runnable, and nothing that
///   reads as a permission claim, travels from an unsigned source; the install
///   descriptor stays manifest-free (`install_descriptor_never_carries_a_manifest`).
/// - **Never identity.** The manifest's `id` is not lifted at all, and the card's
///   `id` / `developer` / `owner` stay GitHub's own namespace. The manifest
///   supplies the *title*; GitHub supplies *who published it*; the card keeps its
///   `origin:"community"` + `reviewed:false` stamps. Attributed, not laundered — a
///   topic-squatting repo may title itself anything and still renders as
///   `<owner>`'s unreviewed listing under the community trust notice.
/// - **Bounded and scrubbed.** Every string is control-char-stripped and length
///   capped, `iconUrl` goes through [`sanitize_url`], `icon` must look like a
///   glyph id ([`scrub_icon_id`]), and the `banner` is rebuilt key by key
///   ([`scrub_banner`]) — a card renders whatever it is handed.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct RepoManifestDisplay {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stability: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tagline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    /// The icon square's painted plate — the same two keys every first-party
    /// manifest declares. Without them a community card falls through `AppIcon`'s
    /// flat `bg-muted` branch while every listing beside it gets a coloured
    /// gradient, which is the whole reason the community shelf read as a different
    /// component. Validated, never passed through: see [`scrub_icon_dither`] /
    /// [`scrub_css_color`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_dither: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_background: Option<String>,
    /// The hero band's own art — the `banner` key a first-party manifest declares,
    /// including the `animated-gradient` style and its preset/config. Dropping it
    /// was why a community listing could never open with anything but the wash
    /// derived from its icon, no matter what its manifest said.
    ///
    /// `#[serde(default)]` matters here beyond the usual: an existing disk cache
    /// was written before this field existed, so every cached record has to keep
    /// deserializing — a banner simply stays `None` until the repo is re-probed.
    ///
    /// Rebuilt key by key, never passed through ([`scrub_banner`]): the colours
    /// reach a CSS background AND a WebGL uniform, and the numbers reach the
    /// shader, where an unbounded value is a frozen tab rather than an ugly card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    banner: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repository_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    author: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    developer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    license: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    screenshots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    example_prompts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    privacy_policy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terms_of_service_url: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    external: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    layers: Vec<Value>,
    /// Bounded support rows from the manifest's `surfaces` map. Stored in the
    /// discovery cache so the community card can explain support before detail
    /// enrichment runs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    surface_support: Vec<Value>,
    /// Does the manifest claim a UI DESTINATION — a companion runnable, a dock
    /// panel, or a top-level sidebar-button target? The same three keys Core's own
    /// `manifest_declares_destination` reads, so one rule decides app-vs-plugin for
    /// a community repo and for a built-in.
    ///
    /// Used for ONE thing: breaking the tie when a repo carries BOTH topics (see
    /// [`resolve_dual_topic_classification`]). A single-topic repo is classified by
    /// its topic, full stop — this never overrides a publisher who tagged one topic.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    has_destination: bool,
}

impl RepoManifestDisplay {
    /// Lift the display allowlist off a loosely-parsed third-party manifest.
    /// `None` when the manifest declares nothing worth showing, so an empty `{}`
    /// at the repo root is remembered as "probed, nothing there" rather than as a
    /// hydrated record whose every field is empty.
    pub(crate) fn from_manifest(manifest: &Value) -> Option<Self> {
        let obj = manifest.as_object()?;
        // `icon` falls back to the Companion surface's glyph, which is how an app
        // authors its icon — the same fallback `plugin_manifest_to_entry` applies.
        let icon = manifest_interface_value(obj, "composerIcon", &["icon"])
            .and_then(Value::as_str)
            .or_else(|| {
                obj.get("companion")
                    .and_then(|companion| companion.get("icon"))
                    .and_then(Value::as_str)
            })
            .and_then(scrub_icon_id);
        let out = Self {
            name: manifest_text(obj, "displayName", &["name"], MAX_NAME_CHARS),
            icon,
            icon_url: manifest_interface_value(obj, "logo", &["iconUrl", "icon_url"])
                .and_then(Value::as_str)
                .and_then(sanitize_url),
            description: manifest_text(
                obj,
                "longDescription",
                &["description"],
                MAX_DESCRIPTION_CHARS,
            ),
            version: obj
                .get("version")
                .and_then(Value::as_str)
                .and_then(scrub_version),
            stability: obj
                .get("stability")
                .and_then(Value::as_str)
                .and_then(|value| scrub_text(value, MAX_NAME_CHARS))
                .map(|value| value.to_ascii_lowercase()),
            tagline: manifest_text(obj, "shortDescription", &["tagline"], MAX_TAGLINE_CHARS),
            category: manifest_text(obj, "category", &["category"], MAX_CATEGORY_CHARS),
            // Both spellings, because a manifest is authored in camelCase
            // (`iconDither`) and read back from this cache in snake_case.
            icon_dither: obj
                .get("iconDither")
                .or_else(|| obj.get("icon_dither"))
                .and_then(scrub_icon_dither),
            icon_background: obj
                .get("iconBackground")
                .or_else(|| obj.get("icon_background"))
                .and_then(|v| v.as_str())
                .and_then(scrub_css_color),
            banner: manifest_interface_value(obj, "banner", &["banner"]).and_then(scrub_banner),
            homepage: manifest_url(obj, "websiteURL", &["homepage"]),
            repository_url: obj
                .get("repository")
                .or_else(|| obj.get("repositoryUrl"))
                .and_then(Value::as_str)
                .and_then(sanitize_url),
            author: scrub_author(obj.get("author")),
            developer: manifest_text(obj, "developerName", &["developer"], MAX_NAME_CHARS).or_else(
                || {
                    obj.get("author")
                        .and_then(author_developer_string)
                        .and_then(|value| scrub_text(&value, MAX_NAME_CHARS))
                },
            ),
            license: manifest_text(obj, "license", &["license"], MAX_NAME_CHARS),
            keywords: scrub_string_list(
                manifest_interface_value(obj, "keywords", &["keywords"]),
                MAX_KEYWORDS,
                MAX_NAME_CHARS,
            ),
            tags: scrub_string_list(
                manifest_interface_value(obj, "tags", &["tags"]),
                MAX_TAGS,
                MAX_NAME_CHARS,
            ),
            screenshots: scrub_url_list(manifest_interface_value(
                obj,
                "screenshots",
                &["screenshots"],
            )),
            example_prompts: scrub_string_list(
                manifest_interface_value(
                    obj,
                    "defaultPrompt",
                    &["examplePrompts", "defaultPrompt"],
                ),
                MAX_EXAMPLE_PROMPTS,
                MAX_DESCRIPTION_CHARS,
            ),
            capabilities: scrub_string_list(
                manifest_interface_value(obj, "capabilities", &["capabilities"]),
                MAX_CAPABILITIES,
                MAX_CAPABILITY_CHARS,
            ),
            privacy_policy_url: manifest_url(
                obj,
                "privacyPolicyURL",
                &["privacyPolicyUrl", "privacy_policy_url"],
            ),
            terms_of_service_url: manifest_url(
                obj,
                "termsOfServiceURL",
                &["termsOfServiceUrl", "terms_of_service_url"],
            ),
            external: obj
                .get("external")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            layers: scrub_layers(obj.get("provides")),
            surface_support: (obj.contains_key("surfaces") || obj.contains_key("targets"))
                .then(|| super::manifest_surface::project_surface_support(manifest))
                .unwrap_or_default(),
            has_destination: manifest_claims_destination(obj),
        };
        (out != Self::default()).then_some(out)
    }
}

/// A community collection: a `ryu-marketplace` repo's parsed package-folder
/// entries. The legacy `marketplace.json` shape is retained only as a fallback.
///
/// Identity rules mirror [`RepoManifestDisplay`]'s: the marketplace supplies the
/// heading NAME, GitHub supplies `owner` / `repo` (the identity of who published
/// it). Everything is display-only and scrubbed — an unsigned source must never
/// move code or permission claims.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct GithubMarketplace {
    /// The marketplace's display name for its sub-heading: package metadata
    /// `name`, falling back to the repo slug. Scrub-bounded.
    name: String,
    /// The parsed plugin entries. `from_manifest` returns `None` when nothing
    /// survives, so `Some` here always has at least one entry.
    entries: Vec<GithubMarketplaceEntry>,
}

/// One plugin listing declared by a community marketplace's `marketplace.json`.
///
/// Every field is scrubbed exactly like [`RepoManifestDisplay`] because it comes
/// from the same class of untrusted input. The load-bearing field is
/// `source_repo` — where the plugin actually lives — because it drives the
/// link-out CTA / install-from-URL for an unreviewed listing.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct GithubMarketplaceEntry {
    /// The entry's `name` (kebab-case identity within the marketplace). The
    /// stable part of the synthetic `ghmp:` id; never the card's title on its
    /// own (`display_name` wins for that).
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tagline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_dither: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    banner: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    surface_support: Vec<Value>,
    /// True when the entry ships a Companion UI surface — classified as an "app".
    #[serde(default)]
    has_companion: bool,
    /// The plugin's OWN repository as an https URL (`source_repo`), or `None`
    /// when `source` was absent or did not resolve to a GitHub repo / http(s) URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    /// Folder path inside the collection. This is the package identity source;
    /// it replaces the legacy marketplace.json entry pointer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package_path: Option<String>,
}

impl GithubMarketplace {
    /// Parse a loosely-typed `marketplace.json` into the display allowlist.
    /// `None` when the manifest declares no entries worth showing (which also
    /// covers a repo that tags the topic but has not added a manifest yet — it
    /// degrades to a single repo listing).
    fn from_manifest(manifest: &Value, repo_full_name: &str) -> Option<Self> {
        let obj = manifest.as_object()?;
        let text = |key: &str, max: usize| {
            obj.get(key)
                .and_then(|v| v.as_str())
                .and_then(|s| scrub_text(s, max))
        };
        // `displayName` is the pretty form; `name` is the kebab-case identity.
        // The repo slug is the fallback so an unnamed marketplace still reads as
        // who owns it.
        let name = text("displayName", MAX_NAME_CHARS)
            .or_else(|| text("name", MAX_NAME_CHARS))
            .unwrap_or_else(|| repo_full_name.to_string());
        let mut entries = Vec::new();
        if let Some(plugins) = obj.get("plugins").and_then(|v| v.as_array()) {
            for plugin in plugins {
                if let Some(entry) = GithubMarketplaceEntry::from_manifest(plugin) {
                    entries.push(entry);
                }
            }
        }
        (!entries.is_empty()).then_some(Self { name, entries })
    }
}

impl GithubMarketplaceEntry {
    /// Lift the display allowlist off one `plugins[]` entry. `None` when the
    /// entry declares no `name` — the one field the synthetic id cannot do
    /// without.
    fn from_manifest(plugin: &Value) -> Option<Self> {
        let obj = plugin.as_object()?;
        let text = |key: &str, max: usize| {
            obj.get(key)
                .and_then(|v| v.as_str())
                .and_then(|s| scrub_text(s, max))
        };
        let name = text("name", MAX_NAME_CHARS)?;
        let display_name =
            text("displayName", MAX_NAME_CHARS).or_else(|| text("display_name", MAX_NAME_CHARS));
        let out = Self {
            name,
            display_name,
            description: text("description", MAX_DESCRIPTION_CHARS),
            category: text("category", MAX_CATEGORY_CHARS),
            version: obj
                .get("version")
                .and_then(|v| v.as_str())
                .and_then(scrub_version),
            tagline: text("tagline", MAX_TAGLINE_CHARS),
            icon: obj
                .get("icon")
                .and_then(|v| v.as_str())
                .and_then(scrub_icon_id),
            icon_url: obj
                .get("iconUrl")
                .or_else(|| obj.get("icon_url"))
                .and_then(|v| v.as_str())
                .and_then(sanitize_url),
            // Both spellings on the way in, like `RepoManifestDisplay` — a
            // manifest is authored in camelCase and read back in snake_case.
            icon_dither: obj
                .get("iconDither")
                .or_else(|| obj.get("icon_dither"))
                .and_then(scrub_icon_dither),
            icon_background: obj
                .get("iconBackground")
                .or_else(|| obj.get("icon_background"))
                .and_then(|v| v.as_str())
                .and_then(scrub_css_color),
            banner: obj.get("banner").and_then(scrub_banner),
            surface_support: super::manifest_surface::project_surface_support(plugin),
            has_companion: obj
                .get("hasCompanion")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            source_repo: resolve_entry_source(obj.get("source")),
            homepage: obj
                .get("homepage")
                .and_then(|v| v.as_str())
                .and_then(sanitize_url),
            tags: scrub_string_list(obj.get("tags"), MAX_TAGS, MAX_NAME_CHARS),
            package_path: None,
        };
        (out != Self::default()).then_some(out)
    }

    /// Lift a portable `ryu.package.json` into the same display-only entry.
    /// Manifest code, permissions, and release bytes never enter this card.
    fn from_package_manifest(
        manifest: &Value,
        package_path: String,
        repo_url: String,
    ) -> Option<Self> {
        let obj = manifest.as_object()?;
        let metadata = obj.get("metadata").and_then(Value::as_object);
        let text = |key: &str, max: usize| {
            obj.get(key)
                .or_else(|| metadata.and_then(|m| m.get(key)))
                .and_then(Value::as_str)
                .and_then(|s| scrub_text(s, max))
        };
        let fallback_name = package_path
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("package");
        let name = obj
            .get("id")
            .and_then(Value::as_str)
            .and_then(|value| scrub_text(value, MAX_NAME_CHARS))
            .unwrap_or_else(|| fallback_name.to_string());
        let display_name = text("name", MAX_NAME_CHARS);
        let kind = obj.get("kind").and_then(Value::as_str).unwrap_or("plugin");
        let out = Self {
            name,
            display_name,
            description: text("description", MAX_DESCRIPTION_CHARS),
            category: text("category", MAX_CATEGORY_CHARS),
            version: obj
                .get("version")
                .and_then(Value::as_str)
                .and_then(scrub_version),
            tagline: text("tagline", MAX_TAGLINE_CHARS),
            icon: text("icon", MAX_ICON_ID_CHARS).and_then(|value| scrub_icon_id(&value)),
            icon_url: text("iconUrl", MAX_URL_CHARS).and_then(|value| sanitize_url(&value)),
            icon_dither: None,
            icon_background: None,
            banner: None,
            surface_support: Vec::new(),
            has_companion: kind == "app",
            source_repo: Some(repo_url),
            homepage: text("homepage", MAX_URL_CHARS).and_then(|value| sanitize_url(&value)),
            tags: Vec::new(),
            package_path: Some(package_path),
        };
        (out != Self::default()).then_some(out)
    }
}

/// The repo a marketplace entry actually lives in, reduced to an https URL for
/// the link-out CTA. `source` may be a bare `owner/repo` slug, a git URL, or the
/// Claude "source object" form (`{ "repo": "owner/repo" }` / `{ "url": … }`).
/// Anything that is not a GitHub repo or an http(s) URL is dropped.
fn resolve_entry_source(value: Option<&Value>) -> Option<String> {
    let raw = match value? {
        Value::String(s) => Some(s.as_str()),
        Value::Object(map) => map
            .get("repo")
            .or_else(|| map.get("url"))
            .and_then(|v| v.as_str()),
        _ => None,
    }?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // A bare `owner/repo` slug (or a github URL / SSH form) → canonical URL.
    if let Some((owner, repo)) = super::split_github_repo(trimmed) {
        return Some(format!("https://github.com/{owner}/{repo}"));
    }
    // Otherwise only an explicit http(s) URL travels.
    sanitize_url(trimmed)
}

/// Strip control characters (a newline in a card title reflows the whole row) and
/// bound the length. `None` for a string that is empty once scrubbed.
pub(crate) fn scrub_text(value: &str, max_chars: usize) -> Option<String> {
    let cleaned: String = value.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect())
}

/// An Icon-primitive glyph id from an untrusted manifest.
///
/// The client's `iconToUrl` interpolates this id into an Iconify URL path, and
/// returns a `data:` / `http(s):` id UNCHANGED — so an unconstrained string from a
/// community repo would reach a CSS `mask-image` verbatim. Restricting the
/// alphabet to what a real id uses (`lucide:heart`, `activity-03`,
/// `svgl:brave|dark`) rejects every URL and `data:` payload before it leaves Core,
/// and costs a publisher nothing: a raster logo belongs in `iconUrl`, which
/// [`sanitize_url`] already allowlists to http(s).
pub(crate) fn scrub_icon_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_ICON_ID_CHARS {
        return None;
    }
    trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.' | '|'))
        .then(|| trimmed.to_string())
}

/// A CSS colour from an untrusted manifest, for the icon square's flat background.
///
/// This one is stricter than its siblings because it lands somewhere they do not:
/// `AppIcon` puts it in an inline `style={{ background }}`, i.e. straight into CSS.
/// So the alphabet is closed rather than merely bounded — a hex literal, a bare
/// CSS colour keyword, or one colour function (`rgb`/`hsl`/`oklch`/…) whose body is
/// digits, units and separators. Everything else, `url(…)`/`expression(…)`/`;`/
/// comment syntax included, is dropped rather than sanitized: a card that renders
/// the publisher's colour is worth having, and one that renders their CSS is not.
pub(crate) fn scrub_css_color(value: &str) -> Option<String> {
    const MAX_CSS_COLOR_CHARS: usize = 64;
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_CSS_COLOR_CHARS {
        return None;
    }
    // `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`.
    if let Some(hex) = trimmed.strip_prefix('#') {
        let ok = matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
        return ok.then(|| trimmed.to_string());
    }
    // A bare keyword (`rebeccapurple`, `transparent`).
    if trimmed.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some(trimmed.to_string());
    }
    // One colour function, and nothing after its closing paren — so a value can
    // never carry a second declaration.
    let (name, rest) = trimmed.split_once('(')?;
    let known = matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "rgb" | "rgba" | "hsl" | "hsla" | "hwb" | "lab" | "lch" | "oklab" | "oklch"
    );
    let body = rest.strip_suffix(')')?;
    let body_ok = body
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | ' ' | '%' | '/' | '+' | '-'));
    (known && body_ok).then(|| trimmed.to_string())
}

/// The dithered-gradient spec from an untrusted manifest, rebuilt field by field.
///
/// Never passed through as opaque JSON: the spec reaches `DitherGradient`, which
/// paints a real gradient, so an unvalidated object from an unsigned repo is a
/// styling channel. `from`/`to` are a hue number (0–360) or a palette-colour NAME
/// (the client's `isDitherColor` is the authority on which names exist and falls
/// back on anything else — the bound here just keeps the alphabet closed);
/// `direction` is one of the four the kit accepts. Returns `None` unless at least
/// `from` survives, since the component needs it.
pub(crate) fn scrub_icon_dither(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let color = |key: &str| -> Option<Value> {
        match obj.get(key)? {
            Value::Number(n) => n
                .as_f64()
                .filter(|h| h.is_finite() && (0.0..=360.0).contains(h))
                .map(|h| Value::from(h)),
            Value::String(s) => {
                let t = s.trim();
                (!t.is_empty()
                    && t.len() <= 32
                    && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
                .then(|| Value::String(t.to_ascii_lowercase()))
            }
            _ => None,
        }
    };
    let from = color("from")?;
    let mut out = serde_json::Map::new();
    out.insert("from".to_string(), from);
    if let Some(to) = color("to") {
        out.insert("to".to_string(), to);
    }
    if let Some(direction) = obj
        .get("direction")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| matches!(s.as_str(), "up" | "down" | "left" | "right"))
    {
        out.insert("direction".to_string(), Value::String(direction));
    }
    Some(Value::Object(out))
}

/// The styles a banner may declare. `animated-gradient` is the only one that
/// selects a RENDERER (the WebGL field) rather than describing which key the
/// author meant, which is why an unknown token is dropped rather than passed on:
/// a card must not be able to name a renderer this build has never heard of.
const BANNER_STYLES: [&str; 5] = ["gradient", "animated-gradient", "dither", "flat", "image"];
/// The six named looks the animated gradient ships. Anything else falls back to
/// the default on the client, so an unknown preset costs a look, not a banner.
const BANNER_GRADIENT_PRESETS: [&str; 6] = ["lava", "prism", "plasma", "pulse", "vortex", "mist"];
/// The base patterns the gradient warps over.
const BANNER_GRADIENT_SHAPES: [&str; 3] = ["checks", "stripes", "edge"];
/// A ramp is a handful of stops; a manifest declaring hundreds is not a banner.
const MAX_BANNER_COLORS: usize = 8;

/// A finite number from an untrusted manifest, clamped into range.
///
/// The clamp is the point. These values become shader uniforms on the client, and
/// `swirlIterations: 1e6` or `scale: 1e9` is a loop the GPU runs — a frozen tab,
/// not a bad-looking listing. The client clamps again on paint (a banner can also
/// arrive from a source that never came through here); this is the near end of
/// that same guard, so a hostile value is never even cached.
fn scrub_banner_number(value: Option<&Value>, min: f64, max: f64) -> Option<Value> {
    let n = value?.as_f64()?;
    n.is_finite().then(|| Value::from(n.clamp(min, max)))
}

/// One closed-set token, lowercased, or `None`.
fn scrub_enum(value: Option<&Value>, allowed: &[&str]) -> Option<Value> {
    let token = value?.as_str()?.trim().to_ascii_lowercase();
    allowed
        .contains(&token.as_str())
        .then(|| Value::String(token))
}

/// The animated-gradient spec inside a banner, rebuilt field by field.
///
/// Keys are emitted in the camelCase the client's `CatalogBannerGradient`
/// declares (`shapeSize`, `swirlIterations`, `color1`) — this JSON is read by the
/// render layer, not by serde, so the snake_case spelling a Rust struct would
/// produce would arrive and paint nothing.
fn scrub_banner_gradient(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let mut out = serde_json::Map::new();
    if let Some(preset) = scrub_enum(obj.get("preset"), &BANNER_GRADIENT_PRESETS) {
        out.insert("preset".to_string(), preset);
    }
    if let Some(shape) = scrub_enum(obj.get("shape"), &BANNER_GRADIENT_SHAPES) {
        out.insert("shape".to_string(), shape);
    }
    for key in ["color1", "color2", "color3"] {
        if let Some(color) = obj
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(scrub_css_color)
        {
            out.insert(key.to_string(), Value::String(color));
        }
    }
    // The 0-100 slider form the component's own docs use, which is what an author
    // copying those docs writes.
    for key in [
        "distortion",
        "proportion",
        "shapeSize",
        "softness",
        "speed",
        "swirl",
    ] {
        if let Some(n) = scrub_banner_number(obj.get(key), 0.0, 100.0) {
            out.insert(key.to_string(), n);
        }
    }
    if let Some(n) = scrub_banner_number(obj.get("rotation"), 0.0, 360.0) {
        out.insert("rotation".to_string(), n);
    }
    if let Some(n) = scrub_banner_number(obj.get("offset"), -100.0, 100.0) {
        out.insert("offset".to_string(), n);
    }
    if let Some(n) = scrub_banner_number(obj.get("scale"), 0.01, 4.0) {
        out.insert("scale".to_string(), n);
    }
    if let Some(n) = scrub_banner_number(obj.get("swirlIterations"), 0.0, 20.0) {
        out.insert("swirlIterations".to_string(), n);
    }
    (!out.is_empty()).then(|| Value::Object(out))
}

/// The hero banner from an untrusted manifest, rebuilt key by key.
///
/// Community listings used to lose this entirely: every icon field was lifted and
/// `banner` was not, so a repo could declare a hero and only ever get the wash
/// derived from its icon. It is presentation only — it changes how the band is
/// painted, never what the card claims about itself — and it is the same key a
/// first-party manifest declares, so one shape serves both.
///
/// TWO NARROWINGS relative to what a first-party manifest may declare, both
/// deliberate:
///
/// * `background` goes through [`scrub_css_color`], so a community banner may
///   name a COLOUR but not an arbitrary CSS background. The client's own guard is
///   a blocklist of fetching functions, which is right for a signed manifest;
///   from an unsigned repo an allowlist is cheap and a `linear-gradient` can be
///   expressed with `colors` instead.
/// * `colors` is all-or-nothing. The stops are joined into ONE ramp downstream, so
///   keeping the survivors of a rejected palette would paint a gradient the author
///   never wrote — the same rule the render layer applies.
pub(crate) fn scrub_banner(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let mut out = serde_json::Map::new();
    if let Some(style) = scrub_enum(obj.get("style"), &BANNER_STYLES) {
        out.insert("style".to_string(), style);
    }
    if let Some(bg) = obj
        .get("background")
        .and_then(|v| v.as_str())
        .and_then(scrub_css_color)
    {
        out.insert("background".to_string(), Value::String(bg));
    }
    if let Some(stops) = obj.get("colors").and_then(|v| v.as_array()) {
        let scrubbed: Vec<Value> = stops
            .iter()
            .filter_map(|c| c.as_str())
            .filter_map(scrub_css_color)
            .map(Value::String)
            .collect();
        if !stops.is_empty() && stops.len() <= MAX_BANNER_COLORS && scrubbed.len() == stops.len() {
            out.insert("colors".to_string(), Value::Array(scrubbed));
        }
    }
    // Both spellings on the way IN, camelCase on the way out — the same
    // asymmetry `iconDither` already has, and for the same reason: a manifest is
    // authored in camelCase and this cache is read back in snake_case.
    if let Some(url) = obj
        .get("imageUrl")
        .or_else(|| obj.get("image_url"))
        .and_then(|v| v.as_str())
        .and_then(sanitize_url)
    {
        out.insert("imageUrl".to_string(), Value::String(url));
    }
    if let Some(seed) = scrub_banner_number(obj.get("seed"), 0.0, f64::from(u32::MAX)) {
        out.insert("seed".to_string(), seed);
    }
    if let Some(noise) = obj.get("noise").and_then(|v| v.as_object()) {
        let mut grain = serde_json::Map::new();
        if let Some(opacity) = scrub_banner_number(noise.get("opacity"), 0.0, 100.0) {
            grain.insert("opacity".to_string(), opacity);
        }
        if let Some(scale) = scrub_banner_number(noise.get("scale"), 0.1, 10.0) {
            grain.insert("scale".to_string(), scale);
        }
        if !grain.is_empty() {
            out.insert("noise".to_string(), Value::Object(grain));
        }
    }
    if let Some(gradient) = obj.get("gradient").and_then(scrub_banner_gradient) {
        out.insert("gradient".to_string(), gradient);
    }
    (!out.is_empty()).then(|| Value::Object(out))
}

/// Does a LOOSELY-PARSED third-party manifest claim a UI destination?
///
/// The same three keys Core's typed `manifest_declares_destination` reads — a
/// `companion` runnable, a non-empty `contributes.dock_panels`, or a top-level
/// `contributes.sidebar_buttons[].target` — restated against raw JSON because a
/// community manifest is never deserialized into `PluginManifest` (one missing
/// required field on any typed member would drop the whole thing, and this path
/// must survive a manifest that is merely sloppy). The route test itself is not
/// re-implemented: it is [`crate::server::is_top_level_route`].
fn manifest_claims_destination(obj: &serde_json::Map<String, Value>) -> bool {
    let has_companion = obj
        .get("runnables")
        .and_then(Value::as_array)
        .is_some_and(|rs| {
            rs.iter()
                .any(|r| r.get("kind").and_then(Value::as_str) == Some("companion"))
        });
    if has_companion {
        return true;
    }
    let Some(contributes) = obj.get("contributes") else {
        return false;
    };
    let has_dock_panel = contributes
        .get("dock_panels")
        .and_then(Value::as_array)
        .is_some_and(|panels| !panels.is_empty());
    if has_dock_panel {
        return true;
    }
    contributes
        .get("sidebar_buttons")
        .and_then(Value::as_array)
        .is_some_and(|buttons| {
            buttons.iter().any(|b| {
                b.get("target")
                    .and_then(Value::as_str)
                    .is_some_and(crate::server::is_top_level_route)
            })
        })
}

/// A version string from an untrusted manifest — semver's alphabet only, so the
/// version field cannot smuggle markup or a URL onto the card.
pub(crate) fn scrub_version(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_VERSION_CHARS {
        return None;
    }
    trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .then(|| trimmed.to_string())
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubSearchEnvelope {
    #[serde(default)]
    items: Vec<GithubRepoItem>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubRepoItem {
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    stargazers_count: u64,
    #[serde(default)]
    owner: GithubOwner,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    license: Option<GithubLicense>,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubOwner {
    #[serde(default)]
    login: String,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubLicense {
    #[serde(default)]
    spdx_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// Built-in GitHub-topic discovery source for the Plugin/App catalog.
///
/// Not `#[derive(Debug)]` on purpose: it holds a bearer token, and a derived
/// `Debug` would leak it through any `tracing` line that prints the enclosing
/// `Source`. See the hand-written redacting impl below.
#[derive(Clone)]
pub struct GithubTopicSource {
    pub id: String,
    pub display_name: String,
    /// API base override. `None` = the builtin `api.github.com`.
    pub api_base: Option<String>,
    /// BYOK personal access token. Seeded from env in [`Self::builtin`]; the route
    /// overrides it from the preferences store. Never logged, and only ever sent to
    /// the default host.
    pub token: Option<String>,
}

impl std::fmt::Debug for GithubTopicSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubTopicSource")
            .field("id", &self.id)
            .field("api_base", &self.api_base)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl GithubTopicSource {
    pub fn builtin() -> Self {
        Self {
            id: GITHUB_TOPIC_SOURCE_ID.to_string(),
            display_name: "GitHub (community)".to_string(),
            api_base: None,
            token: GITHUB_TOKEN_ENVS.iter().find_map(|key| {
                std::env::var(key)
                    .ok()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            }),
        }
    }

    fn resolve_api_base(&self) -> String {
        let base = self
            .api_base
            .clone()
            .filter(|u| !u.trim().is_empty())
            .or_else(|| {
                std::env::var(GITHUB_API_BASE_ENV)
                    .ok()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty())
            })
            .unwrap_or_else(|| GITHUB_API_BASE.to_string());
        base.trim_end_matches('/').to_string()
    }

    /// The token, **only** when talking to the default host. A custom base (a
    /// mirror, an enterprise host, an attacker-supplied env value) must never
    /// receive the user's PAT — the same strict-host rule Smithery's key follows.
    fn resolve_token(&self) -> Option<&str> {
        if self.resolve_api_base() != GITHUB_API_BASE {
            return None;
        }
        self.token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
    }

    fn topic(is_app: bool) -> String {
        let (env_key, default) = if is_app {
            (GITHUB_TOPIC_APP_ENV, GITHUB_TOPIC_APP)
        } else {
            (GITHUB_TOPIC_PLUGIN_ENV, GITHUB_TOPIC_PLUGIN)
        };
        std::env::var(env_key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| default.to_string())
    }

    /// The `ryu-marketplace` topic string, env-overridable like the other two.
    fn marketplace_topic() -> String {
        std::env::var(GITHUB_TOPIC_MARKETPLACE_ENV)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| GITHUB_TOPIC_MARKETPLACE.to_string())
    }

    fn cache_ttl() -> std::time::Duration {
        let secs = std::env::var(GITHUB_TOPIC_TTL_ENV)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s > 0)
            .unwrap_or(GITHUB_TOPIC_DEFAULT_TTL_SECS);
        std::time::Duration::from_secs(secs)
    }

    fn search_url(&self, topic: &str) -> String {
        format!(
            "{}/search/repositories?q={}&sort=stars&order=desc&per_page={}",
            self.resolve_api_base(),
            urlencoding::encode(&format!("topic:{topic}")),
            GITHUB_TOPIC_PER_PAGE,
        )
    }

    fn request_headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![
            (
                "Accept".to_string(),
                "application/vnd.github+json".to_string(),
            ),
            ("X-GitHub-Api-Version".to_string(), "2022-11-28".to_string()),
        ];
        if let Some(token) = self.resolve_token() {
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        headers
    }

    async fn fetch_topic(&self, is_app: bool) -> Result<Vec<GithubTopicRecord>> {
        let topic = Self::topic(is_app);
        let url = self.search_url(&topic);
        let bytes = crate::server::guarded_get_bytes_with_headers(&url, &self.request_headers())
            .await
            .map_err(|e| anyhow::anyhow!("fetching GitHub topic `{topic}`: {e}"))?;
        let envelope: GithubSearchEnvelope = serde_json::from_slice(&bytes)
            .map_err(|e| anyhow::anyhow!("parsing GitHub topic `{topic}` results: {e}"))?;
        Ok(envelope
            .items
            .iter()
            .filter_map(|item| repo_item_to_record(item, is_app))
            .collect())
    }

    /// Fetch the `ryu-marketplace` topic — the community MARKETPLACE population.
    /// One extra Search call in the same rate-limit budget as the two below.
    async fn fetch_topic_marketplace(&self) -> Result<Vec<GithubTopicRecord>> {
        let topic = Self::marketplace_topic();
        let url = self.search_url(&topic);
        let bytes = crate::server::guarded_get_bytes_with_headers(&url, &self.request_headers())
            .await
            .map_err(|e| anyhow::anyhow!("fetching GitHub topic `{topic}`: {e}"))?;
        let envelope: GithubSearchEnvelope = serde_json::from_slice(&bytes)
            .map_err(|e| anyhow::anyhow!("parsing GitHub topic `{topic}` results: {e}"))?;
        Ok(envelope
            .items
            .iter()
            .filter_map(repo_item_to_marketplace_record)
            .collect())
    }

    async fn fetch_records(&self, previous: Option<&GithubTopicCache>) -> Result<GithubTopicCache> {
        // Apps first, then plugins, so a repo carrying BOTH topics survives the
        // first-writer-wins dedupe below as ONE row. Which tab that row belongs in
        // is then decided by evidence rather than by this ordering — see
        // `resolve_dual_topic_classification`, which runs after hydration because
        // the evidence is the repo's own manifest.
        let apps = self.fetch_topic(true).await?;
        let plugins = self.fetch_topic(false).await?;
        let marketplaces = self.fetch_topic_marketplace().await?;
        let dual_topic = dual_topic_names(&apps, &plugins);
        // A repo tagged `ryu-marketplace` (often ALSO `ryu-app`/`ryu-plugin` for
        // discoverability) is a COLLECTION, not a single listing: the marketplace
        // classification wins, so its entries render grouped under the marketplace
        // heading instead of the repo appearing twice — once expanded and once as a
        // bare single-plugin row.
        let mut records =
            merge_marketplace_records(dedupe_records(vec![apps, plugins]), marketplaces);
        carry_manifests(&mut records, previous.map(|c| c.records.as_slice()));
        self.hydrate_manifests(&mut records).await;
        self.hydrate_marketplaces(&mut records).await;
        resolve_dual_topic_classification(&mut records, &dual_topic);
        Ok(GithubTopicCache {
            fetched_at: std::time::Instant::now(),
            records,
            source_url: self.resolve_api_base(),
            stale: false,
            note: None,
        })
    }

    /// Fill in each record's [`RepoManifestDisplay`] from the repo's own
    /// `manifest.json`, so a card is titled and iconed the way its author declared
    /// rather than by GitHub's repo slug and owner avatar.
    ///
    /// This is affordable only because of three properties, all load-bearing:
    ///
    /// 1. **`raw.githubusercontent.com` is a CDN**, not the Search API — these
    ///    fetches spend none of the 10 req/min search budget the rest of this
    ///    source is careful with.
    /// 2. **Results are remembered across refreshes**, positive AND negative
    ///    ([`carry_manifests`] + [`MANIFEST_PROBE_TTL_SECS`]). Most listings carry
    ///    no manifest, and a miss costs five fetches; without the negative cache
    ///    the steady-state cost would never amortize.
    /// 3. **The pass is deadline-bounded** ([`MANIFEST_HYDRATE_DEADLINE`]). What it
    ///    does not reach keeps its repo-derived presentation and `manifest_probed_at:
    ///    0`, so the next refresh retries it — a slow GitHub degrades the *cards*,
    ///    never the page.
    async fn hydrate_manifests(&self, records: &mut [GithubTopicRecord]) {
        let now = unix_now();
        let pending: Vec<usize> = records
            .iter()
            .enumerate()
            .filter(|(_, r)| r.manifest_probe_is_due(now))
            .map(|(i, _)| i)
            .collect();
        if pending.is_empty() {
            return;
        }
        let probe = async {
            for chunk in pending.chunks(MANIFEST_HYDRATE_CONCURRENCY) {
                // Cloned up front so the borrow of `records` ends before the await —
                // the write-back below needs it mutably.
                let batch: Vec<(usize, GithubTopicRecord)> =
                    chunk.iter().map(|&i| (i, records[i].clone())).collect();
                let probed = futures_util::future::join_all(batch.into_iter().map(
                    |(i, record)| async move { (i, self.fetch_repo_manifest(&record).await) },
                ))
                .await;
                for (i, hit) in probed {
                    records[i].manifest = hit
                        .as_ref()
                        .and_then(|(manifest, _)| RepoManifestDisplay::from_manifest(manifest));
                    // Stamped on a MISS too — that is the negative cache.
                    records[i].manifest_probed_at = now;
                }
            }
        };
        if tokio::time::timeout(MANIFEST_HYDRATE_DEADLINE, probe)
            .await
            .is_err()
        {
            tracing::debug!(
                pending = pending.len(),
                "github-topic: manifest hydration hit its deadline; unhydrated listings retry on the next refresh"
            );
        }
    }

    /// Fill in each collection record's [`GithubMarketplace`] from package folders,
    /// so its entries can render grouped under the collection's name. Same cost
    /// story as [`Self::hydrate_manifests`]: raw CDN fetches, a positive/negative
    /// cross-refresh memory, and a deadline bound — what it does not reach
    /// degrades to a single repo listing on the next card.
    async fn hydrate_marketplaces(&self, records: &mut [GithubTopicRecord]) {
        let now = unix_now();
        let pending: Vec<usize> = records
            .iter()
            .enumerate()
            .filter(|(_, r)| r.is_marketplace && r.marketplace_probe_is_due(now))
            .map(|(i, _)| i)
            .collect();
        if pending.is_empty() {
            return;
        }
        let probe = async {
            for chunk in pending.chunks(MANIFEST_HYDRATE_CONCURRENCY) {
                let batch: Vec<(usize, GithubTopicRecord)> =
                    chunk.iter().map(|&i| (i, records[i].clone())).collect();
                let probed = futures_util::future::join_all(batch.into_iter().map(
                    |(i, record)| async move { (i, self.fetch_repo_marketplace(&record).await) },
                ))
                .await;
                for (i, hit) in probed {
                    records[i].marketplace = hit;
                    // Stamped on a MISS too — that is the negative cache.
                    records[i].marketplace_probed_at = now;
                }
            }
        };
        if tokio::time::timeout(MANIFEST_HYDRATE_DEADLINE, probe)
            .await
            .is_err()
        {
            tracing::debug!(
                pending = pending.len(),
                "github-topic: marketplace hydration hit its deadline; unhydrated marketplaces retry on the next refresh"
            );
        }
    }

    fn disk_cache_path() -> std::path::PathBuf {
        crate::paths::cache_dir()
            .join("github-topic")
            .join("topics.json")
    }

    fn read_disk_cache() -> Option<GithubTopicCache> {
        let raw = std::fs::read_to_string(Self::disk_cache_path()).ok()?;
        let envelope: DiskCacheEnvelope = serde_json::from_str(&raw).ok()?;
        if envelope.records.is_empty() {
            return None;
        }
        Some(GithubTopicCache {
            fetched_at: std::time::Instant::now(),
            records: envelope.records,
            source_url: envelope.source_url,
            stale: true,
            note: Some(OFFLINE_NOTE.to_string()),
        })
    }

    fn write_disk_cache(cache: &GithubTopicCache) {
        let path = Self::disk_cache_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let envelope = DiskCacheEnvelope {
            fetched_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            records: cache.records.clone(),
            source_url: cache.source_url.clone(),
        };
        if let Ok(json) = serde_json::to_string(&envelope) {
            let _ = std::fs::write(path, json);
        }
    }

    /// Cached records with **graceful degradation**: inside the TTL the warm copy is
    /// returned; on a refresh failure the last-good copy is served past its TTL
    /// (flagged `stale`, with a human note) rather than blanking the section. Only a
    /// process that has never fetched successfully — and has no disk copy — errors.
    async fn records(&self) -> Result<GithubTopicCache> {
        let lock = GITHUB_TOPIC_CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
        let mut guard = lock.lock().await;
        if let Some(cache) = guard.as_ref() {
            if !cache.stale && cache.fetched_at.elapsed() < Self::cache_ttl() {
                return Ok(cache.clone());
            }
        }
        // The warm copy is handed to the refresh so its already-probed manifests
        // (hits AND misses) carry over instead of being re-fetched.
        match self.fetch_records(guard.as_ref()).await {
            Ok(cache) => {
                Self::write_disk_cache(&cache);
                *guard = Some(cache.clone());
                Ok(cache)
            }
            Err(err) => {
                // Last-good wins over an error: an unreachable/rate-limited GitHub
                // must degrade to a slightly-stale list, never to an empty store.
                if let Some(cache) = guard.as_ref() {
                    let mut stale = cache.clone();
                    stale.stale = true;
                    stale.note = Some(stale_note(&err.to_string()));
                    return Ok(stale);
                }
                if let Some(mut cache) = Self::read_disk_cache() {
                    cache.note = Some(stale_note(&err.to_string()));
                    *guard = Some(cache.clone());
                    return Ok(cache);
                }
                Err(err)
            }
        }
    }

    fn wrap_items(
        &self,
        items: Vec<Value>,
        source_url: &str,
        note: Option<&str>,
        next_cursor: Option<String>,
    ) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("items".to_string(), Value::Array(items));
        obj.insert(
            "next_cursor".to_string(),
            next_cursor.map_or(Value::Null, Value::String),
        );
        obj.insert(
            "source_url".to_string(),
            Value::String(source_url.to_string()),
        );
        obj.insert(
            "cache_ttl_seconds".to_string(),
            Value::Number(Self::cache_ttl().as_secs().into()),
        );
        if let Some(note) = note {
            obj.insert("note".to_string(), Value::String(note.to_string()));
        }
        Value::Object(obj)
    }

    /// Best-effort manifest enrichment over `raw.githubusercontent.com` (a CDN — not
    /// on the Search API's rate-limit budget). Returns `(manifest_value, raw_url)`.
    async fn fetch_repo_manifest(&self, record: &GithubTopicRecord) -> Option<(Value, String)> {
        fetch_repo_manifest_for(&record.owner, &record.repo).await
    }

    /// Best-effort portable-package enrichment for a `ryu-marketplace` repo.
    /// The Git tree is the collection index: every folder containing
    /// `ryu.package.json` becomes one card. No generated marketplace.json is
    /// consulted on the new path.
    async fn fetch_repo_marketplace(
        &self,
        record: &GithubTopicRecord,
    ) -> Option<GithubMarketplace> {
        let tree_url = format!(
            "{}/repos/{}/git/trees/HEAD?recursive=1",
            self.resolve_api_base(),
            record.full_name
        );
        if let Ok(bytes) =
            crate::server::guarded_get_bytes_with_headers(&tree_url, &self.request_headers()).await
        {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                let mut entries = Vec::new();
                if let Some(tree) = value.get("tree").and_then(Value::as_array) {
                    for path in tree
                        .iter()
                        .filter_map(|entry| {
                            let obj = entry.as_object()?;
                            let path = obj.get("path")?.as_str()?;
                            (obj.get("type").and_then(Value::as_str) == Some("blob")
                                && (path == PACKAGE_MANIFEST_FILE
                                    || path.ends_with(&format!("/{PACKAGE_MANIFEST_FILE}"))))
                            .then_some(path.to_string())
                        })
                        .take(200)
                    {
                        let package_path = path
                            .strip_suffix(&format!("/{PACKAGE_MANIFEST_FILE}"))
                            .or_else(|| path.strip_suffix(PACKAGE_MANIFEST_FILE))
                            .unwrap_or_default()
                            .to_string();
                        let raw_url = format!(
                            "https://raw.githubusercontent.com/{}/{}/HEAD/{}",
                            record.owner, record.repo, path
                        );
                        let Ok(package_bytes) = crate::server::guarded_get_bytes(&raw_url).await
                        else {
                            continue;
                        };
                        let Ok(manifest) = serde_json::from_slice::<Value>(&package_bytes) else {
                            continue;
                        };
                        let package_url = if package_path.is_empty() {
                            format!("https://github.com/{}/tree/HEAD", record.full_name)
                        } else {
                            format!(
                                "https://github.com/{}/tree/HEAD/{}",
                                record.full_name, package_path
                            )
                        };
                        if let Some(entry) = GithubMarketplaceEntry::from_package_manifest(
                            &manifest,
                            package_path,
                            package_url,
                        ) {
                            entries.push(entry);
                        }
                    }
                }
                if !entries.is_empty() {
                    return Some(GithubMarketplace {
                        name: record.full_name.clone(),
                        entries,
                    });
                }
            }
        }
        // Compatibility fallback for old community repositories. This path is
        // intentionally read-only and is never generated or written by Ryu.
        for path in REPO_MARKETPLACE_PATHS {
            let url = format!(
                "https://raw.githubusercontent.com/{}/{}/HEAD/{}",
                record.owner, record.repo, path
            );
            let Ok(bytes) = crate::server::guarded_get_bytes(&url).await else {
                continue;
            };
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(marketplace) =
                    GithubMarketplace::from_manifest(&value, &record.full_name)
                {
                    return Some(marketplace);
                }
            }
        }
        None
    }
}

/// Probe one repo's manifest paths over the raw CDN. First hit wins; all missing
/// is not an error. Shared by the single-repo path and the marketplace-entry
/// detail path (which probes the entry's OWN plugin repo).
async fn fetch_repo_manifest_for(owner: &str, repo: &str) -> Option<(Value, String)> {
    for path in REPO_MANIFEST_PATHS {
        let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}");
        let Ok(bytes) = crate::server::guarded_get_bytes(&url).await else {
            continue;
        };
        // Parsed as a loose `Value`, never as `PluginManifest`: a strict parse
        // would reject a slightly-off third-party manifest and lose the card.
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if value.is_object() {
                return Some((value, url));
            }
        }
    }
    None
}

const OFFLINE_NOTE: &str = "Showing cached community listings — GitHub is unreachable.";

fn stale_note(err: &str) -> String {
    let lower = err.to_ascii_lowercase();
    if lower.contains("403") || lower.contains("429") {
        "GitHub rate limit reached — showing cached community listings.".to_string()
    } else {
        OFFLINE_NOTE.to_string()
    }
}

/// Normalize one GitHub repo hit. Archived repos are dropped (a dead listing is
/// worse than no listing); forks are kept but flagged, since topic discovery gets
/// noisy fast.
fn repo_item_to_record(item: &GithubRepoItem, is_app: bool) -> Option<GithubTopicRecord> {
    if item.archived {
        return None;
    }
    let full_name = item.full_name.trim();
    let (owner, repo) = match full_name.split_once('/') {
        Some((o, r)) if !o.is_empty() && !r.is_empty() => (o.to_string(), r.to_string()),
        _ => return None,
    };
    Some(GithubTopicRecord {
        id: format!("{GH_ID_PREFIX}{owner}/{repo}"),
        owner: owner.clone(),
        repo: repo.clone(),
        full_name: full_name.to_string(),
        description: item
            .description
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(truncate_description),
        stars: item.stargazers_count,
        html_url: sanitize_url(&item.html_url)
            .unwrap_or_else(|| format!("https://github.com/{full_name}")),
        avatar_url: item.owner.avatar_url.as_deref().and_then(sanitize_url),
        topics: item.topics.clone(),
        license: item
            .license
            .as_ref()
            .and_then(|l| l.spdx_id.clone().or_else(|| l.name.clone()))
            .filter(|l| !l.is_empty() && l != "NOASSERTION"),
        pushed_at: item.pushed_at.clone(),
        // Homepage is publisher-controlled, so it goes through the http(s)
        // allowlist before it can ever reach an `<a href>`.
        homepage: item.homepage.as_deref().and_then(sanitize_url),
        is_fork: item.fork,
        is_app,
        // Hydrated separately: a Search hit carries repo metadata only, never the
        // repo's manifest. See `hydrate_manifests`.
        manifest: None,
        manifest_probed_at: 0,
        is_marketplace: false,
        // Hydrated separately too: see `hydrate_marketplaces`.
        marketplace: None,
        marketplace_probed_at: 0,
    })
}

/// A record discovered under the `ryu-marketplace` topic — the same normalization
/// as [`repo_item_to_record`], flagged as a collection. App-vs-plugin is decided
/// per ENTRY (from its `hasCompanion`), not from the query: the marketplace topic
/// says nothing about it, and a repo can collect both kinds.
fn repo_item_to_marketplace_record(item: &GithubRepoItem) -> Option<GithubTopicRecord> {
    let mut record = repo_item_to_record(item, false)?;
    record.is_marketplace = true;
    Some(record)
}

/// Repo descriptions are attacker-controlled free text; bound them before they
/// reach a card.
const MAX_DESCRIPTION_CHARS: usize = 300;
const MAX_URL_CHARS: usize = 500;

fn truncate_description(value: &str) -> String {
    if value.chars().count() <= MAX_DESCRIPTION_CHARS {
        return value.to_string();
    }
    let mut out: String = value.chars().take(MAX_DESCRIPTION_CHARS).collect();
    out.push('…');
    out
}

/// http(s)-only allowlist, so a `javascript:` / `data:` homepage from an untrusted
/// repo can never reach an href. Mirrors `sources::http_url`.
pub(crate) fn sanitize_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then(|| trimmed.to_string())
}

/// Unix seconds, saturating to `0` on a pre-epoch clock.
pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl GithubTopicRecord {
    /// Whether this record's manifest should be (re-)probed. Never probed, or the
    /// last probe is older than [`MANIFEST_PROBE_TTL_SECS`] — the second arm is
    /// what lets a repo that ADDS a manifest later still be picked up, rather than
    /// being cached as manifest-less forever.
    fn manifest_probe_is_due(&self, now: u64) -> bool {
        self.manifest_probed_at == 0
            || now.saturating_sub(self.manifest_probed_at) >= MANIFEST_PROBE_TTL_SECS
    }

    /// Same TTL as the manifest probe: a repo that adds package folders later
    /// (or fills an existing one) is picked up on the next re-probe.
    fn marketplace_probe_is_due(&self, now: u64) -> bool {
        self.marketplace_probed_at == 0
            || now.saturating_sub(self.marketplace_probed_at) >= MANIFEST_PROBE_TTL_SECS
    }
}

/// Carry already-probed manifests from the previous record set onto a freshly
/// fetched one, matched by lowercased `full_name`.
///
/// This is what makes hydration cost ~nothing in steady state: a 6h refresh
/// re-fetches the two Search pages, but the manifests it already knows about
/// (including the *misses*) come along for free, so only genuinely new listings
/// and expired probes cost a raw fetch.
pub(crate) fn carry_manifests(
    records: &mut [GithubTopicRecord],
    previous: Option<&[GithubTopicRecord]>,
) {
    let Some(previous) = previous else {
        return;
    };
    let known: std::collections::HashMap<String, &GithubTopicRecord> = previous
        .iter()
        .map(|r| (r.full_name.to_ascii_lowercase(), r))
        .collect();
    for record in records.iter_mut() {
        if let Some(prior) = known.get(&record.full_name.to_ascii_lowercase()) {
            record.manifest = prior.manifest.clone();
            record.manifest_probed_at = prior.manifest_probed_at;
            record.marketplace = prior.marketplace.clone();
            record.marketplace_probed_at = prior.marketplace_probed_at;
        }
    }
}

/// The repos that answered BOTH topic queries, by lowercased `full_name`.
///
/// Publishers routinely tag `ryu-app` AND `ryu-plugin` for discoverability, so this
/// set is not an edge case — it is the population whose tab used to be decided by
/// which query this source happened to run first.
pub(crate) fn dual_topic_names(
    apps: &[GithubTopicRecord],
    plugins: &[GithubTopicRecord],
) -> std::collections::HashSet<String> {
    let app_names: std::collections::HashSet<String> = apps
        .iter()
        .map(|r| r.full_name.to_ascii_lowercase())
        .collect();
    plugins
        .iter()
        .map(|r| r.full_name.to_ascii_lowercase())
        .filter(|n| app_names.contains(n))
        .collect()
}

/// Decide app-vs-plugin for the repos that carried BOTH topics, from the manifest
/// instead of from query order.
///
/// A SINGLE-topic repo is never touched: the publisher answered the question and
/// this must not overrule them. For a dual-tagged repo there is no answer in the
/// topics at all, and the old rule ("apps are queried first, so apps win") meant
/// every such repo landed in the Apps tab — including four-line tool plugins whose
/// own manifest says otherwise.
///
/// The fallback is deliberately today's behaviour: a repo with no manifest, or one
/// whose probe timed out or is negatively cached, stays an app. Classification now
/// depends on a deadline-bounded probe ([`MANIFEST_HYDRATE_DEADLINE`]) with a 7-day
/// negative cache, so the failure mode has to be "unchanged", never "moves to the
/// other tab until the network is better".
pub(crate) fn resolve_dual_topic_classification(
    records: &mut [GithubTopicRecord],
    dual_topic: &std::collections::HashSet<String>,
) {
    if dual_topic.is_empty() {
        return;
    }
    for record in records.iter_mut() {
        // Marketplace records classify per ENTRY (from `hasCompanion`), never from
        // the marketplace repo's own manifest — a collection can hold both kinds.
        if record.is_marketplace {
            continue;
        }
        if !dual_topic.contains(&record.full_name.to_ascii_lowercase()) {
            continue;
        }
        if let Some(manifest) = record.manifest.as_ref() {
            record.is_app = manifest.has_destination;
        }
    }
}

/// Merge topic result groups, deduping by lowercased `full_name`, first writer
/// wins. Called with `[apps, plugins]`, so a repo carrying both topics collapses to
/// the app-topic row — whose classification
/// [`resolve_dual_topic_classification`] then settles from the manifest.
pub(crate) fn dedupe_records(groups: Vec<Vec<GithubTopicRecord>>) -> Vec<GithubTopicRecord> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<GithubTopicRecord> = Vec::new();
    for group in groups {
        for record in group {
            if seen.insert(record.full_name.to_ascii_lowercase()) {
                out.push(record);
            }
        }
    }
    out
}

/// Fold `ryu-marketplace` records into the app/plugin record set, matched by
/// lowercased `full_name`.
///
/// A repo tagged `ryu-marketplace` — often ALSO `ryu-app`/`ryu-plugin` for
/// discoverability — is a COLLECTION, so the marketplace record REPLACES a
/// single-listing record of the same repo (it expands to its entries under the
/// marketplace heading instead of rendering once as a bare plugin). Pure, so the
/// precedence is unit-testable without a live fetch.
pub(crate) fn merge_marketplace_records(
    mut records: Vec<GithubTopicRecord>,
    marketplaces: Vec<GithubTopicRecord>,
) -> Vec<GithubTopicRecord> {
    for marketplace in marketplaces {
        let key = marketplace.full_name.to_ascii_lowercase();
        if let Some(pos) = records
            .iter()
            .position(|r| r.full_name.to_ascii_lowercase() == key)
        {
            records[pos] = marketplace;
        } else {
            records.push(marketplace);
        }
    }
    records
}

/// Split a `gh:<owner>/<repo>` id. Returns `None` for any foreign id — checked
/// before any network call, so the install-by-id probe loop never touches GitHub
/// for an unrelated plugin.
pub(crate) fn parse_gh_id(id: &str) -> Option<(String, String)> {
    let rest = id.trim().strip_prefix(GH_ID_PREFIX)?;
    let (owner, repo) = rest.split_once('/')?;
    let (owner, repo) = (owner.trim(), repo.trim());
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Split a `ghmp:<mkt-owner>/<mkt-repo>:<entry-name>` id into its three parts.
/// Returns `None` for any foreign id — checked before any network call, so a
/// marketplace-entry id is rejected in O(1) exactly like a foreign `gh:` one.
/// An entry name must be a single path segment (no `/`), since it becomes part
/// of the id and must never be confused with a repo path.
pub(crate) fn parse_ghmp_id(id: &str) -> Option<(String, String, String)> {
    let rest = id.trim().strip_prefix(GHMP_ID_PREFIX)?;
    let (mkt, entry) = rest.split_once(':')?;
    let (owner, repo) = mkt.split_once('/')?;
    let (owner, repo, entry) = (owner.trim(), repo.trim(), entry.trim());
    if owner.is_empty()
        || repo.is_empty()
        || repo.contains('/')
        || entry.is_empty()
        || entry.contains('/')
    {
        return None;
    }
    Some((owner.to_string(), repo.to_string(), entry.to_string()))
}

/// Project one marketplace entry onto the Plugin-kind card shape that
/// `plugin_marketplace_item_to_entry` reads.
///
/// Same trust posture as [`record_to_item`]: presentation (name, icon, banner)
/// comes from the marketplace's OWN `marketplace.json`, identity (id, owner,
/// developer) from GitHub, and the trust triple (`origin` / `reviewed` /
/// `descriptor_only`) is Core's. Two additions for the grouped shelf:
///
/// - `catalog_source_id` / `catalog_source_name` name the MARKETPLACE this entry
///   came from, so the client renders one sub-heading per marketplace under the
///   "Community Marketplaces" section (the `all` view overwrites these with the
///   browsed source's meta, so the stamp is only meaningful on this feed).
/// - `repo_url` / `install_source` point at the plugin's OWN repository (the
///   entry's `source`), which is what the browse-only link-out / install-from-URL
///   handoff uses — the marketplace repo itself is a collection, not the plugin.
pub(crate) fn marketplace_entry_to_item(
    record: &GithubTopicRecord,
    marketplace: &GithubMarketplace,
    entry: &GithubMarketplaceEntry,
) -> Value {
    let repo_url = entry
        .source_repo
        .clone()
        .unwrap_or_else(|| record.html_url.clone());
    serde_json::json!({
        "id": format!("{GHMP_ID_PREFIX}{}/{}:{}", record.owner, record.repo, entry.name),
        "name": entry.display_name.clone().unwrap_or_else(|| entry.name.clone()),
        "description": entry.description.clone().unwrap_or_default(),
        "version": entry.version.clone().unwrap_or_default(),
        "install_source": repo_url,
        "url": repo_url,
        "repo_url": repo_url,
        "package_path": entry.package_path.clone(),
        "package": entry.package_path.is_some(),
        "installed": false,
        "type": if entry.has_companion { "app" } else { "plugin" },
        "has_companion": entry.has_companion,
        "developer": record.owner,
        "owner": record.owner,
        "icon": entry.icon.clone(),
        "icon_url": entry.icon_url.clone(),
        "icon_dither": entry.icon_dither.clone(),
        "icon_background": entry.icon_background.clone(),
        "banner": entry.banner.clone(),
        "surface_support": entry.surface_support.clone(),
        "tags": entry.tags.clone(),
        "category": entry.category.clone().unwrap_or_else(|| "Community".to_string()),
        "tagline": entry.tagline.clone().or_else(|| entry.description.clone()),
        "stars": record.stars,
        "license": record.license,
        "pushed_at": record.pushed_at,
        "topics": record.topics,
        // The grouping stamp — the client files this row under the marketplace's
        // heading. Same keys the `all` view stamps per source.
        "catalog_source_id": record.full_name,
        "catalog_source_name": marketplace.name.clone(),
        // The trust triple — identical to any community listing.
        "origin": COMMUNITY_ORIGIN,
        "reviewed": false,
        "provenance": GITHUB_TOPIC_SOURCE_ID,
        "descriptor_only": true,
    })
}

/// Project one record onto the Plugin-kind card shape that
/// `plugin_marketplace_item_to_entry` reads.
///
/// **Presentation comes from the repo's manifest, identity from GitHub.** The
/// manifest supplies `name` / `icon` / `description` / `version` / `tagline` /
/// `category` — what the publisher declared this thing is called and looks like.
/// GitHub keeps `id`, `developer`, `owner`, and the trust triple, because those
/// answer "who published this and has anyone vetted it", which a repo must not be
/// able to author about itself. See [`RepoManifestDisplay`].
pub(crate) fn record_to_item(record: &GithubTopicRecord) -> Value {
    let mut topics = record.topics.clone();
    if record.is_fork {
        topics.push("fork".to_string());
    }
    let manifest = record.manifest.as_ref();
    let manifest_str =
        |pick: fn(&RepoManifestDisplay) -> Option<&String>| manifest.and_then(pick).cloned();
    let name = manifest_str(|m| m.name.as_ref()).unwrap_or_else(|| record.repo.clone());
    let description = manifest_str(|m| m.description.as_ref())
        .or_else(|| record.description.clone())
        .unwrap_or_default();
    let tags = manifest
        .map(|m| {
            if m.tags.is_empty() {
                m.keywords.clone()
            } else {
                m.tags.clone()
            }
        })
        .unwrap_or_default();
    serde_json::json!({
        "id": record.id,
        "name": name,
        "description": description,
        // Empty until the repo's manifest declares one — a GitHub repo has no
        // version of its own.
        "version": manifest_str(|m| m.version.as_ref()).unwrap_or_default(),
        "install_source": record.html_url,
        "url": record.html_url,
        "repo_url": record.html_url,
        "installed": false,
        "type": if record.is_app { "app" } else { "plugin" },
        "has_companion": record.is_app,
        "developer": record.owner,
        "owner": record.owner,
        // The manifest's own art, and NOTHING else — in particular not the owner's
        // GitHub avatar, which used to stand in here.
        //
        // That fallback is why the community shelf read as a different component
        // from every other shelf. `AppIcon` gives an art-less listing the generative
        // tile seeded from its id (a painted square, the same treatment a first-party
        // listing gets from its declared dither), but ONLY when it has no icon at
        // all; any `iconUrl` suppresses the tile and takes the flat `bg-muted`
        // branch. Since a GitHub repo ALWAYS has an owner avatar, every community
        // card took that branch and every one of them looked flat next to the
        // painted plates beside it.
        //
        // Nothing is lost by dropping it: the avatar is the ORG's, so all of one
        // publisher's listings shared a single mark and it distinguished nothing
        // between them — the complaint this struct's doc opens with. The seeded tile
        // is keyed on the listing's own id, so it distinguishes MORE, and identity
        // still reads off `developer`/`owner`, which are GitHub's.
        "icon": manifest_str(|m| m.icon.as_ref()),
        "icon_url": manifest_str(|m| m.icon_url.as_ref()),
        // The icon square's plate, declared exactly the way a first-party manifest
        // declares it. Presentation only — it changes how the tile is painted, never
        // what the card claims about itself — and both values were rebuilt from a
        // closed alphabet on the way in, because they reach a CSS gradient.
        "icon_dither": manifest.and_then(|m| m.icon_dither.clone()),
        "icon_background": manifest_str(|m| m.icon_background.as_ref()),
        // The hero band the repo declared for itself. Same posture as the plate
        // above — presentation only, rebuilt from a closed alphabet on the way in,
        // and re-guarded again at paint because the render layer can never assume
        // which source a banner arrived from.
        "banner": manifest.and_then(|m| m.banner.clone()),
        "screenshots": manifest
            .map(|m| m.screenshots.clone())
            .unwrap_or_default(),
        "external": manifest.map(|m| m.external).unwrap_or(false),
        "layers": manifest.map(|m| m.layers.clone()).unwrap_or_default(),
        "surface_support": manifest
            .map(|m| m.surface_support.clone())
            .unwrap_or_default(),
        "tags": tags,
        "keywords": manifest.map(|m| m.keywords.clone()).unwrap_or_default(),
        "author": manifest.and_then(|m| m.author.clone()),
        "homepage": manifest_str(|m| m.homepage.as_ref()),
        "repository_url": manifest_str(|m| m.repository_url.as_ref()),
        "example_prompts": manifest
            .map(|m| m.example_prompts.clone())
            .unwrap_or_default(),
        "capabilities": manifest
            .map(|m| m.capabilities.clone())
            .unwrap_or_default(),
        "privacy_policy_url": manifest_str(|m| m.privacy_policy_url.as_ref()),
        "terms_of_service_url": manifest_str(|m| m.terms_of_service_url.as_ref()),
        // "Community" stays the default shelf: it is the provenance disclosure, and
        // a self-declared category only refines it.
        "category": manifest_str(|m| m.category.as_ref()).unwrap_or_else(|| "Community".to_string()),
        "tagline": manifest_str(|m| m.tagline.as_ref()).or_else(|| record.description.clone()),
        "stars": record.stars,
        "license": record.license,
        "pushed_at": record.pushed_at,
        "topics": topics,
        // The trust triple. `origin` drives the store's Community section + notice;
        // `reviewed:false` says nobody vetted this; `descriptor_only` collapses the
        // Install CTA to a link-out.
        "origin": COMMUNITY_ORIGIN,
        "reviewed": false,
        "provenance": GITHUB_TOPIC_SOURCE_ID,
        "descriptor_only": true,
    })
}

/// Lift the display-only allowlist off a third-party manifest. **Never** copies
/// `ui_code`, `backend_code`, or any `*_sha256`: an unsigned source must not be
/// able to move runnable code, and the manifest's own `id` is surfaced as
/// `manifest_id` (never as the entry id) so an id-squatting repo cannot
/// masquerade as an installed plugin.
///
/// Every lifted string goes through the same scrubbers the card path uses
/// ([`scrub_text`] / [`scrub_icon_id`] / [`scrub_version`]). This merge lands on
/// top of the values [`record_to_item`]'s counterpart already sanitized, so an
/// unscrubbed copy here would quietly re-open exactly what those close.
pub(crate) fn manifest_display_fields(manifest: &Value) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Some(obj) = manifest.as_object() else {
        return out;
    };
    if let Some(id) = obj
        .get("id")
        .and_then(|v| v.as_str())
        .and_then(|s| scrub_text(s, MAX_NAME_CHARS))
    {
        out.insert("manifestId".to_string(), Value::String(id));
    }
    let Some(display) = RepoManifestDisplay::from_manifest(manifest) else {
        return out;
    };
    if let Some(name) = display.name.clone() {
        out.insert("manifestName".to_string(), Value::String(name));
    }
    let insert_string =
        |out: &mut serde_json::Map<String, Value>, key: &str, value: &Option<String>| {
            if let Some(value) = value {
                out.insert(key.to_owned(), Value::String(value.clone()));
            }
        };
    insert_string(&mut out, "description", &display.description);
    insert_string(&mut out, "version", &display.version);
    insert_string(&mut out, "stability", &display.stability);
    insert_string(&mut out, "tagline", &display.tagline);
    insert_string(&mut out, "category", &display.category);
    insert_string(&mut out, "icon", &display.icon);
    insert_string(&mut out, "iconUrl", &display.icon_url);
    insert_string(&mut out, "homepage", &display.homepage);
    insert_string(&mut out, "website", &display.homepage);
    insert_string(&mut out, "repositoryUrl", &display.repository_url);
    insert_string(&mut out, "license", &display.license);
    insert_string(&mut out, "developerName", &display.developer);
    if let Some(author) = &display.author {
        out.insert("author".to_owned(), author.clone());
    }
    if let Some(icon_dither) = &display.icon_dither {
        out.insert("iconDither".to_owned(), icon_dither.clone());
    }
    if let Some(icon_background) = &display.icon_background {
        out.insert(
            "iconBackground".to_owned(),
            Value::String(icon_background.clone()),
        );
    }
    if !display.screenshots.is_empty() {
        out.insert(
            "screenshots".to_owned(),
            serde_json::json!(display.screenshots),
        );
    }
    if !display.keywords.is_empty() {
        out.insert("keywords".to_owned(), serde_json::json!(display.keywords));
    }
    if !display.tags.is_empty() {
        out.insert("tags".to_owned(), serde_json::json!(display.tags));
    } else if !display.keywords.is_empty() {
        out.insert("tags".to_owned(), serde_json::json!(display.keywords));
    }
    if !display.example_prompts.is_empty() {
        out.insert(
            "examplePrompts".to_owned(),
            serde_json::json!(display.example_prompts),
        );
    }
    if !display.capabilities.is_empty() {
        out.insert(
            "capabilities".to_owned(),
            serde_json::json!(display.capabilities),
        );
    }
    if let Some(privacy) = &display.privacy_policy_url {
        out.insert(
            "privacyPolicyUrl".to_owned(),
            Value::String(privacy.clone()),
        );
    }
    if let Some(terms) = &display.terms_of_service_url {
        out.insert("termsOfServiceUrl".to_owned(), Value::String(terms.clone()));
    }
    if display.external {
        out.insert("external".to_owned(), Value::Bool(true));
    }
    if !display.layers.is_empty() {
        out.insert("layers".to_owned(), Value::Array(display.layers.clone()));
    }
    if !display.surface_support.is_empty() {
        out.insert(
            "surfaceSupport".to_owned(),
            Value::Array(display.surface_support.clone()),
        );
    }
    for key in ["requires", "targets"] {
        if let Some(v) = obj.get(key).filter(|v| !v.is_null()) {
            out.insert(key.to_string(), v.clone());
        }
    }
    // The detail payload carries the banner too, through the SAME scrub the card
    // path uses. The hero reads the card's copy, so this is not what paints today —
    // but a list and a detail that disagree about a listing's own art is the exact
    // drift this function's doc opens by warning about.
    if let Some(banner) = display.banner {
        out.insert("banner".to_string(), banner);
    }
    // Runnable *kinds* only — the shapes, never their code.
    if let Some(runnables) = obj.get("runnables").and_then(|v| v.as_array()) {
        let kinds: Vec<Value> = runnables
            .iter()
            .filter_map(|r| r.get("kind").and_then(|v| v.as_str()))
            .map(|k| Value::String(k.to_string()))
            .collect();
        if !kinds.is_empty() {
            out.insert("runnableKinds".to_string(), Value::Array(kinds));
        }
    }
    out
}

impl CatalogSource for GithubTopicSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Plugin
    }

    async fn search(&self, _client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let limit = if q.limit == 0 { 40 } else { q.limit };
        let offset = q
            .cursor
            .as_deref()
            .and_then(|c| c.trim().parse::<usize>().ok())
            .unwrap_or(0);
        match self.records().await {
            Ok(cache) => {
                let needle = q.query.trim().to_ascii_lowercase();
                let type_filter = q.extra_str("github_topic_type").to_ascii_lowercase();
                // Expand marketplace records into their entries FIRST, then apply
                // the filters at the item level. A `ryu-marketplace` repo with a
                // parsed `marketplace.json` contributes one row per entry; one
                // without (or not yet hydrated) degrades to a single repo listing.
                let expanded: Vec<Value> = cache
                    .records
                    .iter()
                    .flat_map(|record| match record.marketplace.as_ref() {
                        Some(marketplace) if !marketplace.entries.is_empty() => marketplace
                            .entries
                            .iter()
                            .map(|entry| marketplace_entry_to_item(record, marketplace, entry))
                            .collect::<Vec<Value>>(),
                        _ => vec![record_to_item(record)],
                    })
                    .collect();
                let item_matches = |item: &Value| {
                    if needle.is_empty() {
                        return true;
                    }
                    let hay = [
                        item.get("name").and_then(Value::as_str).unwrap_or(""),
                        item.get("description")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        item.get("id").and_then(Value::as_str).unwrap_or(""),
                    ];
                    if hay.iter().any(|s| s.to_ascii_lowercase().contains(&needle)) {
                        return true;
                    }
                    // Topics were matched before the filter moved to the item level
                    // (a repo tagged `ryu-plugin` + `ai` used to answer a search for
                    // "ai"); keep that so the move is not a search regression.
                    item.get("topics")
                        .and_then(Value::as_array)
                        .is_some_and(|topics| {
                            topics.iter().any(|t| {
                                t.as_str()
                                    .is_some_and(|t| t.to_ascii_lowercase().contains(&needle))
                            })
                        })
                };
                let filtered: Vec<Value> = expanded
                    .into_iter()
                    .filter(|item| match type_filter.as_str() {
                        "app" => item.get("type").and_then(Value::as_str) == Some("app"),
                        "plugin" => item.get("type").and_then(Value::as_str) != Some("app"),
                        _ => true,
                    })
                    .filter(item_matches)
                    .collect();
                let total = filtered.len();
                let next_cursor = (offset + limit < total).then(|| (offset + limit).to_string());
                let items: Vec<Value> = filtered.into_iter().skip(offset).take(limit).collect();
                Ok(self.wrap_items(items, &cache.source_url, cache.note.as_deref(), next_cursor))
            }
            // `search` never propagates: an offline store shows an empty section
            // with a note, not an error page.
            Err(e) => Ok(self.wrap_items(
                Vec::new(),
                &self.resolve_api_base(),
                Some(&e.to_string()),
                None,
            )),
        }
    }

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        // Marketplace entries are a distinct id namespace (`ghmp:`), handled by
        // their own detail path. Foreign ids are rejected before any egress (the
        // install probe loop).
        if let Some((owner, repo, entry_name)) = parse_ghmp_id(id) {
            return detail_marketplace_entry(self, &owner, &repo, &entry_name).await;
        }
        if parse_gh_id(id).is_none() {
            anyhow::bail!("`{id}` is not a GitHub-topic catalog id");
        }
        let cache = self.records().await?;
        let record = cache
            .records
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| anyhow::anyhow!("community listing `{id}` not found"))?;

        // Same rule the card uses: the manifest names and icons the listing, GitHub
        // owns its identity. Kept in lockstep with `record_to_item` so opening a
        // card never renames the thing you clicked on.
        let declared = record.manifest.as_ref();
        let mut detail = serde_json::json!({
            "id": record.id,
            "name": declared
                .and_then(|m| m.name.clone())
                .unwrap_or_else(|| record.repo.clone()),
            "description": declared
                .and_then(|m| m.description.clone())
                .or_else(|| record.description.clone()),
            "icon": declared.and_then(|m| m.icon.clone()),
            // No owner-avatar fallback, for the reason spelled out in
            // `record_to_item`: it suppressed the seeded tile on every art-less
            // listing. In lockstep with the card so the hero and the row you clicked
            // paint the same square.
            "iconUrl": declared.and_then(|m| m.icon_url.clone()),
            "developer": record.owner,
            "homepage": record.homepage,
            "repositoryUrl": record.html_url,
            "license": record.license,
            "stars": record.stars,
            "topics": record.topics,
            "updatedAt": record.pushed_at,
            "type": if record.is_app { "app" } else { "plugin" },
            "source": self.display_name,
            "sourceUrl": cache.source_url,
            "origin": COMMUNITY_ORIGIN,
            "reviewed": false,
            "provenance": GITHUB_TOPIC_SOURCE_ID,
            "descriptorOnly": true,
            "discoveredFrom": {
                "topic": Self::topic(record.is_app),
                "repositoryUrl": record.html_url,
            },
        });

        // Repository enrichment (README, releases, timestamps, download counts) —
        // best-effort and cached, so a rate-limited GitHub costs a few tabs, not
        // the page. Merged BEFORE the manifest so a manifest-declared value (the
        // publisher's own claim) still wins where the two overlap.
        if let Some(obj) = detail.as_object_mut() {
            let enrichment = super::github_enrich::enrich_repo(
                &record.id,
                &self.resolve_api_base(),
                &self.request_headers(),
                &record.owner,
                &record.repo,
            )
            .await;
            if let Some(fields) = enrichment.as_object() {
                for (k, v) in fields {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }

        match self.fetch_repo_manifest(record).await {
            Some((manifest, url)) => {
                if let Some(obj) = detail.as_object_mut() {
                    for (k, v) in manifest_display_fields(&manifest) {
                        obj.insert(k, v);
                    }
                    for (k, v) in super::manifest_surface::project_manifest(&manifest) {
                        obj.insert(k, v);
                    }
                    obj.insert("manifestUrl".to_string(), Value::String(url));
                }
            }
            None => {
                if let Some(obj) = detail.as_object_mut() {
                    obj.insert(
                        "enrichmentError".to_string(),
                        Value::String(
                            "No plugin manifest found at the repository root.".to_string(),
                        ),
                    );
                }
            }
        }
        Ok(detail)
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        // A marketplace entry installs from the plugin's OWN repo, never the
        // marketplace's. Same descriptor-only posture as a `gh:` listing: no
        // `raw.manifest`, so install-by-id stays fail-closed for this unsigned
        // source and a real install goes through `POST /api/plugins/install` on
        // the repo URL.
        if let Some((owner, repo, entry_name)) = parse_ghmp_id(id) {
            let cache = self.records().await?;
            let record = cache
                .records
                .iter()
                .find(|r| r.owner == owner && r.repo == repo)
                .ok_or_else(|| {
                    anyhow::anyhow!("community marketplace `{owner}/{repo}` not found")
                })?;
            let marketplace = record.marketplace.as_ref().ok_or_else(|| {
                anyhow::anyhow!("community marketplace `{owner}/{repo}` has no listings")
            })?;
            let entry = marketplace
                .entries
                .iter()
                .find(|e| e.name == entry_name)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "listing `{entry_name}` not found in marketplace `{owner}/{repo}`"
                    )
                })?;
            let repo_url = entry
                .source_repo
                .clone()
                .unwrap_or_else(|| record.html_url.clone());
            return Ok(InstallDescriptor {
                kind: CatalogKind::Plugin,
                source_id: self.id.clone(),
                repo_id: id.to_string(),
                files: Vec::new(),
                raw: serde_json::json!({
                    "install_source": repo_url,
                    "repo_url": repo_url,
                    "origin": COMMUNITY_ORIGIN,
                    "reviewed": false,
                    "provenance": GITHUB_TOPIC_SOURCE_ID,
                }),
            });
        }
        let (owner, repo) =
            parse_gh_id(id).ok_or_else(|| anyhow::anyhow!("`{id}` is not a GitHub-topic id"))?;
        // DESCRIPTOR-ONLY, and deliberately so: no `raw.manifest` key. That is what
        // makes `resolve_plugin_from_catalog` skip this source fail-closed instead of
        // treating an unsigned third-party repo as an install path. A user who
        // genuinely wants one installs it explicitly via `POST /api/plugins/install`
        // against the repo URL — a per-repo act, not a catalog-wide trust grant.
        Ok(InstallDescriptor {
            kind: CatalogKind::Plugin,
            source_id: self.id.clone(),
            repo_id: id.to_string(),
            files: Vec::new(),
            raw: serde_json::json!({
                "install_source": format!("https://github.com/{owner}/{repo}"),
                "repo_url": format!("https://github.com/{owner}/{repo}"),
                "origin": COMMUNITY_ORIGIN,
                "reviewed": false,
                "provenance": GITHUB_TOPIC_SOURCE_ID,
            }),
        })
    }
}

/// Detail for a marketplace ENTRY (`ghmp:` id): the marketplace's parsed
/// `marketplace.json` entry, attributed to the marketplace it came from and
/// enriched from the plugin's OWN repository when that is a GitHub repo.
///
/// A free function (not a trait method) because it is a helper of the
/// `CatalogSource` impl's `detail` — a trait impl may only contain trait methods.
async fn detail_marketplace_entry(
    source: &GithubTopicSource,
    owner: &str,
    repo: &str,
    entry_name: &str,
) -> Result<Value> {
    let cache = source.records().await?;
    let record = cache
        .records
        .iter()
        .find(|r| r.owner == owner && r.repo == repo)
        .ok_or_else(|| anyhow::anyhow!("community marketplace `{owner}/{repo}` not found"))?;
    let marketplace = record
        .marketplace
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("community marketplace `{owner}/{repo}` has no listings"))?;
    let entry = marketplace
        .entries
        .iter()
        .find(|e| e.name == entry_name)
        .ok_or_else(|| {
            anyhow::anyhow!("listing `{entry_name}` not found in marketplace `{owner}/{repo}`")
        })?;

    let repo_url = entry
        .source_repo
        .clone()
        .unwrap_or_else(|| record.html_url.clone());
    let mut detail = serde_json::json!({
        "id": format!("{GHMP_ID_PREFIX}{owner}/{repo}:{entry_name}"),
        "name": entry.display_name.clone().unwrap_or_else(|| entry.name.clone()),
        "description": entry.description.clone().or_else(|| record.description.clone()),
        "icon": entry.icon.clone(),
        "iconUrl": entry.icon_url.clone(),
        "developer": record.owner,
        "homepage": entry.homepage.clone(),
        "repositoryUrl": repo_url,
        "license": record.license,
        "stars": record.stars,
        "topics": record.topics,
        "updatedAt": record.pushed_at,
        "type": if entry.has_companion { "app" } else { "plugin" },
        "source": source.display_name,
        "sourceUrl": cache.source_url,
        "origin": COMMUNITY_ORIGIN,
        "reviewed": false,
        "provenance": GITHUB_TOPIC_SOURCE_ID,
        "descriptorOnly": true,
        "discoveredFrom": {
            "topic": GithubTopicSource::marketplace_topic(),
            "repositoryUrl": record.html_url,
        },
    });

    // Enrich from the plugin's OWN repo (the entry's `source`) when it is a
    // GitHub repo — the same README / releases / manifest lift a normal
    // community listing gets. The marketplace repo is a collection; the code
    // and the README live where `source` points.
    let entry_id = detail["id"].as_str().unwrap_or("").to_string();
    if let Some((src_owner, src_repo)) = super::split_github_repo(&repo_url) {
        if let Some(obj) = detail.as_object_mut() {
            let enrichment = super::github_enrich::enrich_repo(
                &entry_id,
                &source.resolve_api_base(),
                &source.request_headers(),
                &src_owner,
                &src_repo,
            )
            .await;
            if let Some(fields) = enrichment.as_object() {
                for (k, v) in fields {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        match fetch_repo_manifest_for(&src_owner, &src_repo).await {
            Some((manifest, url)) => {
                if let Some(obj) = detail.as_object_mut() {
                    for (k, v) in manifest_display_fields(&manifest) {
                        obj.insert(k, v);
                    }
                    for (k, v) in super::manifest_surface::project_manifest(&manifest) {
                        obj.insert(k, v);
                    }
                    obj.insert("manifestUrl".to_string(), Value::String(url));
                }
            }
            None => {
                if let Some(obj) = detail.as_object_mut() {
                    obj.insert(
                        "enrichmentError".to_string(),
                        Value::String(
                            "No plugin manifest found at the repository root.".to_string(),
                        ),
                    );
                }
            }
        }
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn search_envelope_parses_and_normalizes() {
        let raw = br#"{
            "total_count": 1,
            "incomplete_results": false,
            "items": [{
                "full_name": "acme/ryu-thing",
                "name": "ryu-thing",
                "description": "does a thing",
                "html_url": "https://github.com/acme/ryu-thing",
                "stargazers_count": 128,
                "owner": { "login": "acme", "avatar_url": "https://avatars.githubusercontent.com/u/9" },
                "topics": ["ryu-plugin", "ai"],
                "license": { "spdx_id": "Apache-2.0" },
                "archived": false,
                "fork": false,
                "pushed_at": "2026-07-20T10:00:00Z",
                "unknown_future_field": 42
            }]
        }"#;
        let envelope: GithubSearchEnvelope = serde_json::from_slice(raw).unwrap();
        let records: Vec<GithubTopicRecord> = envelope
            .items
            .iter()
            .filter_map(|i| repo_item_to_record(i, false))
            .collect();
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.id, "gh:acme/ryu-thing");
        assert_eq!(r.owner, "acme");
        assert_eq!(r.repo, "ryu-thing");
        assert_eq!(r.stars, 128);
        assert_eq!(r.license.as_deref(), Some("Apache-2.0"));
        assert!(!r.is_app);
    }

    #[test]
    fn archived_repos_are_dropped_forks_are_kept_and_flagged() {
        let mut archived = repo("dead/repo", 3);
        archived.archived = true;
        assert!(repo_item_to_record(&archived, false).is_none());

        let mut forked = repo("acme/fork", 1);
        forked.fork = true;
        let record = repo_item_to_record(&forked, false).unwrap();
        assert!(record.is_fork);
        let item = record_to_item(&record);
        let topics: Vec<&str> = item["topics"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(topics.contains(&"fork"));
    }

    #[test]
    fn both_topics_classify_as_app_and_dedupe_by_full_name() {
        let as_app = repo_item_to_record(&repo("acme/dual", 5), true).unwrap();
        let as_plugin = repo_item_to_record(&repo("ACME/Dual", 5), false).unwrap();
        let other = repo_item_to_record(&repo("other/one", 1), false).unwrap();
        // Apps group first — the same repo discovered under both topics collapses
        // to ONE row, and it is the app-topic row that survives. Which TAB that row
        // ends up in is settled separately, from the manifest; see
        // `a_dual_tagged_repo_is_classified_by_its_manifest_not_by_query_order`.
        let merged = dedupe_records(vec![vec![as_app], vec![as_plugin, other]]);
        assert_eq!(merged.len(), 2);
        assert!(merged[0].is_app, "the app-topic hit must win the dedupe");
        assert_eq!(merged[0].full_name, "acme/dual");
    }

    /// A repo tagged `ryu-app` AND `ryu-plugin` used to be an app purely because
    /// this source queries the app topic first — so every publisher who tagged both
    /// for discoverability (most of them) filled the Apps tab. The tie is now broken
    /// by the manifest, and ONLY for dual-tagged repos.
    #[test]
    fn a_dual_tagged_repo_is_classified_by_its_manifest_not_by_query_order() {
        let hydrate = |record: &mut GithubTopicRecord, manifest: serde_json::Value| {
            record.manifest = RepoManifestDisplay::from_manifest(&manifest);
            record.manifest_probed_at = 1;
        };
        let dual = |name: &str| -> std::collections::HashSet<String> {
            std::collections::HashSet::from([name.to_string()])
        };

        // Dual-tagged, and its manifest declares nothing but a tool: a plugin.
        let mut records = vec![repo_item_to_record(&repo("acme/dual", 5), true).unwrap()];
        hydrate(
            &mut records[0],
            serde_json::json!({
                "name": "Dual",
                "runnables": [{ "id": "t", "name": "T", "kind": "tool" }]
            }),
        );
        resolve_dual_topic_classification(&mut records, &dual("acme/dual"));
        assert!(!records[0].is_app);
        assert_eq!(record_to_item(&records[0])["type"], "plugin");

        // Dual-tagged with a dock panel: still an app.
        let mut records = vec![repo_item_to_record(&repo("acme/dual", 5), true).unwrap()];
        hydrate(
            &mut records[0],
            serde_json::json!({
                "name": "Dual",
                "contributes": { "dock_panels": [
                    { "id": "p", "title": "P", "placement": "bottom", "panel": "native" }
                ] }
            }),
        );
        resolve_dual_topic_classification(&mut records, &dual("acme/dual"));
        assert!(records[0].is_app);

        // Dual-tagged, no manifest (or a probe that timed out / is negatively
        // cached): unchanged, i.e. still the app the query order made it. The
        // classification must never flap with network weather.
        let mut records = vec![repo_item_to_record(&repo("acme/dual", 5), true).unwrap()];
        resolve_dual_topic_classification(&mut records, &dual("acme/dual"));
        assert!(records[0].is_app);

        // SINGLE-topic repos are never touched, even carrying a manifest that would
        // have said otherwise — the publisher answered the question.
        let mut records = vec![repo_item_to_record(&repo("acme/solo", 5), true).unwrap()];
        hydrate(
            &mut records[0],
            serde_json::json!({ "runnables": [{ "id": "t", "name": "T", "kind": "tool" }] }),
        );
        resolve_dual_topic_classification(&mut records, &dual("acme/dual"));
        assert!(records[0].is_app);

        // And the dual set is exactly the intersection, by lowercased full_name.
        let apps = vec![
            repo_item_to_record(&repo("acme/dual", 5), true).unwrap(),
            repo_item_to_record(&repo("acme/only-app", 1), true).unwrap(),
        ];
        let plugins = vec![
            repo_item_to_record(&repo("ACME/Dual", 5), false).unwrap(),
            repo_item_to_record(&repo("other/one", 1), false).unwrap(),
        ];
        let names = dual_topic_names(&apps, &plugins);
        assert_eq!(names, dual("acme/dual"));
    }

    /// The icon plate a community repo declares for itself. Without it the shelf's
    /// cards fall through `AppIcon`'s flat `bg-muted` branch while every listing
    /// beside them gets a painted gradient — the same card component looking like
    /// two different ones.
    #[test]
    fn a_manifest_can_declare_its_icon_plate_and_only_within_a_closed_alphabet() {
        let lifted = RepoManifestDisplay::from_manifest(&serde_json::json!({
            "name": "Thing",
            "iconDither": { "from": 288, "to": "transparent", "direction": "down" },
            "iconBackground": "#0099ff"
        }))
        .expect("a declared plate hydrates");
        let mut record = repo_item_to_record(&repo("acme/thing", 3), false).unwrap();
        record.manifest = Some(lifted);
        let item = record_to_item(&record);
        assert_eq!(
            item["icon_dither"],
            serde_json::json!({ "from": 288.0, "to": "transparent", "direction": "down" })
        );
        assert_eq!(item["icon_background"], "#0099ff");

        // The background reaches an inline CSS `background`, so the alphabet is
        // closed: colours in, declarations and `url(…)` out.
        assert_eq!(scrub_css_color("#abc"), Some("#abc".to_string()));
        assert_eq!(
            scrub_css_color("oklch(0.7 0.1 240)"),
            Some("oklch(0.7 0.1 240)".to_string())
        );
        assert_eq!(
            scrub_css_color("rebeccapurple"),
            Some("rebeccapurple".into())
        );
        assert!(scrub_css_color("url(https://evil.example/x.png)").is_none());
        assert!(scrub_css_color("red; position:fixed; inset:0").is_none());
        assert!(scrub_css_color("rgb(0,0,0) /* */; background:url(x)").is_none());
        assert!(scrub_css_color("#12345").is_none());

        // The dither is rebuilt field by field, never passed through.
        assert!(
            scrub_icon_dither(&serde_json::json!({ "to": 12 })).is_none(),
            "`from` is required"
        );
        assert_eq!(
            scrub_icon_dither(&serde_json::json!({
                "from": 10, "to": 900, "direction": "diagonal", "extra": "dropped"
            })),
            Some(serde_json::json!({ "from": 10.0 })),
            "out-of-range, unknown and unlisted members are dropped, not carried"
        );
    }

    /// The hero band a community repo declares for itself. Dropped entirely until
    /// now: every icon field was lifted and `banner` was not, so a repo could
    /// declare a hero and only ever get the wash derived from its icon.
    #[test]
    fn a_manifest_can_declare_its_hero_banner_including_an_animated_gradient() {
        let lifted = RepoManifestDisplay::from_manifest(&serde_json::json!({
            "name": "Thing",
            "banner": {
                "style": "animated-gradient",
                "gradient": {
                    "preset": "vortex",
                    "color1": "#0099ff",
                    "shape": "Stripes",
                    "swirl": 80,
                    "shapeSize": 10
                },
                "noise": { "opacity": 40, "scale": 2 }
            }
        }))
        .expect("a declared banner hydrates");
        let mut record = repo_item_to_record(&repo("acme/thing", 3), false).unwrap();
        record.manifest = Some(lifted);
        let item = record_to_item(&record);
        assert_eq!(
            item["banner"],
            serde_json::json!({
                "style": "animated-gradient",
                "gradient": {
                    "preset": "vortex",
                    // Lowercased: the client matches a closed set, and `Stripes` is
                    // what the component's own docs capitalise it as.
                    "shape": "stripes",
                    "color1": "#0099ff",
                    "shapeSize": 10.0,
                    "swirl": 80.0
                },
                "noise": { "opacity": 40.0, "scale": 2.0 }
            })
        );
    }

    /// Every value in a banner reaches either a CSS sink or a GPU uniform, so the
    /// object is rebuilt key by key rather than passed through.
    #[test]
    fn a_banner_from_an_unsigned_repo_is_rebuilt_never_passed_through() {
        // An unknown style names a renderer this build does not have; an unknown
        // preset only names a look, so it is dropped and the client's default
        // stands. Neither may travel.
        assert!(scrub_banner(&serde_json::json!({ "style": "iframe" })).is_none());
        assert_eq!(
            scrub_banner(&serde_json::json!({
                "style": "animated-gradient",
                "gradient": { "preset": "malware", "shape": "hexagons" }
            })),
            Some(serde_json::json!({ "style": "animated-gradient" })),
            "unknown tokens are dropped, and an empty gradient is not carried"
        );

        // A background that would make the browser fetch turns every viewer of the
        // listing into a beacon hit. Colours in, declarations and `url(…)` out.
        assert!(scrub_banner(&serde_json::json!({
            "background": "url(https://tracker.example/pixel.png)"
        }))
        .is_none());
        assert!(scrub_banner(&serde_json::json!({ "imageUrl": "javascript:alert(1)" })).is_none());

        // One bad stop drops the WHOLE ramp — the stops are joined into a single
        // gradient downstream, so the survivors would paint something unwritten.
        assert!(scrub_banner(&serde_json::json!({
            "colors": ["#111111", "url(https://tracker.example/p.png)"]
        }))
        .is_none());

        // The DoS surface: these become shader uniforms, and an unbounded loop
        // count is a frozen tab rather than an ugly banner.
        assert_eq!(
            scrub_banner(&serde_json::json!({
                "gradient": {
                    "swirlIterations": 1_000_000,
                    "scale": 1e9,
                    "proportion": -50,
                    "rotation": 5000
                }
            })),
            Some(serde_json::json!({
                "gradient": {
                    "swirlIterations": 20.0,
                    "scale": 4.0,
                    "proportion": 0.0,
                    "rotation": 360.0
                }
            }))
        );

        // An existing disk cache predates the field, so a record without one must
        // still deserialize — the banner simply stays absent until a re-probe.
        let cached: RepoManifestDisplay =
            serde_json::from_value(serde_json::json!({ "name": "Thing" })).unwrap();
        assert!(cached.banner.is_none());
    }

    #[test]
    fn app_vs_plugin_comes_from_the_matched_query_not_the_topics_array() {
        // The repo's own `topics` say "ryu-plugin", but it was found under the
        // app topic — the query is the ground truth (topics are publisher-controlled).
        let record = repo_item_to_record(&repo("acme/claims-plugin", 2), true).unwrap();
        let item = record_to_item(&record);
        assert_eq!(item["type"], "app");
        assert_eq!(item["has_companion"], true);
    }

    #[test]
    fn card_carries_the_unreviewed_trust_triple() {
        let record = repo_item_to_record(&repo("acme/thing", 7), false).unwrap();
        let item = record_to_item(&record);
        assert_eq!(item["origin"], COMMUNITY_ORIGIN);
        assert_eq!(item["reviewed"], false);
        assert_eq!(item["provenance"], GITHUB_TOPIC_SOURCE_ID);
        assert_eq!(item["descriptor_only"], true);
        assert_eq!(item["stars"], 7);
        // A repo has no version until its manifest is read in `detail`.
        assert_eq!(item["version"], "");
        // And a card is never a manifest carrier.
        assert!(item.get("manifest").is_none());
    }

    #[test]
    fn gh_ids_parse_and_foreign_ids_are_rejected() {
        assert_eq!(
            parse_gh_id("gh:acme/ryu-thing"),
            Some(("acme".to_string(), "ryu-thing".to_string()))
        );
        for foreign in [
            "@ryu/mail",
            "acme/ryu-thing",
            "gh:acme",
            "gh:/thing",
            "gh:acme/",
            "gh:acme/a/b",
            "",
        ] {
            assert!(
                parse_gh_id(foreign).is_none(),
                "`{foreign}` must not parse as a github-topic id"
            );
        }
    }

    #[tokio::test]
    async fn install_descriptor_never_carries_a_manifest() {
        // REGRESSION GUARD. `resolve_plugin_from_catalog` reads `raw["manifest"]`;
        // an absent one is what keeps install-by-id fail-closed for this unsigned
        // source. Do not "helpfully" add it.
        let source = GithubTopicSource::builtin();
        let client = reqwest::Client::new();
        let descriptor = source
            .install_descriptor(&client, "gh:acme/ryu-thing")
            .await
            .unwrap();
        assert!(descriptor.raw.get("manifest").is_none());
        assert!(descriptor.files.is_empty());
        assert_eq!(descriptor.raw["reviewed"], false);
        assert_eq!(descriptor.raw["origin"], COMMUNITY_ORIGIN);
        // A foreign id is refused without touching the network.
        assert!(source
            .install_descriptor(&client, "@ryu/mail")
            .await
            .is_err());
    }

    #[test]
    fn manifest_enrichment_lifts_the_allowlist_and_drops_runnable_code() {
        let manifest = serde_json::json!({
            "id": "com.acme.thing",
            "name": "Thing",
            "version": "1.2.3",
            "stability": "Beta",
            "description": "a thing",
            "category": "Productivity",
            "ui_code": "<script>alert(1)</script>",
            "ui_code_sha256": "deadbeef",
            "backend_code": "require('child_process').exec('rm -rf /')",
            "backend_sha256": "cafebabe",
            "artifact_url": "https://evil.example/x.tgz",
            "runnables": [{ "kind": "companion", "id": "ui", "name": "UI" }],
        });
        let lifted = manifest_display_fields(&manifest);
        assert_eq!(lifted["version"], "1.2.3");
        assert_eq!(lifted["stability"], "beta");
        assert_eq!(lifted["category"], "Productivity");
        // The manifest's claimed id is disclosed SEPARATELY, never as the entry id.
        assert_eq!(lifted["manifestId"], "com.acme.thing");
        assert!(lifted.get("id").is_none());
        for forbidden in [
            "ui_code",
            "ui_code_sha256",
            "backend_code",
            "backend_sha256",
            "artifact_url",
        ] {
            assert!(
                lifted.get(forbidden).is_none(),
                "`{forbidden}` must never travel from an unsigned source"
            );
        }
        // Runnable KINDS only — the shapes, never their code.
        assert_eq!(lifted["runnableKinds"], serde_json::json!(["companion"]));
    }

    #[test]
    fn codex_plugin_interface_metadata_projects_to_the_shared_listing_contract() {
        assert!(REPO_MANIFEST_PATHS.contains(&".codex-plugin/plugin.json"));
        assert!(REPO_MANIFEST_PATHS.contains(&".claude-plugin/plugin.json"));
        let manifest = serde_json::json!({
            "$schema": "https://developers.openai.com/codex/schemas/plugin.json",
            "name": "conductor",
            "version": "1.0.0",
            "description": "fallback",
            "author": { "name": "Resend", "url": "https://resend.com" },
            "homepage": "https://github.com/resend/openai-plugins",
            "repository": "https://github.com/resend/openai-plugins",
            "license": "MIT",
            "keywords": ["email", "automation"],
            "banner": { "style": "gradient", "colors": ["#111111", "#222222"] },
            "external": true,
            "provides": [{
                "capability": "browser.control",
                "title": "Browser",
                "selectable": true,
                "target": "remote-desktop",
                "tools": { "browser.navigate": { "tool": "remote.open" } }
            }],
            "interface": {
                "displayName": "Conductor",
                "shortDescription": "A short pitch",
                "longDescription": "A longer public description",
                "category": "Productivity",
                "websiteURL": "https://resend.com/conductor",
                "privacyPolicyURL": "https://resend.com/legal/privacy",
                "termsOfServiceURL": "https://resend.com/legal/terms",
                "defaultPrompt": ["Draft an email"],
                "screenshots": ["https://cdn.example.com/conductor.png"],
                "composerIcon": "lucide:mail",
                "logo": "https://cdn.example.com/conductor.svg",
                "developerName": "Resend",
                "capabilities": ["Send email"]
            },
            "permission_grants": ["tool:execute"],
            "ui_code": "must not travel"
        });
        let display = RepoManifestDisplay::from_manifest(&manifest).expect("metadata survives");
        assert_eq!(display.name.as_deref(), Some("Conductor"));
        assert_eq!(display.tagline.as_deref(), Some("A short pitch"));
        assert_eq!(
            display.description.as_deref(),
            Some("A longer public description")
        );
        assert_eq!(display.icon.as_deref(), Some("lucide:mail"));
        assert_eq!(
            display.icon_url.as_deref(),
            Some("https://cdn.example.com/conductor.svg")
        );
        assert_eq!(
            display.homepage.as_deref(),
            Some("https://resend.com/conductor")
        );
        assert_eq!(display.screenshots.len(), 1);
        assert_eq!(display.example_prompts, vec!["Draft an email"]);
        assert_eq!(display.layers[0]["capability"], "browser.control");
        assert!(display.external);

        let lifted = manifest_display_fields(&manifest);
        assert_eq!(lifted["manifestName"], "Conductor");
        assert_eq!(lifted["description"], "A longer public description");
        assert_eq!(lifted["website"], "https://resend.com/conductor");
        assert_eq!(
            lifted["privacyPolicyUrl"],
            "https://resend.com/legal/privacy"
        );
        assert_eq!(
            lifted["termsOfServiceUrl"],
            "https://resend.com/legal/terms"
        );
        assert_eq!(
            lifted["examplePrompts"],
            serde_json::json!(["Draft an email"])
        );
        assert_eq!(
            lifted["screenshots"],
            serde_json::json!(["https://cdn.example.com/conductor.png"])
        );
        assert_eq!(lifted["external"], true);
        assert!(lifted.get("ui_code").is_none());
        assert!(lifted.get("permission_grants").is_none());
    }

    #[test]
    fn hostile_urls_are_rejected_before_they_reach_an_href() {
        let mut hostile = repo("acme/evil", 0);
        hostile.homepage = Some("javascript:alert(1)".to_string());
        hostile.html_url = "data:text/html,pwned".to_string();
        let record = repo_item_to_record(&hostile, false).unwrap();
        assert!(record.homepage.is_none());
        // A non-http html_url falls back to the canonical github URL.
        assert_eq!(record.html_url, "https://github.com/acme/evil");
    }

    #[test]
    fn descriptions_are_bounded() {
        let mut wordy = repo("acme/wordy", 0);
        wordy.description = Some("x".repeat(5000));
        let record = repo_item_to_record(&wordy, false).unwrap();
        let description = record.description.unwrap();
        assert!(description.chars().count() <= MAX_DESCRIPTION_CHARS + 1);
    }

    #[test]
    fn a_custom_api_base_suppresses_the_byok_token() {
        let default_host = GithubTopicSource {
            id: GITHUB_TOPIC_SOURCE_ID.to_string(),
            display_name: "GitHub (community)".to_string(),
            api_base: None,
            token: Some("ghp_secret".to_string()),
        };
        assert_eq!(default_host.resolve_token(), Some("ghp_secret"));

        let mirror = GithubTopicSource {
            api_base: Some("https://ghe.example.com/api/v3".to_string()),
            ..default_host.clone()
        };
        assert!(
            mirror.resolve_token().is_none(),
            "the user's PAT must never be sent to a non-default host"
        );
        assert!(!mirror
            .request_headers()
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("authorization")));
    }

    #[test]
    fn debug_redacts_the_token() {
        let source = GithubTopicSource {
            id: GITHUB_TOPIC_SOURCE_ID.to_string(),
            display_name: "GitHub (community)".to_string(),
            api_base: None,
            token: Some("ghp_supersecret".to_string()),
        };
        let rendered = format!("{source:?}");
        assert!(!rendered.contains("ghp_supersecret"), "{rendered}");
        assert!(rendered.contains("redacted"), "{rendered}");
    }

    #[test]
    fn stale_note_names_the_rate_limit() {
        assert!(
            stale_note("https://api.github.com/... returned HTTP 403 Forbidden")
                .contains("rate limit")
        );
        assert!(stale_note("dns error").contains("cached"));
    }

    #[test]
    fn search_url_encodes_the_topic_qualifier() {
        let source = GithubTopicSource::builtin();
        let url = source.search_url("ryu-app");
        assert!(url.starts_with("https://api.github.com/search/repositories?q="));
        assert!(url.contains("topic%3Aryu-app"), "{url}");
        assert!(url.contains("per_page=100"));
    }

    /// A record whose manifest has already been probed, for the card-projection
    /// tests below.
    fn hydrated(full_name: &str, manifest: serde_json::Value) -> GithubTopicRecord {
        let mut record = repo_item_to_record(&repo(full_name, 4), false).unwrap();
        record.manifest = RepoManifestDisplay::from_manifest(&manifest);
        record.manifest_probed_at = unix_now();
        record
    }

    #[test]
    fn card_name_and_icon_come_from_the_manifest_not_the_repo_slug() {
        // The bug this closes: every community card was titled `<repo>` and iconed
        // with the OWNER's avatar, so an org's listings were indistinguishable and
        // none matched the name the plugin actually ships under.
        let record = hydrated(
            "acme/ryu-thing-plugin",
            serde_json::json!({
                "id": "@acme/thing",
                "name": "Thing",
                "icon": "lucide:brain",
                "iconUrl": "https://cdn.example.com/thing.png",
                "description": "Does the thing.",
                "version": "2.1.0",
                "tagline": "the thing, done",
                "category": "Productivity",
            }),
        );
        let item = record_to_item(&record);
        assert_eq!(item["name"], "Thing");
        assert_eq!(item["icon"], "lucide:brain");
        assert_eq!(item["icon_url"], "https://cdn.example.com/thing.png");
        assert_eq!(item["description"], "Does the thing.");
        assert_eq!(item["version"], "2.1.0");
        assert_eq!(item["tagline"], "the thing, done");
        assert_eq!(item["category"], "Productivity");
    }

    #[test]
    fn an_unhydrated_card_falls_back_to_the_repo_slug_and_carries_no_art() {
        // Hydration is best-effort and deadline-bounded: a listing it has not
        // reached must still render, not blank out.
        let record = repo_item_to_record(&repo("acme/ryu-thing", 4), false).unwrap();
        assert!(record.manifest.is_none());
        let item = record_to_item(&record);
        assert_eq!(item["name"], "ryu-thing");
        // No art of ANY kind — deliberately including the owner's avatar, which
        // used to stand in here. `AppIcon` paints the generative tile seeded from
        // the listing id only for a card with no icon at all, so the avatar was
        // what forced every community card onto the flat `bg-muted` branch while
        // the shelves beside it showed painted plates.
        assert_eq!(item["icon"], Value::Null);
        assert_eq!(item["icon_url"], Value::Null);
        assert_eq!(item["icon_dither"], Value::Null);
        assert_eq!(item["icon_background"], Value::Null);
        assert_eq!(item["category"], "Community");
    }

    #[test]
    fn a_community_card_carries_the_icon_plate_its_manifest_declares() {
        // The other half of the same shelf-consistency fix: a repo that DOES
        // declare the plate gets the identical painted square a first-party
        // listing gets, because both travel the same two keys.
        let record = hydrated(
            "acme/ryu-thing",
            serde_json::json!({
                "name": "Thing",
                "iconDither": { "from": 288, "to": "transparent", "direction": "down" },
                "iconBackground": "#0099ff",
            }),
        );
        let item = record_to_item(&record);
        assert_eq!(item["icon_dither"]["from"], 288.0);
        assert_eq!(item["icon_dither"]["to"], "transparent");
        assert_eq!(item["icon_dither"]["direction"], "down");
        assert_eq!(item["icon_background"], "#0099ff");

        // …and a plate that is really a CSS payload is dropped, not sanitized: this
        // JSON is unsigned and lands in an inline `style`.
        let hostile = hydrated(
            "acme/ryu-evil",
            serde_json::json!({
                // A name so the display record survives at all — the assertions
                // below are then about the plate being rejected, not about the
                // whole manifest having been dropped.
                "name": "Evil",
                "iconDither": { "from": "red; background: url(https://x/y)" },
                "iconBackground": "url(https://x/y); position: fixed",
            }),
        );
        let item = record_to_item(&hostile);
        assert_eq!(item["name"], "Evil");
        assert_eq!(item["icon_dither"], Value::Null);
        assert_eq!(item["icon_background"], Value::Null);
    }

    #[test]
    fn a_manifest_can_supply_presentation_but_never_identity_or_trust() {
        // A topic-squatting repo may title itself anything; it must not be able to
        // claim someone else's id, publisher, or a reviewed status.
        let record = hydrated(
            "squatter/evil",
            serde_json::json!({
                "id": "@ryu/mail",
                "name": "Ryu Official Mail",
                "developer": "Ryu",
                "origin": "builtin",
                "reviewed": true,
                "descriptor_only": false,
                "built_in": true,
            }),
        );
        let item = record_to_item(&record);
        assert_eq!(item["name"], "Ryu Official Mail");
        // …and every identity/trust key is still GitHub's and Core's.
        assert_eq!(item["id"], "gh:squatter/evil");
        assert_eq!(item["developer"], "squatter");
        assert_eq!(item["owner"], "squatter");
        assert_eq!(item["origin"], COMMUNITY_ORIGIN);
        assert_eq!(item["reviewed"], false);
        assert_eq!(item["descriptor_only"], true);
    }

    #[test]
    fn a_companion_icon_is_the_glyph_fallback() {
        // How an app authors its icon — same fallback `plugin_manifest_to_entry` uses.
        let record = hydrated(
            "acme/app",
            serde_json::json!({ "name": "App", "companion": { "icon": "ai-image" } }),
        );
        assert_eq!(record_to_item(&record)["icon"], "ai-image");
    }

    #[test]
    fn an_icon_id_is_a_glyph_id_never_a_url_or_data_uri() {
        // `iconToUrl` returns a `data:`/`http(s):` id UNCHANGED and drops it into a
        // CSS `mask-image`, so the alphabet is constrained here, at the boundary.
        for good in ["lucide:brain", "activity-03", "svgl:brave|dark", "mic_01.x"] {
            assert_eq!(scrub_icon_id(good).as_deref(), Some(good), "{good}");
        }
        for bad in [
            "https://evil.example/x.svg",
            "data:image/svg+xml;base64,PHN2Zz4=",
            "javascript:alert(1)",
            "lucide:brain\"); background:url(https://evil.example",
            "a b",
            "",
            "   ",
        ] {
            assert!(scrub_icon_id(bad).is_none(), "{bad}");
        }
        // And over-long ids are refused rather than truncated into a different id.
        assert!(scrub_icon_id(&"a".repeat(MAX_ICON_ID_CHARS + 1)).is_none());
    }

    #[test]
    fn manifest_strings_are_control_stripped_and_bounded() {
        let record = hydrated(
            "acme/wordy",
            serde_json::json!({
                "name": format!("Line\nBreak\u{0}{}", "x".repeat(500)),
                "version": "1.0.0; rm -rf /",
                "description": "y".repeat(5000),
            }),
        );
        let manifest = record.manifest.as_ref().unwrap();
        let name = manifest.name.as_deref().unwrap();
        assert!(!name.contains('\n') && !name.contains('\u{0}'), "{name}");
        assert_eq!(name.chars().count(), MAX_NAME_CHARS);
        // A version outside semver's alphabet is dropped, not sanitized into a lie.
        assert!(manifest.version.is_none());
        assert_eq!(
            manifest.description.as_deref().unwrap().chars().count(),
            MAX_DESCRIPTION_CHARS
        );
    }

    #[test]
    fn an_empty_manifest_hydrates_to_nothing_rather_than_blank_fields() {
        assert!(RepoManifestDisplay::from_manifest(&serde_json::json!({})).is_none());
        assert!(RepoManifestDisplay::from_manifest(&serde_json::json!([])).is_none());
        // A manifest with only non-display keys is equally "nothing to show".
        assert!(
            RepoManifestDisplay::from_manifest(&serde_json::json!({ "ui_code": "x" })).is_none()
        );
    }

    #[test]
    fn carry_manifests_preserves_probed_hits_and_misses() {
        // The negative cache. Without carrying a MISS, every refresh would re-pay
        // five raw fetches for each of the (many) manifest-less listings, forever.
        let hit = hydrated("acme/has-manifest", serde_json::json!({ "name": "Has" }));
        let mut miss = repo_item_to_record(&repo("acme/no-manifest", 1), false).unwrap();
        miss.manifest_probed_at = unix_now();
        let previous = vec![hit, miss];

        let mut fresh = vec![
            repo_item_to_record(&repo("ACME/Has-Manifest", 9), false).unwrap(),
            repo_item_to_record(&repo("acme/no-manifest", 2), false).unwrap(),
            repo_item_to_record(&repo("acme/brand-new", 0), false).unwrap(),
        ];
        carry_manifests(&mut fresh, Some(&previous));

        assert_eq!(
            fresh[0].manifest.as_ref().and_then(|m| m.name.as_deref()),
            Some("Has"),
            "a known hit carries over (match is case-insensitive on full_name)"
        );
        assert!(fresh[1].manifest.is_none());
        assert!(
            !fresh[1].manifest_probe_is_due(unix_now()),
            "a known MISS must stay remembered, or the probe never amortizes"
        );
        assert!(
            fresh[2].manifest_probe_is_due(unix_now()),
            "a listing never seen before is due"
        );
    }

    #[test]
    fn a_remembered_probe_expires_so_a_later_manifest_is_picked_up() {
        let now = unix_now();
        let mut record = repo_item_to_record(&repo("acme/thing", 1), false).unwrap();
        record.manifest_probed_at = now;
        assert!(!record.manifest_probe_is_due(now));
        assert!(record.manifest_probe_is_due(now + MANIFEST_PROBE_TTL_SECS));
    }

    #[test]
    fn the_detail_view_lift_scrubs_the_same_fields_the_card_does() {
        let lifted = manifest_display_fields(&serde_json::json!({
            "id": "com.acme.thing",
            "name": "Thing\nInjected",
            "icon": "https://evil.example/x.svg",
            "version": "1.0.0 && curl evil",
        }));
        assert_eq!(lifted["manifestName"], "ThingInjected");
        // A URL in the glyph slot is dropped here exactly as it is on the card —
        // this merge lands ON TOP of the card's sanitized values.
        assert!(lifted.get("icon").is_none());
        assert!(lifted.get("version").is_none());
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

    #[test]
    fn ghmp_ids_parse_and_foreign_ids_are_rejected() {
        assert_eq!(
            parse_ghmp_id("ghmp:acme/bazaar:thing-tool"),
            Some((
                "acme".to_string(),
                "bazaar".to_string(),
                "thing-tool".to_string()
            ))
        );
        for foreign in [
            "gh:acme/bazaar",
            "acme/bazaar:thing-tool",
            "ghmp:acme",
            "ghmp:acme/",
            "ghmp:acme/bazaar:",
            "ghmp:acme/bazaar:a/b",
            "ghmp:acme/a/b:thing",
            "",
        ] {
            assert!(
                parse_ghmp_id(foreign).is_none(),
                "`{foreign}` must not parse as a marketplace-entry id"
            );
        }
    }

    #[test]
    fn a_marketplace_entry_card_is_grouped_and_trust_stamped() {
        let record = marketplace_repo("acme/bazaar");
        let marketplace = record.marketplace.as_ref().unwrap();
        let entry = &marketplace.entries[0];
        let item = marketplace_entry_to_item(&record, marketplace, entry);

        assert_eq!(
            item["id"], "ghmp:acme/bazaar:thing-tool",
            "the id is namespaced so it can never collide with a single-listing id"
        );
        assert_eq!(item["name"], "Thing Tool", "displayName wins over name");
        assert_eq!(item["type"], "plugin");
        // The grouping stamp is what the client files the row under.
        assert_eq!(item["catalog_source_id"], "acme/bazaar");
        assert_eq!(item["catalog_source_name"], "The Bazaar");
        // The repo the row points at is the PLUGIN's, never the marketplace's.
        assert_eq!(item["repo_url"], "https://github.com/acme/thing-tool");
        assert_eq!(item["install_source"], "https://github.com/acme/thing-tool");
        // Same trust triple as any community listing.
        assert_eq!(item["origin"], COMMUNITY_ORIGIN);
        assert_eq!(item["reviewed"], false);
        assert_eq!(item["provenance"], GITHUB_TOPIC_SOURCE_ID);
        assert_eq!(item["descriptor_only"], true);
        // And a card is never a manifest carrier.
        assert!(item.get("manifest").is_none());
    }

    #[test]
    fn a_marketplace_entry_classifies_as_an_app_from_has_companion() {
        let record = marketplace_repo("acme/bazaar");
        let marketplace = record.marketplace.as_ref().unwrap();
        let canvas = &marketplace.entries[1];
        let item = marketplace_entry_to_item(&record, marketplace, canvas);
        assert_eq!(item["type"], "app");
        assert_eq!(item["has_companion"], true);
        // The source-object form resolves to the plugin's repo too.
        assert_eq!(item["repo_url"], "https://github.com/acme/canvas");
    }

    #[test]
    fn a_marketplace_manifest_scrubs_hostile_fields_and_requires_a_name() {
        // A hostile entry keeps what the allowlist lets through and drops the rest.
        let parsed = GithubMarketplace::from_manifest(
            &serde_json::json!({
                "name": "Bazaar",
                "plugins": [
                    {
                        "name": "ok",
                        "displayName": "OK",
                        "icon": "https://evil.example/x.svg",
                        "version": "1.0.0 && curl evil",
                        "description": "line\nbreak",
                        "source": "javascript:alert(1)",
                        "ui_code": "<script>alert(1)</script>",
                    }
                ],
            }),
            "acme/bazaar",
        )
        .expect("an entry with a name parses");
        let entry = &parsed.entries[0];
        assert_eq!(entry.name, "ok");
        assert_eq!(entry.display_name.as_deref(), Some("OK"));
        // The icon slot only accepts glyph ids; a URL in it is dropped.
        assert!(entry.icon.is_none());
        // Version alphabet is closed; the hostile source repo is dropped, so the
        // card falls back to the marketplace repo's URL.
        assert!(entry.version.is_none());
        assert!(entry.source_repo.is_none());
        // Control characters are stripped from free text.
        assert_eq!(entry.description.as_deref(), Some("linebreak"));

        // An entry without a name cannot form a stable id → the whole marketplace
        // is treated as "nothing to show" and degrades to a single repo listing.
        assert!(GithubMarketplace::from_manifest(
            &serde_json::json!({ "plugins": [{ "displayName": "No Name" }] }),
            "acme/bazaar",
        )
        .is_none());
    }

    #[test]
    fn a_marketplace_wins_the_dedupe_over_a_single_listing_of_the_same_repo() {
        // The same repo tagged `ryu-app` AND `ryu-marketplace`: the marketplace
        // classification must replace the single listing, not sit beside it.
        let app = repo_item_to_record(&repo("acme/bazaar", 6), true).unwrap();
        let marketplace = marketplace_repo("acme/bazaar");
        let merged = merge_marketplace_records(vec![app], vec![marketplace]);

        assert_eq!(merged.len(), 1, "one repo, one record");
        assert!(merged[0].is_marketplace);
        assert!(merged[0].marketplace.is_some());
    }

    #[test]
    fn an_unhydrated_marketplace_degrades_to_a_single_repo_listing() {
        // A `ryu-marketplace` repo whose marketplace.json has not been probed yet
        // (or carries no entries) still renders — as the repo itself.
        let record = repo_item_to_marketplace_record(&repo("acme/bazaar", 3)).unwrap();
        assert!(record.marketplace.is_none());
        let item = record_to_item(&record);
        assert_eq!(item["id"], "gh:acme/bazaar");
        assert_eq!(item["name"], "bazaar");
        // Still a community listing under the trust notice.
        assert_eq!(item["origin"], COMMUNITY_ORIGIN);
        assert_eq!(item["reviewed"], false);
    }

    #[test]
    fn a_marketplace_probe_is_carried_across_refreshes_and_expires() {
        let now = unix_now();
        let mut marketplace = marketplace_repo("acme/bazaar");
        let fresh = repo_item_to_marketplace_record(&repo("acme/bazaar", 9)).unwrap();
        // A fresh record has never been probed.
        assert!(fresh.marketplace_probe_is_due(now));

        // The probe (a HIT here) carries over on a case-insensitive full_name match.
        let mut target = repo_item_to_marketplace_record(&repo("ACME/Bazaar", 9)).unwrap();
        carry_manifests(
            std::slice::from_mut(&mut target),
            Some(&[marketplace.clone()]),
        );
        assert!(target.marketplace.is_some());
        assert_eq!(
            target.marketplace.as_ref().unwrap().name,
            "The Bazaar",
            "the parsed marketplace carries over, not just the probe timestamp"
        );

        // And a remembered probe expires, so a repo that later ADDS a marketplace
        // is picked up.
        marketplace.marketplace_probed_at = now;
        assert!(!marketplace.marketplace_probe_is_due(now));
        assert!(marketplace.marketplace_probe_is_due(now + MANIFEST_PROBE_TTL_SECS));
    }

    #[test]
    fn marketplace_search_matches_entry_names_and_respects_the_type_filter() {
        let record = marketplace_repo("acme/bazaar");
        // Build a small cache and run the item-level filtering that `search` does
        // after expanding records, without touching the network.
        let expanded: Vec<Value> = match record.marketplace.as_ref() {
            Some(marketplace) => marketplace
                .entries
                .iter()
                .map(|entry| marketplace_entry_to_item(&record, marketplace, entry))
                .collect(),
            None => vec![record_to_item(&record)],
        };
        let filter = |type_filter: &str, needle: &str| -> Vec<Value> {
            let needle = needle.trim().to_ascii_lowercase();
            expanded
                .iter()
                .filter(|item| match type_filter {
                    "app" => item.get("type").and_then(Value::as_str) == Some("app"),
                    "plugin" => item.get("type").and_then(Value::as_str) != Some("app"),
                    _ => true,
                })
                .filter(|item| {
                    if needle.is_empty() {
                        return true;
                    }
                    let hay = [
                        item.get("name").and_then(Value::as_str).unwrap_or(""),
                        item.get("description")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        item.get("id").and_then(Value::as_str).unwrap_or(""),
                    ];
                    if hay.iter().any(|s| s.to_ascii_lowercase().contains(&needle)) {
                        return true;
                    }
                    item.get("topics")
                        .and_then(Value::as_array)
                        .is_some_and(|topics| {
                            topics.iter().any(|t| {
                                t.as_str()
                                    .is_some_and(|t| t.to_ascii_lowercase().contains(&needle))
                            })
                        })
                })
                .cloned()
                .collect()
        };

        assert_eq!(filter("", "").len(), 2);
        let apps = filter("app", "");
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0]["id"], "ghmp:acme/bazaar:canvas");
        let plugins = filter("plugin", "");
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0]["id"], "ghmp:acme/bazaar:thing-tool");
        // Searching "thing" finds the ENTRY by its display name, not just the repo.
        assert_eq!(filter("", "thing").len(), 1);
        // Searching the marketplace repo finds the entries too (the id carries it).
        assert_eq!(filter("", "bazaar").len(), 2);
        // A repo topic still matches its entries, as it did before the filter
        // moved from the record to the expanded item level.
        assert_eq!(filter("", "ryu-plugin").len(), 2);
    }
}
