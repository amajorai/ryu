//! RB-3: `host.spaces_search` under the `spaces:docs` grant must return chunks of
//! the calling app's own `app:<plugin_id>` documents only, never the user's
//! files or pages in the same Space and never another app's documents.

use super::*;

const QUERY: &str = "alpine harbour ledger";

/// The distinct document ids of a bridge search, in hit order.
async fn searched_docs(bridge: &PluginHookBridge, space_id: &str) -> Vec<String> {
    let outcome = bridge
        .handle(
            "host.spaces_search".to_owned(),
            json!({ "space_id": space_id, "query": QUERY, "limit": 50 }),
        )
        .await;
    let InvokeOutcome::Result(result) = outcome else {
        panic!("unexpected spaces_search outcome: {outcome:?}");
    };
    assert!(
        !result.is_error,
        "spaces_search refused: {:?}",
        result.error
    );
    let mut docs: Vec<String> = Vec::new();
    for hit in result.value["matches"].as_array().expect("a matches array") {
        let doc = hit["document_id"]
            .as_str()
            .expect("a document_id")
            .to_owned();
        if !docs.contains(&doc) {
            docs.push(doc);
        }
    }
    docs
}

#[tokio::test]
async fn spaces_search_returns_only_the_calling_apps_own_documents() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let store = &state.spaces;
    let owner = ryu_spaces::DocOwner::unattributed();
    let space_id = store
        .ensure_named_space("Meetings", None, &owner)
        .await
        .unwrap();
    // The user's own file in the Space, then one document per app.
    let user_doc = store
        .ingest_document(
            &space_id,
            "Board notes",
            &format!("{QUERY} private user notes"),
            &owner,
        )
        .await
        .unwrap();
    let mut app_docs = Vec::new();
    for plugin_id in ["@test/a", "@test/b"] {
        let doc = store
            .app_create_doc(plugin_id, &space_id, "App notes", &owner)
            .await
            .unwrap();
        store
            .app_update_doc(plugin_id, &doc, None, &format!("{QUERY} {plugin_id} notes"))
            .await
            .unwrap();
        app_docs.push(doc);
    }

    // The Space itself holds all three documents for this query, so an empty or
    // narrowed bridge result below comes from the app filter, not the fixture.
    let unrestricted = store
        .search_with(
            &space_id,
            QUERY,
            &ryu_spaces::SpaceSearchOptions {
                limit: 50,
                rerank: false,
                ..Default::default()
            },
            ryu_spaces::DocFilter::unrestricted(),
        )
        .await
        .unwrap();
    for doc in [&user_doc, &app_docs[0], &app_docs[1]] {
        assert!(
            unrestricted.iter().any(|hit| &hit.document_id == doc),
            "fixture document {doc} is not searchable"
        );
    }

    let grants = HashSet::from([GRANT_SPACES.to_owned()]);
    let app_a = PluginHookBridge::new("@test/a".to_owned(), grants.clone(), state.clone());
    let app_b = PluginHookBridge::new("@test/b".to_owned(), grants.clone(), state.clone());
    let app_c = PluginHookBridge::new("@test/c".to_owned(), grants, state.clone());
    assert_eq!(
        searched_docs(&app_a, &space_id).await,
        vec![app_docs[0].clone()]
    );
    assert_eq!(
        searched_docs(&app_b, &space_id).await,
        vec![app_docs[1].clone()]
    );
    assert!(
        searched_docs(&app_c, &space_id).await.is_empty(),
        "an app with no documents in the Space must find nothing"
    );
}

#[test]
fn own_docs_filter_matches_exactly_the_apps_kind() {
    let filter = ryu_rag::MetadataFilter::parse(&own_docs_filter("@test/a")).unwrap();
    let kind = |value: &str| {
        let mut metadata = serde_json::Map::new();
        metadata.insert("kind".to_owned(), json!(value));
        filter.matches(&metadata)
    };
    assert!(kind("app:@test/a"));
    for other in [
        "app:@test/ab",
        "app:@test",
        "app:@test/b",
        "page",
        "file",
        "",
    ] {
        assert!(!kind(other), "{other:?} must not match");
    }
    assert!(!filter.matches(&serde_json::Map::new()));
}

// The Sites exception. Sites answers visitors from a Space the site owner bound
// to a Site, so the official Sites package keeps whole-Space search. The tests
// below pin who gets the exception and who does not.

const SITES: &str = crate::plugins::builtins::SITES_PLUGIN_ID;

/// A Space with one user file and one document each for `@test/a` and Sites.
struct BoundSpace {
    _directory: tempfile::TempDir,
    state: ServerState,
    space_id: String,
    user_doc: String,
    other_app_doc: String,
    sites_doc: String,
}

async fn bound_space() -> BoundSpace {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let owner = ryu_spaces::DocOwner::unattributed();
    let space_id = state
        .spaces
        .ensure_named_space("Knowledge", None, &owner)
        .await
        .unwrap();
    let user_doc = state
        .spaces
        .ingest_document(
            &space_id,
            "Handbook",
            &format!("{QUERY} private user notes"),
            &owner,
        )
        .await
        .unwrap();
    let mut app_docs = Vec::new();
    for plugin_id in ["@test/a", SITES] {
        let doc = state
            .spaces
            .app_create_doc(plugin_id, &space_id, "App notes", &owner)
            .await
            .unwrap();
        state
            .spaces
            .app_update_doc(plugin_id, &doc, None, &format!("{QUERY} {plugin_id} notes"))
            .await
            .unwrap();
        app_docs.push(doc);
    }
    let sites_doc = app_docs.pop().unwrap();
    let other_app_doc = app_docs.pop().unwrap();
    BoundSpace {
        _directory: directory,
        state,
        space_id,
        user_doc,
        other_app_doc,
        sites_doc,
    }
}

