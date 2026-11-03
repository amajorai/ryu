//! Community marketplace collections and their package entries.

use super::*;

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
    pub(super) name: String,
    /// The parsed plugin entries. `from_manifest` returns `None` when nothing
    /// survives, so `Some` here always has at least one entry.
    pub(super) entries: Vec<GithubMarketplaceEntry>,
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
    pub(super) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) tagline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) icon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) icon_dither: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) icon_background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) banner: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) surface_support: Vec<Value>,
    /// True when the entry ships a Companion UI surface — classified as an "app".
    #[serde(default)]
    pub(super) has_companion: bool,
    /// The plugin's OWN repository as an https URL (`source_repo`), or `None`
    /// when `source` was absent or did not resolve to a GitHub repo / http(s) URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) source_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) tags: Vec<String>,
    /// Folder path inside the collection. This is the package identity source;
    /// it replaces the legacy marketplace.json entry pointer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) package_path: Option<String>,
}

impl GithubMarketplace {
    /// Parse a loosely-typed `marketplace.json` into the display allowlist.
    /// `None` when the manifest declares no entries worth showing (which also
    /// covers a repo that tags the topic but has not added a manifest yet — it
    /// degrades to a single repo listing).
    pub(super) fn from_manifest(manifest: &Value, repo_full_name: &str) -> Option<Self> {
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
    pub(super) fn from_manifest(plugin: &Value) -> Option<Self> {
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
            surface_support: crate::catalog_source::manifest_surface::project_surface_support(
                plugin,
            ),
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
    pub(super) fn from_package_manifest(
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
pub(super) fn resolve_entry_source(value: Option<&Value>) -> Option<String> {
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
    if let Some((owner, repo)) = crate::catalog_source::split_github_repo(trimmed) {
        return Some(format!("https://github.com/{owner}/{repo}"));
    }
    // Otherwise only an explicit http(s) URL travels.
    sanitize_url(trimmed)
}
