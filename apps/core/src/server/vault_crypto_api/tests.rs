use super::*;

#[test]
fn machine_grants_expand_identity_templates() {
    let who = Caller::machine_for_test(vec![crate::vault::policy::PolicyRule {
        path: "sys/identity/{{identity.machine.id}}".into(),
        capabilities: vec![Capability::Use],
        deny: false,
        ..Default::default()
    }]);
    assert!(who.require(&identity_key("mid_x"), Capability::Use).is_ok());
    assert!(who
        .require(&identity_key("mid_y"), Capability::Use)
        .is_err());
}

#[test]
fn machine_identity_tokens_need_an_explicit_use_grant() {
    let who = Caller::machine_for_test(vec![crate::vault::policy::PolicyRule {
        path: "sys/identity/aws".into(),
        capabilities: vec![Capability::Use],
        deny: false,
        ..Default::default()
    }]);
    assert!(who.require(&identity_key("aws"), Capability::Use).is_ok());
    assert!(who.require(&identity_key("gcp"), Capability::Use).is_err());
    assert!(who.require(IDENTITY_CONFIG_KEY, Capability::Admin).is_err());
    let subject = who
        .subject()
        .expect("machine callers always have a subject");
    assert_eq!(subject.kind, "machine");
    assert_eq!(subject.id, "mid_x");
    assert_eq!(subject.policies, vec!["ci".to_owned()]);
}

#[test]
fn restore_targets_are_read_from_the_backup() {
    use base64::Engine as _;
    let backup = base64::engine::general_purpose::STANDARD
        .encode(br#"{"format":"ryu-transit-backup-v1","name":"orders"}"#);
    assert_eq!(backup_name(&backup).as_deref(), Some("orders"));
    assert_eq!(backup_name("not base64"), None);
}
