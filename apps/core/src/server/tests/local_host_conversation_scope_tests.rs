use crate::identity_verify::ResourceTenancy;
use crate::server::local_unowned_host_conversation_allowed;

#[test]
fn personal_unattributed_rows_use_the_single_principal_scope_only() {
    let mut meta = ResourceTenancy {
        owner_user_id: None,
        org_id: None,
        visibility: "private".into(),
        team_id: None,
        collaborators: Vec::new(),
    };
    assert!(local_unowned_host_conversation_allowed(&meta, false));
    assert!(!local_unowned_host_conversation_allowed(&meta, true));
    meta.owner_user_id = Some("other-user".into());
    assert!(!local_unowned_host_conversation_allowed(&meta, false));
    meta.owner_user_id = None;
    meta.org_id = Some("other-org".into());
    assert!(!local_unowned_host_conversation_allowed(&meta, false));
}
