use crate::openapi_import::{ImportedApi, ImportedTool};
use crate::server::*;

fn tool(slug: &str, method: &str) -> ImportedTool {
    ImportedTool {
        slug: slug.to_owned(),
        name: slug.to_owned(),
        description: None,
        method: method.to_owned(),
        url: format!("https://api.x.example/{slug}"),
        header_params: vec!["X-API-Key".to_owned()],
        secret_headers: std::collections::BTreeMap::new(),
        input_schema: json!({ "type": "object" }),
    }
}

#[test]
fn openapi_manifest_dedups_slugs_and_scopes_grant() {
    let api = ImportedApi {
        title: "X".to_owned(),
        domain: "api.x.example".to_owned(),
        base_url: "https://api.x.example".to_owned(),
        tools: vec![tool("get_a", "GET"), tool("get_a", "POST")],
        total_operations: 2,
        dropped: 0,
    };
    let manifest = build_openapi_plugin_manifest("apiimport-api-x-example", &api);
    assert_eq!(manifest.runnables.len(), 2);
    let slugs: Vec<String> = manifest
        .runnables
        .iter()
        .map(|r| {
            r.config.as_ref().unwrap()["slug"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert!(slugs.contains(&"get_a".to_owned()));
    assert!(
        slugs.contains(&"get_a_2".to_owned()),
        "collision not de-duped: {slugs:?}"
    );
    assert!(manifest
        .permission_grants
        .contains(&"tool:http-egress:api.x.example".to_owned()));
    let cfg = manifest.runnables[0].config.as_ref().unwrap();
    assert_eq!(cfg["backend"], "http");
    assert_eq!(cfg["header_params"][0], "X-API-Key");
}

#[test]
fn graphql_manifest_is_single_post_tool() {
    let manifest = build_graphql_plugin_manifest(
        "graphql-api-x-example",
        "X",
        "https://api.x.example/graphql",
        "api.x.example",
    );
    assert_eq!(manifest.runnables.len(), 1);
    let cfg = manifest.runnables[0].config.as_ref().unwrap();
    assert_eq!(cfg["method"], "POST");
    assert_eq!(cfg["url"], "https://api.x.example/graphql");
    assert!(manifest
        .permission_grants
        .contains(&"tool:http-egress:api.x.example".to_owned()));
}

#[test]
fn normalize_key_bridges_apis_guru_key_and_integrations_slug() {
    let key = normalize_key("1password.com:events");
    assert_eq!(key, "1password-com-events");
    // The integrations.sh slug's normalized form starts with the apis.guru key.
    assert!(normalize_key("1password-com-events-events").starts_with(&key));
}

#[test]
fn slugify_domain_is_plugin_id_safe() {
    assert_eq!(slugify_domain("api.x.example"), "api-x-example");
    assert_eq!(slugify_domain("A.B_C"), "a-b-c");
}

#[tokio::test]
async fn imported_endpoints_reject_private_hosts_and_credentials() {
    let private = validate_import_endpoint("http://127.0.0.1:7980/graphql")
        .await
        .expect_err("loopback import must be rejected");
    assert!(private.contains("private/loopback"));

    let credentials = validate_import_endpoint("https://user:pass@example.com/api")
        .await
        .expect_err("credential-bearing import must be rejected");
    assert!(credentials.contains("credentials"));
}
