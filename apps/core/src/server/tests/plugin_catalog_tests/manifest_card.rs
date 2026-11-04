use super::*;

/// `origin` / `reviewed` / `source` are TRUST SIGNALS the consent surface
/// renders beside the permission grants (and, since #1, beside the
/// `mcp_servers` commands a plugin is about to spawn). `local_plugin_detail`
/// answers from `PluginManifestLoader::load()`, which returns the compiled-in
/// fixtures AND whatever the user dropped into the writable `~/.ryu/plugins` —
/// so the signals must key on PROVENANCE. A disk manifest labelled
/// `first_party` + `reviewed` would let anything that can write a directory
/// dress itself as a vetted first-party app on the exact screen where the user
/// decides whether to approve its grants, and (because this path answers before
/// the remote catalog source) shadow the genuine listing while doing it.
///
/// Both directions of the decision are pinned without touching the process-global
/// `RYU_PLUGINS_DIR` — mutating it here would race every other test that reads a
/// manifest. The compiled-in side is asserted end-to-end against the real
/// payload; the disk side is asserted on the exact predicate the branch keys on,
/// for ids a squatter can actually claim.
/// A built-in's DISPLAYED version is Core's, not its manifest's.
///
/// Every packaged manifest declares the authoring-time constant "1.0.0" and no
/// release bump rewrites it (the bump script covers Cargo.toml / package.json /
/// tauri.conf.json / Cargo.lock only). Relaying that string made the Store's
/// detail dialog advertise "v1.0.0" for every built-in app and plugin while Core
/// shipped 0.1.x — a version the user had never released.
///
/// Both projectors are pinned, because the dialog reads them in different
/// places: the hero stat takes `detail?.version ?? entry.version`, but the
/// Information grid reads `entry.version` ALONE. Fixing only the detail payload
/// leaves the grid still claiming 1.0.0.
#[test]
fn a_compiled_in_manifest_shows_cores_version() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load();
    let m = manifests
        .iter()
        .find(|m| crate::plugins::builtins::is_compiled_in_manifest(&m.id))
        .expect("at least one manifest is compiled in");
    let core_version = json!(env!("CARGO_PKG_VERSION"));
    assert_eq!(plugin_manifest_to_entry(m)["version"], core_version);
    assert_eq!(
        local_plugin_detail(&m.id).expect("compiled-in")["version"],
        core_version
    );

    // A disk manifest keeps its own version — it came from a catalog with a real
    // publish train, and overriding it would misreport every sideloaded build.
    let sideloaded = PluginManifest {
        id: "com.evil.plugin".to_owned(),
        name: "Sideloaded".to_owned(),
        version: "2.5.1".to_owned(),
        ..Default::default()
    };
    assert_eq!(display_version(&sideloaded), "2.5.1");
}

#[test]
fn local_detail_trust_signals_track_manifest_provenance() {
    let detail = local_plugin_detail("@ryu/ghost").expect("ghost is a compiled-in fixture");
    assert_eq!(detail["origin"], json!("first_party"));
    assert_eq!(detail["reviewed"], json!(true));
    assert_eq!(detail["source"], json!("built-in"));

    // A disk manifest can claim any id no fixture already holds. Those must NOT
    // take the reviewed/first-party branch above.
    for squatter in ["com.evil.plugin", "master", "gateway"] {
        assert!(
            !crate::plugins::builtins::is_compiled_in_manifest(squatter),
            "'{squatter}' must stay claimable by a disk manifest for this to mean anything"
        );
    }
    assert_eq!(
        local_detail_trust_signals(false),
        ("installed", "community", false),
        "a disk manifest must never be labelled reviewed/first-party"
    );
    assert_eq!(
        local_detail_trust_signals(true),
        ("built-in", "first_party", true)
    );
}

