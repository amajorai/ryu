//! App catalog browse, install-from-URL and hot reload: `plugin_marketplace_item_to_entry` through `BLOCKED_METADATA_HOSTS`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Map one Ryu-marketplace plugin item (`{ id, name, description, version, … }`,
/// the `RyuMarketplaceSource` plugin card shape) to a Plugins-catalog
/// `CatalogEntry`. Returns `None` when the item carries no id.
pub(in crate::server) fn plugin_marketplace_item_to_entry(
    it: &serde_json::Value,
    source_id: &str,
) -> Option<serde_json::Value> {
    let id = it.get("id").and_then(|v| v.as_str())?;
    let integration_kind = it
        .get("integration_kind")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let category = it
        .get("category")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let domain = it
        .get("domain")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let integration_url = it
        .get("url")
        .or_else(|| it.get("install_source"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let icon_url = it
        .get("icon_url")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let mut kinds: Vec<String> = Vec::new();
    if let Some(k) = &integration_kind {
        kinds.push(k.clone());
    }
    // App-ness for a REMOTE card: a marketplace card carries no runnables, so a
    // built-in's "companion" kind (derived from its Companion runnable) is absent
    // here. The card discloses it via `has_companion`; surfacing "companion" in
    // `kinds` is what makes the browse client's `isCompanionApp` classify a
    // canvas/whiteboard/finetune card as an app instead of collapsing it to a plugin.
    if it.get("has_companion").and_then(|v| v.as_bool()) == Some(true) {
        kinds.push("companion".to_owned());
    }
    let mut tags: Vec<String> = it
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if tags.is_empty() {
        tags = Vec::new();
    }
    if let Some(c) = &category {
        tags.push(c.clone());
    }
    if let Some(d) = &domain {
        if tags.is_empty() {
            tags.push(d.clone());
        }
    }
    // Browse-but-don't-install. The card may declare it itself (the GitHub-topic
    // source stamps `descriptor_only: true` on every unreviewed listing); the
    // legacy integrations.sh source predates the field, so its id is the fallback.
    let descriptor_only = it
        .get("descriptor_only")
        .and_then(|v| v.as_bool())
        .unwrap_or(source_id == "integrations-sh");
    // Explicit app-vs-plugin type for a REMOTE card. Precedence: the card's own
    // `type` (the publisher's explicit declaration) → `has_companion`. A card
    // lacking both is a plugin. (Builtin apps that the remote repo lists without
    // these flags are re-classified from their compiled fixture in
    // `merged_plugin_catalog_entries`, which wins the id dedup.)
    let item_type = match it.get("type").and_then(|v| v.as_str()) {
        Some("app") => "app",
        Some("plugin") => "plugin",
        _ => {
            if it.get("has_companion").and_then(|v| v.as_bool()) == Some(true) {
                "app"
            } else {
                "plugin"
            }
        }
    };
    let mut entry = json!({
        "id": id,
        "name": it.get("name").and_then(|v| v.as_str()).unwrap_or(id),
        "description": it.get("description").and_then(|v| v.as_str()).unwrap_or(""),
        "version": it.get("version").and_then(|v| v.as_str()).unwrap_or(""),
        "category": category,
        "source": source_id,
        "kinds": kinds,
        "type": item_type,
        "tags": tags,
        "permission_grants": [],
        "built_in": false,
        "descriptor_only": descriptor_only,
        "integration_kind": integration_kind,
        "integration_url": integration_url,
        "icon_url": icon_url,
    });
    // Carry the source card's `requires` / `targets` onto the entry when the
    // publisher declared them, so a marketplace card is as honest about its
    // dependency closure as a built-in card is. Passed through verbatim (the card
    // is untrusted upstream JSON): the AUTHORITATIVE copy is the one on the signed
    // manifest, which `install_plugin_from_catalog` resolves at install time — an
    // absent or lying card field is a display gap, never a safety gap. `targets` is
    // omitted when empty, since empty means EVERY surface.
    if let Some(obj) = entry.as_object_mut() {
        if let Some(requires) = it.get("requires").filter(|v| !v.is_null()) {
            obj.insert("requires".to_owned(), requires.clone());
        }
        if let Some(targets) = it
            .get("targets")
            .and_then(|v| v.as_array())
            .filter(|a| !a.is_empty())
        {
            obj.insert("targets".to_owned(), json!(targets));
        }
        // `engines` gets the same treatment, plus a verdict computed HERE — the
        // hosted card cannot carry one, because the registry has no idea what
        // versions this node is running.
        //
        // Same trust posture as `requires` above: the card is untrusted upstream
        // JSON and this is a DISPLAY path, so a lying or absent field costs a greyed
        // badge, never safety. The authoritative check runs against the signed
        // manifest in `resolve_plugin_from_catalog`, which refuses the install
        // regardless of what the card claimed.
        if let Some(engines) = it.get("engines").filter(|v| v.is_object()).and_then(|v| {
            serde_json::from_value::<crate::plugin_manifest::EnginesReq>(v.clone()).ok()
        }) {
            obj.insert("engines".to_owned(), json!(engines));
            obj.insert(
                "compatibility".to_owned(),
                json!(crate::plugin_manifest::node_host_versions().evaluate(Some(&engines))),
            );
        }
        for key in [
            "icon",
            "icon_background",
            "icon_padding",
            "accent_color",
            "developer",
            "tagline",
            // Community/provenance disclosure. `origin` is THE discriminator the
            // store's Community section and its "not reviewed by Ryu" notice key
            // on — it must stay snake_case end-to-end (a camelCase `origin` reads
            // as undefined on the client, i.e. an unreviewed listing rendered
            // without its notice). `repo_url` backs the link-out CTA.
            "origin",
            "provenance",
            "repo_url",
            "license",
            "repository_url",
            "homepage",
            // The grouping stamp a community MARKETPLACE entry carries, naming the
            // marketplace its row belongs under ("Community Marketplaces" →
            // sub-heading). Only meaningful on the `github-topic` feed; the
            // `all` view overwrites both with the browsed source's own meta.
            "catalog_source_id",
            "catalog_source_name",
            // Publisher identity. `org_verified_tier` only ever QUALIFIES the check
            // ("Verified organization — Partner"); the flag below is what renders it,
            // so a tier arriving without the flag correctly shows nothing. Snake_case
            // end to end for the same reason as `origin` above — a camelCase key
            // reads as undefined on the client and silently keeps the badge dark.
            "org_verified_tier",
            "publisher_trust",
            "publisher_trust_source",
        ] {
            if let Some(v) = it.get(key).and_then(|v| v.as_str()) {
                obj.insert(key.to_owned(), json!(v));
            }
        }
        // Non-string passthroughs (the loop above copies strings only).
        if let Some(reviewed) = it.get("reviewed").and_then(|v| v.as_bool()) {
            obj.insert("reviewed".to_owned(), json!(reviewed));
        }
        if let Some(external) = it.get("external").and_then(|v| v.as_bool()) {
            obj.insert("external".to_owned(), json!(external));
        }
        // Remix policy and credit. Copied INCLUDING `false` (that is the opt-out);
        // absent stays absent and the store reads it as the default, allowed.
        if let Some(allow_remix) = it.get("allow_remix").and_then(|v| v.as_bool()) {
            obj.insert("allow_remix".to_owned(), json!(allow_remix));
        }
        if let Some(source) = it.get("remixed_from").filter(|v| v.is_object()) {
            obj.insert("remixed_from".to_owned(), source.clone());
        }
        for key in [
            "layers",
            "screenshots",
            "tags",
            "keywords",
            "example_prompts",
            "capabilities",
        ] {
            if let Some(value) = it.get(key).filter(|v| v.is_array()) {
                obj.insert(key.to_owned(), value.clone());
            }
        }
        // A theme listing's palette, when the source card carries one — the card
        // the store renders must show the theme's own swatch, not a dither avatar.
        // Pure colour strings from the marketplace server; the render layer
        // validates + falls back, same as `icon_dither`.
        if let Some(preview) = it.get("theme_preview").filter(|v| v.is_object()) {
            obj.insert("theme_preview".to_owned(), preview.clone());
        }
        // Is the PUBLISHING ORGANIZATION identity-checked? A separate axis from
        // `reviewed` (did anyone read the code) and from manifest signing, and it
        // rides the community shelf too — an unreviewed listing from a verified
        // publisher is still from a verified publisher. Copied verbatim, INCLUDING a
        // `false` (that is how a revoked check propagates); absent stays absent, so a
        // source that never computes it is never flattened to "not verified".
        if let Some(verified) = it.get("org_verified").and_then(|v| v.as_bool()) {
            obj.insert("org_verified".to_owned(), json!(verified));
        }
        if let Some(stars) = it.get("stars").and_then(serde_json::Value::as_u64) {
            obj.insert("stars".to_owned(), json!(stars));
        }
        // Public release-asset downloads are a discovery signal. The source has
        // already excluded signatures/manifests/text metadata, so preserve it on
        // the card rather than making each renderer re-fetch release history.
        if let Some(downloads) = it.get("downloads").and_then(serde_json::Value::as_u64) {
            obj.insert("downloads".to_owned(), json!(downloads));
        }
        // Commerce + social proof. Load-bearing for the UNIFIED first-party view:
        // the hosted (paid) and git (free) catalogs are merged into one list, so a
        // paid listing that dropped its `pricing` here would render identically to
        // a free one and only reveal its price at checkout. `rating_average` /
        // `rating_count` back the star summary on the card and the Reviews tab
        // header; `first_party` orders first-party above third-party.
        if let Some(pricing) = it.get("pricing").filter(|v| v.is_object()) {
            obj.insert("pricing".to_owned(), pricing.clone());
        }
        if let Some(avg) = it.get("rating_average").and_then(serde_json::Value::as_f64) {
            if avg > 0.0 {
                obj.insert("rating_average".to_owned(), json!(avg));
            }
        }
        if let Some(count) = it.get("rating_count").and_then(serde_json::Value::as_u64) {
            if count > 0 {
                obj.insert("rating_count".to_owned(), json!(count));
            }
        }
        if it.get("first_party").and_then(|v| v.as_bool()) == Some(true) {
            obj.insert("first_party".to_owned(), json!(true));
        }
        if let Some(dither) = it.get("icon_dither").filter(|v| v.is_object()) {
            obj.insert("icon_dither".to_owned(), dither.clone());
        }
        if let Some(banner) = it.get("banner").filter(|v| v.is_object()) {
            obj.insert("banner".to_owned(), banner.clone());
        }
    }
    Some(entry)
}

/// Merge plugin-catalog entry groups into one list, deduped by `id` (first writer
/// wins, in group order). Pure, so it is unit-testable without a live
/// `ServerState`. An entry with no string `id` is dropped.
pub(in crate::server) fn merge_plugin_catalog_entries(
    groups: Vec<Vec<serde_json::Value>>,
) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for group in groups {
        for e in group {
            if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
                if seen.insert(id.to_owned()) {
                    out.push(e);
                }
            }
        }
    }
    out
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct InstallFromUrlRequest {
    pub(in crate::server) url: String,
}

/// SSRF guard for a single resolved IPv4 address: loopback (127/8), RFC1918
/// private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, includes the
/// cloud metadata endpoint), unspecified (0.0.0.0), the 0.0.0.0/8 block,
/// broadcast, and CGNAT shared space (100.64/10).
pub(in crate::server) fn is_blocked_ipv4(v4: std::net::Ipv4Addr) -> bool {
    ryu_egress::is_blocked_ip(std::net::IpAddr::V4(v4))
}

/// SSRF guard for a single resolved IP. Rejects loopback / private / link-local
/// ranges for both families, IPv6 unique-local (fc00::/7) and link-local
/// (fe80::/10), and any IPv4-mapped form of a blocked v4 address.
pub(crate) fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    ryu_egress::is_blocked_ip(ip)
}

/// Cloud-metadata hostnames that must never be fetched, in addition to the
/// 169.254.169.254 IP already screened by [`is_blocked_ip`]. Matched
/// case-insensitively as an exact host or a domain suffix.
pub(in crate::server) const BLOCKED_METADATA_HOSTS: &[&str] =
    &["metadata.google.internal", "metadata.goog"];
