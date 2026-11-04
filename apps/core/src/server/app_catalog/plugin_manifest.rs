//! App catalog browse, install-from-URL and hot reload: `plugin_manifest_to_entry` through `plugin_manifest_to_entry`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) fn plugin_manifest_to_entry(
    m: &crate::plugin_manifest::PluginManifest,
) -> serde_json::Value {
    let kinds: Vec<&str> = {
        let mut s = std::collections::HashSet::new();
        m.runnables
            .iter()
            .filter_map(|r| {
                let k = r.kind.as_str();
                if s.insert(k) {
                    Some(k)
                } else {
                    None
                }
            })
            .collect()
    };
    // Explicit app-vs-plugin discriminator: an app claims a UI DESTINATION (a
    // companion window, a workspace dock tab, or a top-level route) — everything
    // else is a plugin. See `manifest_declares_destination` for why those three keys
    // and no others. Emitted so the browse client no longer has to derive app-ness
    // from `kinds.contains("companion")`, which is the same rule minus dock panels
    // and route claims — i.e. the rule that filed Browser, Simulator, CRM, UGC,
    // Dashboards, Drafts and Mission Control as plugins.
    let is_app = manifest_declares_destination(m);
    let mut entry = json!({
        "id": m.id,
        "name": m.name,
        "description": m.description.clone().unwrap_or_default(),
        "version": display_version(m),
        "source": "built-in",
        "kinds": kinds,
        "type": if is_app { "app" } else { "plugin" },
        "tags": if m.tags.is_empty() { m.keywords.clone() } else { m.tags.clone() },
        "permission_grants": m.permission_grants,
        "built_in": crate::plugins::builtins::find_system_plugin(&m.id).is_some(),
        // Same predicate the uninstall refuses on, never a manifest claim.
        "system": crate::plugins::builtins::is_system_labelled(&m.id),
        "layers": manifest_layer_projection(m),
    });
    // Rich marketplace-detail contract keys (Phase 1.5). Additive — emitted only
    // when the manifest carries the source data (capabilities/runnables are always
    // present because they derive from grants/runnables). Never invents data.
    if let Some(obj) = entry.as_object_mut() {
        merge_plugin_contract_fields(obj, m);
        // Snake_case card/hero presentation keys (the browse card + hero read snake).
        if let Some(icon) = &m.icon_url {
            obj.insert("icon_url".to_owned(), json!(icon));
        }
        // Icon-primitive glyph id: the manifest's `icon`, else the Companion
        // surface's `icon` (how built-in apps author their glyph) so a built-in
        // lights up its card without a redundant top-level field.
        if let Some(icon) = m
            .icon
            .clone()
            .or_else(|| m.companion.as_ref().and_then(|c| c.icon.clone()))
        {
            obj.insert("icon".to_owned(), json!(icon));
        }
        if let Some(dither) = &m.icon_dither {
            obj.insert("icon_dither".to_owned(), dither.clone());
        }
        if let Some(bg) = &m.icon_background {
            obj.insert("icon_background".to_owned(), json!(bg));
        }
        if let Some(pad) = &m.icon_padding {
            obj.insert("icon_padding".to_owned(), json!(pad));
        }
        if let Some(accent) = &m.accent_color {
            obj.insert("accent_color".to_owned(), json!(accent));
        }
        if let Some(banner) = &m.banner {
            obj.insert("banner".to_owned(), banner.clone());
        }
        if let Some(dev) = m.developer() {
            obj.insert("developer".to_owned(), json!(dev));
        }
        if let Some(tagline) = &m.tagline {
            obj.insert("tagline".to_owned(), json!(tagline));
        }
        if let Some(category) = &m.category {
            obj.insert("category".to_owned(), json!(category));
        }
        // A theme plugin's card square should be its own palette — the same
        // swatch the Appearance tab's preset picker paints — rather than a
        // generative dither avatar or a generic glyph. Project the FIRST theme's
        // preview onto the card so the client can paint it; emitted only when the
        // manifest actually contributes themes, so an ordinary plugin's card stays
        // byte-identical. `contributes.themes` is a typed field (pure design
        // tokens, no code), so nothing executable can ride this key.
        if let Some(c) = &m.contributes {
            if let Some(theme) = c.themes.first() {
                obj.insert(
                    "theme_preview".to_owned(),
                    json!({
                        "bg": theme.preview.bg,
                        "surface": theme.preview.surface,
                        "primary": theme.preview.primary,
                        "text": theme.preview.text,
                        "mode": theme.mode,
                    }),
                );
            }
        }
        // Listing-posture keys. Each is emitted ONLY when it is the non-default, so
        // an ordinary listing's card JSON is byte-identical to what it was before
        // these existed and no client has to learn three new always-present fields.
        if m.hidden {
            obj.insert("hidden".to_owned(), json!(true));
        }
        if let Some(stability) = m
            .stability
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("stable"))
        {
            obj.insert("stability".to_owned(), json!(stability.to_lowercase()));
        }
        // `mandatory` comes from Core's own constant, NOT the manifest's claim of it.
        // A card is rendered from untrusted catalog data, and this bit is what makes
        // the client hide the Disable control — sourcing it from the manifest would
        // let any listing render itself as undisableable, which is a lie the
        // lifecycle would then refuse to back up.
        if crate::plugins::builtins::is_mandatory(&m.id) {
            obj.insert("mandatory".to_owned(), json!(true));
        }
        // Publisher identity — the gold check beside the NAME. Server-DERIVED, never
        // a manifest claim, for the same reason `mandatory` above is: a listing that
        // could author its own verification would badge itself.
        //
        // The predicate is PROVENANCE (`is_compiled_in_manifest`: the manifest ships
        // inside this binary), the same discriminator `local_plugin_detail` already
        // uses to decide `reviewed` — not the `@ryu/` scope, which is just a string
        // anything under `~/.ryu/plugins` can write, and not `find_system_plugin`,
        // which names the four sidecar-backed system plugins and would badge Ghost
        // while leaving Calendar bare. Id comparison is safe here because the loader
        // parses built-ins first and rejects duplicate ids, so a disk manifest can
        // never take a compiled-in id.
        //
        // This has to happen HERE rather than by field-merging the hosted card that
        // carries `orgVerified`: `merge_plugin_catalog_entries` is whole-entry
        // first-writer-wins (load-bearing for the `hidden` suppression), and a
        // built-in's manifest entry always wins its id, so the hosted card is
        // discarded entirely and never reaches the client.
        if crate::plugins::builtins::is_exact_compiled_manifest(m) {
            obj.insert("org_verified".to_owned(), json!(true));
            obj.insert("org_verified_tier".to_owned(), json!("official"));
            obj.insert("publisher_trust".to_owned(), json!("gold"));
            obj.insert("publisher_trust_source".to_owned(), json!("ryu_staff"));
        }
    }
    entry
}