/// #449: the per-plugin external-runtime dir is namespaced under the plugin
/// id and ends in `runtime`, and the OS-correct venv interpreter derives
/// beneath it. This pins the arg/venv-path construction the live
/// `provision_external_runtime` call site relies on (the install itself is
/// best-effort and never run in a test).
#[test]
fn plugin_runtime_dir_is_namespaced_and_venv_derives() {
    let dir = plugin_runtime_dir("durable");
    // Namespaced under the plugin id, ending in the `runtime` segment.
    assert!(dir.ends_with("runtime"), "dir: {}", dir.display());
    assert!(
        dir.to_string_lossy().contains("durable"),
        "dir must be namespaced by plugin id: {}",
        dir.display()
    );
    // The venv interpreter derives OS-correctly under that dir (the exact
    // path the provisioner creates + pip-installs into).
    let python = crate::sidecar::external_runtime::venv_python(&dir);
    let s = python.to_string_lossy();
    assert!(s.contains(".venv"), "venv under runtime dir: {s}");
    if cfg!(target_os = "windows") {
        assert!(s.ends_with("python.exe"));
    } else {
        assert!(s.ends_with("python"));
    }
}

/// `manifest_policy_types` collects the `policy_type` of every Policy runnable
/// (the dispatch keys `apply_policy` switches on), and is empty for a manifest
/// with no Policy runnables.
#[test]
fn manifest_policy_types_collects_policy_kinds() {
    let with_policies = PluginManifest {
        id: "firewall".to_owned(),
        name: "FW".to_owned(),
        version: "1.0.0".to_owned(),
        runnables: vec![
            RunnableEntry {
                id: "p1".to_owned(),
                name: "p1".to_owned(),
                kind: RunnableKind::Policy,
                config: Some(json!({ "policy_type": "firewall", "definition": {} })),
            },
            RunnableEntry {
                id: "t1".to_owned(),
                name: "t1".to_owned(),
                kind: RunnableKind::Tool,
                config: Some(json!({ "slug": "x" })),
            },
        ],
        ..Default::default()
    };
    assert_eq!(manifest_policy_types(&with_policies), vec!["firewall"]);

    let no_policies = PluginManifest {
        id: "spider".to_owned(),
        name: "Spider".to_owned(),
        version: "1.0.0".to_owned(),
        runnables: vec![RunnableEntry {
            id: "t1".to_owned(),
            name: "t1".to_owned(),
            kind: RunnableKind::Tool,
            config: Some(json!({ "slug": "x" })),
        }],
        ..Default::default()
    };
    assert!(manifest_policy_types(&no_policies).is_empty());
}

#[test]
fn manifest_maps_to_entry_with_kinds() {
    let m = PluginManifest {
        id: "spider".to_owned(),
        name: "Spider".to_owned(),
        version: "1.2.3".to_owned(),
        runnables: vec![
            RunnableEntry {
                id: "crawl".to_owned(),
                name: "Crawl".to_owned(),
                kind: RunnableKind::Tool,
                config: None,
            },
            RunnableEntry {
                id: "scrape".to_owned(),
                name: "Scrape".to_owned(),
                kind: RunnableKind::Tool,
                config: None,
            },
        ],
        permission_grants: vec!["network.fetch".to_owned()],
        companion: None,
        ..Default::default()
    };
    let e = plugin_manifest_to_entry(&m);
    assert_eq!(e["id"], "spider");
    assert_eq!(e["name"], "Spider");
    assert_eq!(e["version"], "1.2.3");
    assert_eq!(e["source"], "built-in");
    // Duplicate kinds are deduped (two Tool runnables → one "tool").
    assert_eq!(e["kinds"], json!(["tool"]));
    assert_eq!(e["permission_grants"], json!(["network.fetch"]));
    // No destination of any kind → a plugin.
    assert_eq!(e["type"], "plugin");
}