/// The Sites manifest compiled into Core, the one Core holds at run time.
fn official_sites_manifest() -> crate::plugin_manifest::PluginManifest {
    crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .find(|manifest| manifest.id == SITES)
        .expect("the Sites manifest is compiled into Core")
}

/// What `plugin_id` finds in the bound Space when Core holds `manifests`.
async fn found_by(
    space: &BoundSpace,
    plugin_id: &str,
    manifests: Vec<crate::plugin_manifest::PluginManifest>,
) -> Vec<String> {
    *space.state.app_manifests.write().await = manifests;
    let bridge = PluginHookBridge::new(
        plugin_id.to_owned(),
        HashSet::from([GRANT_SPACES.to_owned()]),
        space.state.clone(),
    );
    searched_docs(&bridge, &space.space_id).await
}

/// GUARD, passes on main too. Sites keeps the reach it has today.
#[tokio::test]
async fn guard_official_sites_package_still_searches_the_whole_bound_space() {
    let space = bound_space().await;
    let manifest = official_sites_manifest();
    assert_eq!(
        crate::plugins::builtins::tier_for_manifest(&manifest),
        crate::plugin_manifest::PluginTier::Core,
        "the compiled Sites manifest must pass the official-package check"
    );
    let found = found_by(&space, SITES, vec![manifest]).await;
    for doc in [&space.user_doc, &space.other_app_doc, &space.sites_doc] {
        assert!(
            found.contains(doc),
            "Sites must still find {doc} in the bound Space, found {found:?}"
        );
    }
}

#[tokio::test]
async fn sites_id_on_a_changed_manifest_is_filtered_to_its_own_documents() {
    let space = bound_space().await;
    let mut copied = official_sites_manifest();
    copied.version = "999.0.0".to_owned();
    assert_eq!(
        found_by(&space, SITES, vec![copied]).await,
        vec![space.sites_doc.clone()],
        "a package that carries the Sites id without the official manifest is filtered"
    );
}

#[tokio::test]
async fn sites_id_with_no_manifest_in_core_is_filtered_to_its_own_documents() {
    let space = bound_space().await;
    assert_eq!(
        found_by(&space, SITES, Vec::new()).await,
        vec![space.sites_doc.clone()]
    );
}

/// Each id below owns no document in the Space, so a filtered search is empty.
/// Every one of them carries a full copy of the Sites manifest under its own id.
#[tokio::test]
async fn ids_that_only_look_like_sites_are_filtered() {
    let space = bound_space().await;
    let official = official_sites_manifest();
    for (look_alike, why) in [
        (
            "@ryu/sites-extra",
            "prefix, a different id after normalising",
        ),
        ("@ryu/sitesx", "prefix, a different id after normalising"),
        ("x@ryu/sites", "suffix, a different id after normalising"),
        (
            "@evil/@ryu/sites",
            "suffix, a different id after normalising",
        ),
        (
            "evil.com.ryu.sites",
            "suffix, a different id after normalising",
        ),
        ("@ryu/site", "shortened, a different id after normalising"),
        (
            " @Ryu/Sites ",
            "the SAME id after trim and lower case, but no official package has this id",
        ),
        (
            "@RYU/SITES",
            "the SAME id after lower case, but no official package has this id",
        ),
        (
            "com.ryu.sites",
            "a listed id, but no official package has this id",
        ),
    ] {
        let mut manifest = official.clone();
        manifest.id = look_alike.to_owned();
        let found = found_by(&space, look_alike, vec![manifest, official.clone()]).await;
        assert!(
            found.is_empty(),
            "{look_alike:?} ({why}) must be filtered, found {found:?}"
        );
    }
}

#[test]
fn reviewed_id_rule_trims_and_lower_cases_then_needs_an_exact_match() {
    // The same id after normalising. The id rule alone accepts these, which is
    // why the exception also needs the official-package check (tests above).
    for same in [
        "@ryu/sites",
        "com.ryu.sites",
        " @Ryu/Sites ",
        "@RYU/SITES",
        "\tCOM.RYU.SITES\n",
    ] {
        assert!(
            is_reviewed_whole_space_searcher_id(same),
            "{same:?} is a reviewed id after trim and lower case"
        );
    }
    // A different id after normalising. The id rule refuses these.
    for different in [
        "@ryu/sites-extra",
        "@ryu/sitesx",
        "@ryu/sites/x",
        "x@ryu/sites",
        "@evil/@ryu/sites",
        "evil.com.ryu.sites",
        "com.ryu.sites.evil",
        "@ryu/site",
        "@ryu/ sites",
        "ryu/sites",
        "@test/a",
        "",
    ] {
        assert!(
            !is_reviewed_whole_space_searcher_id(different),
            "{different:?} must not match"
        );
    }
}
