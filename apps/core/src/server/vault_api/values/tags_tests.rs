use super::*;
use crate::server::vault_api::tests::{caller, ctx, node, parts};

#[test]
fn the_tag_filter_requires_every_named_tag() {
    let wanted = tag_filter(Some(" pci, prod ,,"));
    assert_eq!(wanted, vec!["pci".to_owned(), "prod".to_owned()]);
    assert!(tag_filter(None).is_empty());
    let tags = vec!["prod".to_owned(), "pci".to_owned(), "x".to_owned()];
    assert!(has_tags(&tags, &wanted));
    assert!(!has_tags(&tags[..1], &wanted));
    assert!(has_tags(&[], &[]));
    let both = json!({ "metadata": { "tags": ["pci", "prod"] } });
    assert!(wire_has_tags(&both, &wanted));
    assert!(!wire_has_tags(&json!({ "metadata": { "tags": ["pci"] } }), &wanted));
    assert!(!wire_has_tags(&json!({}), &wanted));
    assert!(wire_has_tags(&json!({}), &[]));
}

#[tokio::test]
async fn tags_list_entities_and_count_only_visible_values() {
    let ctx = ctx(None, None, true, Vec::new());
    for (name, tags) in [("A", json!(["pci", "prod"])), ("B", json!(["prod"]))] {
        let body = json!({ "value": "v", "metadata": { "tags": tags } });
        let (status, text) = parts(put_secret_with(&ctx, name, body).await).await;
        assert_eq!(status, StatusCode::OK, "{text}");
    }
    let entity = json!({ "name": "PCI", "color": "#112233" });
    let (status, body) = parts(put_tag_with(&ctx, "pci", entity).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = parts(put_tag_with(&ctx, " bad", json!({})).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, body) = parts(list_tags_with(&ctx).await).await;
    let tags: Value = serde_json::from_str(&body).unwrap();
    let find = |slug: &str| {
        tags["tags"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tag| tag["slug"] == slug)
            .cloned()
            .unwrap()
    };
    assert_eq!(find("pci")["count"], 1);
    assert_eq!(find("pci")["defined"], true);
    assert_eq!(find("pci")["color"], "#112233");
    assert_eq!(find("prod")["count"], 2);
    assert_eq!(find("prod")["defined"], false);

    // A member on an org node sees neither the local operator's personal
    // values nor their tags, and may not define entities.
    let mut member = crate::server::vault_api::tests::ctx(
        Some(node(NodeScope::Org, None, None)),
        Some(caller("user-1", OrgRole::Member, &[])),
        false,
        Vec::new(),
    );
    member.store = ctx.store;
    let (_, body) = parts(list_tags_with(&member).await).await;
    assert!(!body.contains("prod"), "{body}");
    assert!(body.contains("\"count\":0"), "{body}");
    let (status, _) = parts(put_tag_with(&member, "prod", json!({})).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) = parts(delete_tag_with(&ctx, "pci").await).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"deleted\":true"), "{body}");
}
