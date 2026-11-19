use super::*;

fn tag(slug: &str) -> VaultTag {
    VaultTag {
        slug: slug.to_owned(),
        name: String::new(),
        color: String::new(),
        description: String::new(),
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn tag_labels_follow_the_value_tag_rules() {
    assert!(is_valid_tag("prod"));
    assert!(is_valid_tag("team: payments"));
    assert!(!is_valid_tag(""));
    assert!(!is_valid_tag(" prod"));
    assert!(!is_valid_tag("a\nb"));
    assert!(!is_valid_tag(&"x".repeat(MAX_TAG_LEN + 1)));
}

#[tokio::test]
async fn entities_are_validated_upserted_and_deleted_with_audit_rows() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::new("user", Some("admin-1"));
    let mut pci = tag("pci");
    pci.name = " PCI scope ".into();
    pci.color = "#AABBCC".into();
    let first = store.put_tag_entity(&pci, &actor).await.unwrap();
    assert_eq!(first.name, "PCI scope");
    assert_eq!(first.color, "#aabbcc");

    pci.description = "Card data".into();
    let second = store.put_tag_entity(&pci, &actor).await.unwrap();
    assert_eq!(second.created_at, first.created_at);
    assert_eq!(second.description, "Card data");

    let mut bad = tag("x");
    bad.color = "red".into();
    assert!(store.put_tag_entity(&bad, &actor).await.is_err());
    assert!(store.put_tag_entity(&tag(" pad"), &actor).await.is_err());

    assert_eq!(store.tag_entities().await.unwrap(), vec![second]);
    assert!(store.delete_tag_entity("pci", &actor).await.unwrap());
    assert!(!store.delete_tag_entity("pci", &actor).await.unwrap());
    assert!(store.tag_entities().await.unwrap().is_empty());

    let conn = store.conn.lock().await;
    let actions: Vec<String> = crate::vault::audit::list(
        &conn,
        &crate::vault::audit::AuditFilter {
            limit: 50,
            ..Default::default()
        },
    )
    .unwrap()
    .into_iter()
    .map(|row| row.action)
    .filter(|action| action.starts_with("tag."))
    .collect();
    assert_eq!(actions.len(), 3, "{actions:?}");
}
