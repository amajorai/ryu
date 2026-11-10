//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

#[test]
fn saved_key_detection_reads_references_and_typed_keys() {
    assert!(source_references_user_secret("Bearer secret:MY_KEY"));
    assert!(source_references_user_secret("vault:github.com"));
    assert!(source_references_user_secret("env:RYU_EXA_API_KEY"));
    // Core's own signed agent lane is not a user key.
    assert!(!source_references_user_secret("Bearer env:RYU_TOKEN"));
    assert!(!source_references_user_secret("application/json"));

    let mut config = McpServerConfig::default();
    assert!(!config_references_user_secret(&config));
    config
        .env
        .insert("TOKEN".to_owned(), "secret:MY_KEY".to_owned());
    assert!(config_references_user_secret(&config));
    assert_eq!(saved_key_account_id("mine", &config), "mine");

    // A key typed into a server the user added is theirs too; a static
    // value a plugin ships is not.
    let mut typed = McpServerConfig::default();
    typed
        .headers
        .insert("Authorization".to_owned(), "Bearer sk-typed".to_owned());
    assert!(config_references_user_secret(&typed));
    typed.owner_plugin_id = Some("@ryu/example".to_owned());
    assert!(!config_references_user_secret(&typed));
    assert_eq!(saved_key_account_id("example", &typed), "@ryu/example");

    // A key typed anywhere into a server the user added counts, whatever
    // its name: in the URL, the arguments, or any header or env value.
    let user_added = |edit: &dyn Fn(&mut McpServerConfig)| {
        let mut config = McpServerConfig {
            url: Some("https://mcp.example.com/mcp".to_owned()),
            ..Default::default()
        };
        edit(&mut config);
        config_references_user_secret(&config)
    };
    assert!(!user_added(&|_| {}));
    for url in [
        "https://actions.example.com/mcp/sk9f8a7d6s5a4d3f2g1h/sse",
        "https://mcp.example.com/mcp?api_key=abc",
        "https://user:pass@mcp.example.com/mcp",
        "https://mcp.example.com/mcp#token",
        "https://mcp.example.com/0b6c6f8e-2f1d-4d6a-9a53-1c2b3d4e5f60/mcp",
    ] {
        assert!(
            user_added(&|config| config.url = Some(url.to_owned())),
            "{url}"
        );
    }
    for (name, value) in [
        ("X-Auth-Token", "abc"),
        ("X-Goog-Api-Key", "abc"),
        ("apikey", "abc"),
        ("X-Custom", "abc"),
    ] {
        assert!(
            user_added(&|config| {
                config.headers.insert(name.to_owned(), value.to_owned());
            }),
            "{name}"
        );
    }
    for name in [
        "STRIPE_SECRET_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "GITLAB_PAT",
        "ANYTHING",
    ] {
        assert!(
            user_added(&|config| {
                config.env.insert(name.to_owned(), "value".to_owned());
            }),
            "{name}"
        );
    }
    for args in [
        &["--api-key", "xyz"][..],
        &["--token=xyz"],
        &["serve", "sk-live-4f3e2d1c0b9a8f7e"],
        &["--endpoint", "https://mcp.example.com/mcp?key=1"],
    ] {
        assert!(
            user_added(&|config| {
                config.url = None;
                config.command = Some("server".to_owned());
                config.args = args.iter().map(|arg| (*arg).to_owned()).collect();
            }),
            "{args:?}"
        );
    }
    // An ordinary stdio server (a package and a folder) carries no key.
    assert!(!user_added(&|config| {
        config.url = None;
        config.command = Some("npx".to_owned());
        config.args = [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/home/me/notes",
        ]
        .map(str::to_owned)
        .to_vec();
    }));
    // The env names auth metadata recognises cover `_KEY` and `_PAT` too.
    assert!(is_auth_env_name("STRIPE_SECRET_KEY"));
    assert!(is_auth_env_name("GITLAB_PAT"));
    assert!(is_auth_header_name("X-Auth-Token"));
}
