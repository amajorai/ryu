use super::*;

pub(super) fn actor() -> AuditActor {
    AuditActor::new("user", Some("ops"))
}

pub(super) async fn setup() -> PluginSecretStore {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .pki_create_root("internal", "Ryu Internal Root", 30 * 24 * 3600, &actor())
        .await
        .unwrap();
    store
        .pki_put_role(
            &PkiRole {
                name: "web".into(),
                issuer: "internal".into(),
                allowed_domains: vec!["*.svc.local".into(), "svc.local".into()],
                allow_ip_sans: true,
                default_ttl_secs: 3600,
                max_ttl_secs: 86_400,
                server_flag: true,
                client_flag: false,
            },
            &actor(),
        )
        .await
        .unwrap();
    store
}

#[test]
fn domain_patterns_match_one_label() {
    let patterns = vec!["*.svc.local".to_owned(), "svc.local".to_owned()];
    assert!(domain_allowed(&patterns, "api.svc.local"));
    assert!(domain_allowed(&patterns, "svc.local"));
    assert!(!domain_allowed(&patterns, "a.b.svc.local"));
    assert!(!domain_allowed(&patterns, "evilsvc.local"));
    assert!(!domain_allowed(&patterns, "api.svc.local.evil.com"));
}