/// `engines` and this node's verdict on it must be on the CARD, not only in the
/// detail payload — a browse grid greys a card and says "needs Core 0.2.0"
/// without fetching a detail document per tile. Before this, `engines` reached
/// only the version-detail document, which is why no marketplace surface has
/// ever reflected a version floor.
#[test]
fn engines_and_compatibility_reach_the_card() {
    let m = crate::plugin_manifest::PluginManifest {
        id: "floored".to_owned(),
        name: "Floored".to_owned(),
        version: "1.0.0".to_owned(),
        engines: Some(crate::plugin_manifest::EnginesReq {
            ryu: ">=0.0.1".to_owned(),
            mobile: Some(">=99.0.0".to_owned()),
            ..Default::default()
        }),
        ..Default::default()
    };
    let e = plugin_manifest_to_entry(&m);

    assert_eq!(e["engines"]["ryu"], ">=0.0.1");
    assert_eq!(e["engines"]["mobile"], ">=99.0.0");
    // Core satisfies its own floor, and `mobile` is a surface Core cannot
    // observe — so it is reported but must NOT make the plugin uninstallable.
    assert_eq!(
        e["compatibility"]["compatible"], true,
        "an unobservable surface must stay advisory"
    );
    assert_eq!(e["compatibility"]["unmet"][0]["code"], "unknown");
    assert_eq!(e["compatibility"]["unmet"][0]["surface"], "mobile");
}

/// A manifest with no `engines` block gets neither key — absent means "declares
/// no floors", which a client must be able to tell from "declares floors that
/// are all satisfied".
#[test]
fn a_manifest_without_engines_gets_no_compatibility_keys() {
    let m = crate::plugin_manifest::PluginManifest {
        id: "floorless".to_owned(),
        name: "Floorless".to_owned(),
        version: "1.0.0".to_owned(),
        ..Default::default()
    };
    let e = plugin_manifest_to_entry(&m);
    assert!(e.get("engines").is_none());
    assert!(e.get("compatibility").is_none());
}

/// A theme plugin's card carries its own palette so the Store can paint the
/// same swatch the Appearance tab's preset picker shows, instead of a generic
/// dither avatar. `contributes.themes[0].preview` is projected verbatim (all
/// four swatch colours + the mode); a plugin that contributes no theme gets no
/// `theme_preview` key at all, so non-theme cards stay byte-identical.
#[test]
fn manifest_theme_preview_reaches_the_card() {
    let m: PluginManifest = serde_json::from_value(json!({
        "id": "@acme/midnight-theme",
        "name": "Midnight Theme",
        "version": "1.0.0",
        "runnables": [],
        "category": "Themes",
        "contributes": {
            "themes": [{
                "id": "@acme/midnight-theme:midnight",
                "label": "Midnight",
                "mode": "dark",
                "preview": {
                    "bg": "#0b0e14",
                    "surface": "#141926",
                    "primary": "#7c9cff",
                    "text": "#e6e9f0",
                },
                "tokens": { "--background": "#0b0e14" },
            }],
        },
    }))
    .expect("fixture manifest parses");

    let e = plugin_manifest_to_entry(&m);
    assert_eq!(e["theme_preview"]["bg"], "#0b0e14");
    assert_eq!(e["theme_preview"]["surface"], "#141926");
    assert_eq!(e["theme_preview"]["primary"], "#7c9cff");
    assert_eq!(e["theme_preview"]["text"], "#e6e9f0");
    assert_eq!(e["theme_preview"]["mode"], "dark");

    // Only the FIRST theme preview travels — the card paints the listing's
    // own swatch, and the picker reads every theme from the manifest itself.
    let multi: PluginManifest = serde_json::from_value(json!({
        "id": "@acme/duo-theme",
        "name": "Duo Theme",
        "version": "1.0.0",
        "runnables": [],
        "contributes": {
            "themes": [
                { "id": "a", "label": "A", "mode": "light",
                  "preview": { "bg": "#fff", "surface": "#eee", "primary": "#0af", "text": "#111" },
                  "tokens": {} },
                { "id": "b", "label": "B", "mode": "dark",
                  "preview": { "bg": "#000", "surface": "#111", "primary": "#f00", "text": "#eee" },
                  "tokens": {} },
            ],
        },
    }))
    .expect("fixture manifest parses");
    assert_eq!(
        plugin_manifest_to_entry(&multi)["theme_preview"]["bg"],
        "#fff"
    );

    // And a non-theme manifest emits no key at all.
    let bare: PluginManifest = serde_json::from_value(json!({
        "id": "acme/tool",
        "name": "Tool",
        "version": "1.0.0",
        "runnables": [],
    }))
    .expect("fixture manifest parses");
    assert!(plugin_manifest_to_entry(&bare)
        .get("theme_preview")
        .is_none());
}

