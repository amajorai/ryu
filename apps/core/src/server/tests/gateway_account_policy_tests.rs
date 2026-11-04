use crate::server::*;
#[test]
fn forwards_normalized_settings_without_key_material() {
    let id = ryu_gw_credentials::provider_account_id("fal", "synthetic");
    let body: SetProviderBody = serde_json::from_value(json!({"provider":"fal", "accountId":id, "accountPolicy":{"name":" Backup ","enabled":false,"priority":10}, "account_action":"configure"})).unwrap();
    let patch = gateway_account_policy_patch("fal", &body).unwrap();
    assert_eq!(
        patch["providerAccountPolicies"]["fal"][&id]["name"],
        "Backup"
    );
    assert_eq!(
        patch["providerAccountPolicies"]["fal"][&id]["enabled"],
        false
    );
    assert!(!patch.to_string().contains("synthetic"));
}
#[test]
fn rejects_credential_edits_and_invalid_metadata_in_a_live_update() {
    for input in [
        json!({"provider":"fal", "accountId":"bad", "accountPolicy":{"name":"Backup"}}),
        json!({"provider":"fal", "accountId":"a".repeat(64), "accountPolicy":{"name":"bad\nname"}}),
        json!({"provider":"fal", "accountId":"a".repeat(64), "api_key":"secret", "accountPolicy":{"name":"Backup"}}),
        json!({"provider":"genai-groq", "accountId":"a".repeat(64), "allowEnvironment":true, "accountPolicy":{"name":"Backup"}}),
        json!({"provider":"genai-vertex", "accountId":"a".repeat(64), "sdkContext":{"kind":"vertex","project":"p","location":"global"}, "accountPolicy":{"name":"Backup"}}),
    ] {
        let body: SetProviderBody = serde_json::from_value(input).unwrap();
        assert!(gateway_account_policy_patch("fal", &body).is_err());
    }
}
