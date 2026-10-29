//! `GET /api/spaces/:id/documents/:doc_id/backlinks` must authorize every
//! linking SOURCE document, not only the target: each row carries the source's
//! id, title, and a body-derived snippet.

use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn member(user_id: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

/// Restores a Space's persisted ACL overwrites on drop (a failed assertion
/// included), so this test never leaves a rule in the shared ACL store.
struct RestoredSpaceAcl {
    key: crate::acl::store::ResourceKey,
    previous: Vec<crate::acl::store::StoredOverwrite>,
}

impl Drop for RestoredSpaceAcl {
    fn drop(&mut self) {
        let _ = crate::acl::store::set_overwrites(&self.key, self.previous.clone());
    }
}

async fn backlink_sources(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    space_id: &str,
    doc_id: &str,
) -> (StatusCode, Vec<String>, String) {
    let response = get_document_backlinks(
        State(state.clone()),
        axum::Extension(caller.clone()),
        axum::extract::Path((space_id.to_owned(), doc_id.to_owned())),
    )
    .await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let mut sources: Vec<String> = body["backlinks"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row["src_doc_id"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    sources.sort();
    (status, sources, raw)
}

fn owned(user_id: &str) -> spaces::DocOwner {
    spaces::DocOwner::owned(Some(user_id), Some("org1"))
}

async fn org_space(store: &spaces::SpaceStore, name: &str, owner: &str) -> String {
    store
        .create_space_with_mode_and_visibility(
            name,
            None,
            spaces::RetrievalMode::default(),
            &owned(owner),
            "org",
            None,
        )
        .await
        .unwrap()
}

/// The finding's exploit state: one PRIVATE Space holds Bob's org-visible target,
/// Alice's private page linking `[[Team page]]`, and an org-visible page linking
/// the same title. `[[Title]]` links resolve only within a Space, so this is the
/// state in which a private source can produce a backlink row at all.
#[tokio::test]
async fn backlinks_return_only_sources_the_caller_may_read() {
    let directory = tempfile::tempdir().unwrap();
    let state = super::workflow_version_revision_tests::handler_state(directory.path());
    let store = &state.spaces;

    let private_space = store
        .create_space("Alice private", None, &owned("alice"))
        .await
        .unwrap();
    // Bob's page in that Space, shared with the whole org at document level.
    let target = store
        .create_page(&private_space, "Team page", &owned("bob"))
        .await
        .unwrap();
    assert!(store
        .set_document_access(&target, "org", None)
        .await
        .unwrap());
    // Alice's PRIVATE page links to it; its title and body must not reach Bob.
    let private_source = store
        .create_page(&private_space, "Alice secret", &owned("alice"))
        .await
        .unwrap();
    store
        .update_document(
            &private_source,
            "Alice secret",
            "acquisition codename Falcon links to [[Team page]]",
        )
        .await
        .unwrap();
    // Carol's org-visible page links to it from the same Space.
    let shared_source = store
        .create_page(&private_space, "Carol notes", &owned("carol"))
        .await
        .unwrap();
    assert!(store
        .set_document_access(&shared_source, "org", None)
        .await
        .unwrap());
    store
        .update_document(&shared_source, "Carol notes", "see [[Team page]]")
        .await
        .unwrap();

    with_test_node_binding(true, Some(org_node()), async {
        // Alice (owner of the private source) sees both backlinks: the rows exist.
        let (status, sources, raw) =
            backlink_sources(&state, &member("alice"), &private_space, &target).await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        let mut expected = vec![private_source.clone(), shared_source.clone()];
        expected.sort();
        assert_eq!(sources, expected);
        assert!(raw.contains("Falcon"), "{raw}");

        // Bob may read the org-visible target, but not Alice's private source:
        // no id, title, or snippet of it is returned.
        let (status, sources, raw) =
            backlink_sources(&state, &member("bob"), &private_space, &target).await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        assert_eq!(sources, vec![shared_source.clone()]);
        assert!(!raw.contains(&private_source), "{raw}");
        assert!(!raw.contains("Alice secret"), "{raw}");
        assert!(!raw.contains("Falcon"), "{raw}");

        // A deny overwrite on the target's own Space refuses the whole read.
        let key =
            crate::acl::store::ResourceKey::new(crate::acl::KIND_SPACE, private_space.as_str());
        let _restore = RestoredSpaceAcl {
            previous: crate::acl::store::stored_for(&key),
            key: key.clone(),
        };
        crate::acl::store::set_overwrites(
            &key,
            vec![crate::acl::store::StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: "bob".to_owned(),
                allow: Vec::new(),
                deny: vec![crate::identity_verify::permissions::SPACE_READ.to_owned()],
            }],
        )
        .expect("persist the Space ACL fixture");
        let (status, sources, raw) =
            backlink_sources(&state, &member("bob"), &private_space, &target).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{raw}");
        assert!(sources.is_empty(), "{raw}");
        assert!(!raw.contains("Carol notes"), "{raw}");

        // An outsider from another org cannot read the target at all.
        let mut outsider = member("mallory");
        if let Some(caller) = outsider.as_mut() {
            caller.org_id = Some("org2".to_owned());
        }
        let (status, sources, _) =
            backlink_sources(&state, &outsider, &private_space, &target).await;
        assert_ne!(status, StatusCode::OK);
        assert!(sources.is_empty());
    })
    .await;
}

/// A synced move changes a document's Space but keeps inbound link rows whose
/// title still matches, so a backlink's source can sit in a DIFFERENT Space from
/// the target. That source's own Space ACL must still apply.
#[tokio::test]
async fn cross_space_backlink_honors_the_source_space_deny_overwrite() {
    let directory = tempfile::tempdir().unwrap();
    let state = super::workflow_version_revision_tests::handler_state(directory.path());
    let store = &state.spaces;

    let carol_space = org_space(store, "Carol shared", "carol").await;
    let bob_space = org_space(store, "Bob shared", "bob").await;
    let target = store
        .create_page(&carol_space, "Roadmap", &owned("bob"))
        .await
        .unwrap();
    let source = store
        .create_page(&carol_space, "Carol notes", &owned("carol"))
        .await
        .unwrap();
    store
        .update_document(&source, "Carol notes", "see [[Roadmap]]")
        .await
        .unwrap();

    // Another device moved the target into Bob's Space.
    let mut record = store
        .list_documents_for_sync()
        .await
        .unwrap()
        .into_iter()
        .find(|record| record.document.id == target)
        .expect("target is in the sync snapshot");
    record.document.space_id = bob_space.clone();
    record.document.updated_at += 60_000;
    assert!(store
        .apply_synced_document(&record, &owned("bob"))
        .await
        .unwrap());
    assert_eq!(
        store.document_space_id(&target).await.unwrap().as_deref(),
        Some(bob_space.as_str())
    );

    with_test_node_binding(true, Some(org_node()), async {
        // The cross-Space link row survives the move.
        let (status, sources, raw) =
            backlink_sources(&state, &member("bob"), &bob_space, &target).await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        assert_eq!(sources, vec![source.clone()]);

        // Bob is denied `space.read` on the SOURCE's Space only: the target is
        // still readable, but the source's id, title, and snippet are withheld.
        let key = crate::acl::store::ResourceKey::new(crate::acl::KIND_SPACE, carol_space.as_str());
        let _restore = RestoredSpaceAcl {
            previous: crate::acl::store::stored_for(&key),
            key: key.clone(),
        };
        crate::acl::store::set_overwrites(
            &key,
            vec![crate::acl::store::StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: "bob".to_owned(),
                allow: Vec::new(),
                deny: vec![crate::identity_verify::permissions::SPACE_READ.to_owned()],
            }],
        )
        .expect("persist the Space ACL fixture");
        let (status, sources, raw) =
            backlink_sources(&state, &member("bob"), &bob_space, &target).await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        assert!(sources.is_empty(), "{raw}");
        assert!(!raw.contains("Carol notes"), "{raw}");
        assert!(!raw.contains(&source), "{raw}");

        // Carol is not denied, so she still sees her source.
        let (status, sources, _) =
            backlink_sources(&state, &member("carol"), &bob_space, &target).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sources, vec![source.clone()]);
    })
    .await;
}
