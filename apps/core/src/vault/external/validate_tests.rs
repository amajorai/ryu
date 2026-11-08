//! Store validation: target settings only stick to sync targets.

use super::*;

fn input(body: serde_json::Value) -> StoreInput {
    serde_json::from_value(body).unwrap()
}

#[test]
fn vault_kinds_drop_target_settings_and_sync_targets_default_their_address() {
    let (bao, _) = validate_store(input(json!({
        "name": "bao", "kind": "openbao", "address": "https://bao.example.com",
        "authMethod": "token", "repository": "acme/app", "region": "us-east-1",
        "credentials": { "token": "t" },
    })))
    .unwrap();
    assert_eq!(bao.options, TargetOptions::default());
    assert_eq!(bao.mount, "secret");

    let (vercel, _) = validate_store(input(json!({
        "name": "vc", "kind": "vercel", "authMethod": "token", "projectId": "prj_1",
        "region": "us-east-1", "credentials": { "token": "t" },
    })))
    .unwrap();
    assert_eq!(vercel.address, "https://api.vercel.com");
    assert_eq!(vercel.mount, "");
    assert_eq!(vercel.options.region, None);
    assert_eq!(
        vercel.options.vercel_targets,
        ["production", "preview", "development"]
    );
    // A vault store still needs its address.
    assert!(validate_store(input(json!({
        "name": "bao", "kind": "openbao", "authMethod": "token", "credentials": { "token": "t" },
    })))
    .is_err());
}

#[test]
fn intervals_and_folders_are_bounded() {
    assert_eq!(in_range(None, 60, 5, 3600, "x").unwrap(), 60);
    assert!(in_range(Some(4), 60, 5, 3600, "x").is_err());
    assert!(in_range(Some(3601), 60, 5, 3600, "x").is_err());
    assert!(folder("default", "/a/b").is_ok());
    assert!(folder("Bad Env", "/a").is_err());
}
