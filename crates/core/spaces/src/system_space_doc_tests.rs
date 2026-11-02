//! A system Space (Uploads, Artifacts, …) is shared as a container, but the
//! documents in it stay private to whoever created them: an org-bound member must
//! not read a colleague's upload through list, search, or the by-id ACL metadata.

use super::*;

fn owned(uid: &str) -> DocOwner {
    DocOwner::owned(Some(uid), Some("org1"))
}

#[tokio::test]
async fn a_members_document_in_a_system_space_stays_private_to_its_owner() {
    let store = SpaceStore::open_in_memory().unwrap();
    let uploads = store.ensure_system_space("Uploads", None).await.unwrap();
    let doc = store
        .ingest_document(
            &uploads,
            "alice-attachment.txt",
            "The marmalade acquisition closes on Friday.",
            &owned("alice"),
        )
        .await
        .unwrap();
    let bob = || DocFilter::for_caller(Some("bob"), Some("org1"), true);
    let alice = || DocFilter::for_caller(Some("alice"), Some("org1"), true);

    // The space row itself stays listed for every member.
    let bob_spaces = store.list_spaces(bob()).await.unwrap();
    assert!(bob_spaces.iter().any(|space| space.id == uploads));

    assert!(store
        .list_documents(&uploads, bob())
        .await
        .unwrap()
        .is_empty());
    let bob_hits = store
        .search_ext(&uploads, "marmalade acquisition", 10, Some(false), bob())
        .await
        .unwrap();
    assert!(
        bob_hits.iter().all(|hit| hit.document_id != doc),
        "Bob must not retrieve Alice's upload through RAG search"
    );

    let alice_docs = store.list_documents(&uploads, alice()).await.unwrap();
    assert!(alice_docs.iter().any(|document| document.id == doc));
    let alice_hits = store
        .search_ext(&uploads, "marmalade acquisition", 10, Some(false), alice())
        .await
        .unwrap();
    assert!(alice_hits.iter().any(|hit| hit.document_id == doc));

    // By-id ACL: the document reports its own visibility, not the space's.
    let meta = store.get_access_meta(&doc).await.unwrap().expect("exists");
    assert_eq!(meta.visibility, "private");
    assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
}

#[tokio::test]
async fn an_explicitly_shared_document_in_a_system_space_is_visible_to_the_org() {
    let store = SpaceStore::open_in_memory().unwrap();
    let artifacts = store.ensure_system_space("Artifacts", None).await.unwrap();
    let doc = store
        .ingest_document(
            &artifacts,
            "report",
            "Quarterly widget report",
            &owned("alice"),
        )
        .await
        .unwrap();
    store.set_document_access(&doc, "org", None).await.unwrap();

    let bob = DocFilter::for_caller(Some("bob"), Some("org1"), true);
    let visible = store.list_documents(&artifacts, bob).await.unwrap();
    assert!(visible.iter().any(|document| document.id == doc));
    let meta = store.get_access_meta(&doc).await.unwrap().expect("exists");
    assert_eq!(meta.visibility, "org");
}
