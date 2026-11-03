//! The catalog card projected from one topic record.

use super::*;
use crate::catalog_source::brand_guard::is_protected_brand_name;

/// An unreviewed listing never presents itself under a protected vendor's or
/// Ryu's own name (`Claude Opus Desktop`, `ChatGPT`, `Ryu Pro`, lookalikes
/// included): it is shown as `fallback` (`owner/repo`), which names who actually
/// published it. The same rule the web store applies to its community cards.
pub(super) fn guarded_display_name(declared: String, fallback: &str) -> String {
    if is_protected_brand_name(&declared) {
        fallback.to_owned()
    } else {
        declared
    }
}

/// A declared glyph id that names a protected brand (`svgl:claude-ai`) is
/// dropped, as is every declared glyph of a guarded card.
pub(super) fn guarded_icon_id(icon: Option<String>, guarded: bool) -> Option<String> {
    icon.filter(|icon| !guarded && !is_protected_brand_name(icon))
}

/// Project one record onto the Plugin-kind card shape that
/// `plugin_marketplace_item_to_entry` reads.
///
/// **Presentation comes from the repo's manifest, identity from GitHub.** The
/// manifest supplies `name` / `icon` / `description` / `version` / `tagline` /
/// `category` — what the publisher declared this thing is called and looks like.
/// GitHub keeps `id`, `developer`, `owner`, and the trust triple, because those
/// answer "who published this and has anyone vetted it", which a repo must not be
/// able to author about itself. See [`RepoManifestDisplay`]. A declared name that
/// reads as a protected brand is replaced by `owner/repo` and the card keeps
/// none of its declared art ([`guarded_display_name`]).
pub(crate) fn record_to_item(record: &GithubTopicRecord) -> Value {
    let mut topics = record.topics.clone();
    if record.is_fork {
        topics.push("fork".to_string());
    }
    let manifest = record.manifest.as_ref();
    let manifest_str =
        |pick: fn(&RepoManifestDisplay) -> Option<&String>| manifest.and_then(pick).cloned();
    let declared_name = manifest_str(|m| m.name.as_ref()).unwrap_or_else(|| record.repo.clone());
    let guarded = is_protected_brand_name(&declared_name);
    let name = guarded_display_name(declared_name, &record.full_name);
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
        // A card guarded as a protected brand keeps none of its declared art.
        "icon": guarded_icon_id(manifest_str(|m| m.icon.as_ref()), guarded),
        "icon_url": manifest_str(|m| m.icon_url.as_ref()).filter(|_| !guarded),
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
        "banner": manifest.and_then(|m| m.banner.clone()).filter(|_| !guarded),
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
