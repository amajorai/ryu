//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

#[test]
fn auth_metadata_classifies_oauth_and_static_credentials_without_values() {
    let mut config = McpServerConfig::default();
    assert_eq!(auth_metadata(&config), (false, false, None));

    config
        .headers
        .insert("Authorization".to_owned(), "Bearer secret".to_owned());
    assert_eq!(
        auth_metadata(&config),
        (true, true, Some("header".to_owned()))
    );

    config.headers.clear();
    config
        .env
        .insert("OPENAI_API_KEY".to_owned(), "secret".to_owned());
    assert_eq!(auth_metadata(&config), (true, true, Some("env".to_owned())));

    config.env.clear();
    config.auth = Some(crate::plugin_manifest::McpServerAuthDecl::OAuth {
        client_id: Some("public-client".to_owned()),
    });
    assert_eq!(
        auth_metadata(&config),
        (true, false, Some("oauth".to_owned()))
    );

    config.auth = None;
    config
        .headers
        .insert("X-Trace-Id".to_owned(), "not a credential".to_owned());
    assert_eq!(auth_metadata(&config), (false, false, None));
}