/// A manifest's `banner` reaches the card VERBATIM, whatever keys it carries.
///
/// The banner is how a listing declares its own hero background instead of
/// inheriting the wash derived from its icon, and Core is deliberately not a
/// party to that decision: `PluginManifest::banner` is `serde_json::Value` and
/// this projection copies the whole object across. That is what lets the client
/// grow a new treatment key (`background`, `imageUrl`, `style: "flat"`) with no
/// Core release — but only for as long as nobody "tidies" this into a typed
/// struct, at which point every key the struct does not know would be silently
/// dropped by serde and the feature would look like a client bug.
///
/// So the assertion is on an object Core has never heard of, not on the three
/// keys it was written against.
#[test]
fn manifest_banner_reaches_the_card_verbatim_including_unknown_keys() {
    let banner = json!({
        "background": "linear-gradient(135deg, #0099ff, #6633ff)",
        "imageUrl": "https://example.test/hero.png",
        "style": "flat",
        "seed": 7,
        "unheard-of": { "nested": [1, 2, 3] },
    });
    let m: PluginManifest = serde_json::from_value(json!({
        "id": "acme/banner",
        "name": "Banner",
        "version": "1.0.0",
        "runnables": [],
        "banner": banner.clone(),
        "iconDither": { "from": 210, "to": "transparent", "direction": "down" },
    }))
    .expect("fixture manifest parses");

    let e = plugin_manifest_to_entry(&m);
    assert_eq!(e["banner"], banner, "banner is an opaque passthrough");
    // The derived tier still ships alongside it: the client decides which one
    // wins, so dropping `icon_dither` once a banner exists would take the
    // choice away from it.
    assert_eq!(e["icon_dither"]["from"], 210);

    // And a manifest with no banner emits no key at all, rather than a null the
    // client would have to distinguish from an empty spec.
    let bare: PluginManifest = serde_json::from_value(json!({
        "id": "acme/bare",
        "name": "Bare",
        "version": "1.0.0",
        "runnables": [],
    }))
    .expect("fixture manifest parses");
    assert!(plugin_manifest_to_entry(&bare).get("banner").is_none());
}

/// `deprecated` reaches the card normalised to `{message?, replacement?}` in
/// every authoring shape, and a current listing emits no key at all.
#[test]
fn catalog_entry_projects_normalised_deprecation() {
    let manifest = |deprecated: serde_json::Value| -> PluginManifest {
        serde_json::from_value(json!({
            "id": "acme/old",
            "name": "Old",
            "version": "1.0.0",
            "runnables": [],
            "deprecated": deprecated,
        }))
        .expect("fixture manifest parses")
    };

    let e = plugin_manifest_to_entry(&manifest(json!({
        "message": "Superseded by New.",
        "replacement": "acme/new",
    })));
    assert_eq!(
        e["deprecated"],
        json!({ "message": "Superseded by New.", "replacement": "acme/new" })
    );
    assert_eq!(
        plugin_manifest_to_entry(&manifest(json!("Use acme/new.")))["deprecated"],
        json!({ "message": "Use acme/new." })
    );
    assert_eq!(
        plugin_manifest_to_entry(&manifest(json!(true)))["deprecated"],
        json!({})
    );
    assert!(plugin_manifest_to_entry(&manifest(json!(false)))
        .get("deprecated")
        .is_none());
}
