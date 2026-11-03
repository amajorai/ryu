//! The presentation a community repo declares in its own manifest.

use super::*;

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
    pub(super) name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) icon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) stability: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) tagline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) category: Option<String>,
    /// The icon square's painted plate — the same two keys every first-party
    /// manifest declares. Without them a community card falls through `AppIcon`'s
    /// flat `bg-muted` branch while every listing beside it gets a coloured
    /// gradient, which is the whole reason the community shelf read as a different
    /// component. Validated, never passed through: see [`scrub_icon_dither`] /
    /// [`scrub_css_color`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) icon_dither: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) icon_background: Option<String>,
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
    pub(super) banner: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) repository_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) author: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) developer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) license: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) screenshots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) example_prompts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) privacy_policy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) terms_of_service_url: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) external: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) layers: Vec<Value>,
    /// Bounded support rows from the manifest's `surfaces` map. Stored in the
    /// discovery cache so the community card can explain support before detail
    /// enrichment runs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) surface_support: Vec<Value>,
    /// Does the manifest claim a UI DESTINATION — a companion runnable, a dock
    /// panel, or a top-level sidebar-button target? The same three keys Core's own
    /// `manifest_declares_destination` reads, so one rule decides app-vs-plugin for
    /// a community repo and for a built-in.
    ///
    /// Used for ONE thing: breaking the tie when a repo carries BOTH topics (see
    /// [`resolve_dual_topic_classification`]). A single-topic repo is classified by
    /// its topic, full stop — this never overrides a publisher who tagged one topic.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) has_destination: bool,
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
                .then(|| crate::catalog_source::manifest_surface::project_surface_support(manifest))
                .unwrap_or_default(),
            has_destination: manifest_claims_destination(obj),
        };
        (out != Self::default()).then_some(out)
    }
}
