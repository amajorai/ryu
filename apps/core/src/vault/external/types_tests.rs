//! Wire names of store kinds and auth methods.

use super::*;

#[test]
fn every_kind_and_auth_method_round_trips_its_wire_name() {
    let kinds = [
        (StoreKind::Openbao, false),
        (StoreKind::HashicorpVault, false),
        (StoreKind::Infisical, false),
        (StoreKind::GithubActions, true),
        (StoreKind::Vercel, true),
        (StoreKind::AwsSecretsManager, true),
        (StoreKind::GcpSecretManager, true),
    ];
    for (kind, sync_target) in kinds {
        assert_eq!(StoreKind::parse(kind.as_str()), Some(kind));
        assert_eq!(kind.is_sync_target(), sync_target, "{}", kind.as_str());
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
    }
    for method in [
        AuthMethod::Token,
        AuthMethod::Approle,
        AuthMethod::Kubernetes,
        AuthMethod::UniversalAuth,
        AuthMethod::AccessKey,
        AuthMethod::ServiceAccount,
    ] {
        assert_eq!(AuthMethod::parse(method.as_str()), Some(method));
        assert_eq!(
            serde_json::to_value(method).unwrap(),
            json!(method.as_str())
        );
    }
    assert_eq!(StoreKind::parse("github"), None);
}

#[test]
fn credentials_never_print() {
    let credentials = StoreCredentials {
        secret_access_key: Some("aws-secret".into()),
        service_account_key: Some("{\"private_key\":\"k\"}".into()),
        ..StoreCredentials::default()
    };
    let printed = format!("{credentials:?}");
    assert!(!printed.contains("aws-secret") && !printed.contains("private_key"));
}
