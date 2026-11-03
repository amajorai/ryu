//! Search parsing, classification, plates, banners and trust stamps.

use super::*;

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
