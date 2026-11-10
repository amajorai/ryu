//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

#[test]
fn replace_server_drops_cleared_typed_fields_and_keeps_unknown_ones() {
    let mut servers = serde_json::Map::new();
    servers.insert(
        "remote".to_owned(),
        serde_json::json!({
            "type": "streamable-http",
            "url": "https://mcp.example/mcp",
            "headers": { "Authorization": "Bearer sk-old" },
            "catalog_id": "example",
            "x-custom": "kept",
        }),
    );
    let stdio = McpServerConfig {
        command: Some("mcp-server".to_owned()),
        enabled: true,
        ..Default::default()
    };
    McpConfigStore::replace_server(&mut servers, "remote".to_owned(), &stdio).unwrap();
    let entry = servers["remote"].as_object().unwrap();
    for removed in ["type", "url", "headers", "catalog_id"] {
        assert!(
            !entry.contains_key(removed),
            "{removed} must not survive: {entry:?}"
        );
    }
    assert_eq!(entry["command"], "mcp-server");
    assert_eq!(entry["x-custom"], "kept");
}

#[tokio::test]
async fn mcp_credentials_are_sealed_on_disk_and_open_for_readers() {
    let test_dir = tempfile::tempdir().unwrap();
    let path = test_dir.path().join("mcp.json");
    // A legacy file with literal credentials, as an older build or an
    // imported Claude/Cursor config wrote it.
    std::fs::write(
        &path,
        r#"{
                "mcpServers": {
                    "remote": {
                        "type": "http",
                        "url": "https://mcp.example.test/mcp",
                        "headers": {
                            "Authorization": "Bearer legacy-bearer-7c1d",
                            "X-Vault": "secret:TEAM_TOKEN"
                        }
                    },
                    "local": { "command": "npx", "env": { "GITHUB_TOKEN": "ghp-legacy-2b8e" } }
                }
            }"#,
    )
    .unwrap();
    // Legacy plaintext is readable before the migration runs.
    let file: McpConfigFile =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        file.servers(&path)["local"].env["GITHUB_TOKEN"],
        "ghp-legacy-2b8e"
    );

    assert!(McpConfigStore::seal_literals(path.clone()).await.unwrap());
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(
        !raw.contains("legacy-bearer-7c1d") && !raw.contains("ghp-legacy-2b8e"),
        "{raw}"
    );
    assert!(raw.contains("enc:v1:"));
    // A vault reference holds no secret and stays readable.
    assert!(raw.contains("secret:TEAM_TOKEN"));
    // Idempotent: nothing left to seal.
    assert!(!McpConfigStore::seal_literals(path.clone()).await.unwrap());

    let file: McpConfigFile = serde_json::from_str(&raw).unwrap();
    let servers = file.servers(&path);
    assert_eq!(
        servers["remote"].headers["Authorization"],
        "Bearer legacy-bearer-7c1d"
    );
    assert_eq!(servers["remote"].headers["X-Vault"], "secret:TEAM_TOKEN");
    assert_eq!(servers["local"].env["GITHUB_TOKEN"], "ghp-legacy-2b8e");

    // A read-modify-write sees plaintext and writes a new literal sealed.
    let seen = McpConfigStore::mutate(path.clone(), |document| {
        let servers = McpConfigStore::servers_mut(document)?;
        let local = servers
            .get_mut("local")
            .and_then(Value::as_object_mut)
            .unwrap();
        let seen = local["env"]["GITHUB_TOKEN"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        local["env"]["API_KEY"] = Value::String("new-key-4f0a".to_owned());
        Ok((true, seen))
    })
    .await
    .unwrap();
    assert_eq!(seen, "ghp-legacy-2b8e");
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("new-key-4f0a") && !raw.contains("ghp-legacy-2b8e"));
    let file: McpConfigFile = serde_json::from_str(&raw).unwrap();
    assert_eq!(file.servers(&path)["local"].env["API_KEY"], "new-key-4f0a");

    // A sealed value that cannot be opened is never handed to a server.
    std::fs::write(
        &path,
        r#"{"mcpServers":{"local":{"command":"npx","env":{"TOKEN":"enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}}}"#,
    )
    .unwrap();
    let file: McpConfigFile =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(!file.servers(&path)["local"].env.contains_key("TOKEN"));
}

#[tokio::test]
async fn config_store_preserves_metadata_and_serializes_concurrent_mutations() {
    let test_dir = std::env::temp_dir().join(format!(
        "ryu-mcp-config-store-test-{}-{}",
        std::process::id(),
        MCP_CONFIG_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&test_dir).unwrap();
    let path = test_dir.join("mcp.json");
    std::fs::write(
        &path,
        r#"{
                "$schema": "https://example.test/mcp.schema.json",
                "metadata": { "owner": "test" },
                "mcpServers": {
                    "existing": { "command": "one", "unknown": true }
                }
            }"#,
    )
    .unwrap();

    let first_path = path.clone();
    let second_path = path.clone();
    let (first, second) = tokio::join!(
        McpConfigStore::mutate(first_path, |document| {
            let servers = McpConfigStore::servers_mut(document)?;
            servers.insert(
                "first".to_owned(),
                serde_json::json!({ "command": "first" }),
            );
            Ok((true, ()))
        }),
        McpConfigStore::mutate(second_path, |document| {
            let servers = McpConfigStore::servers_mut(document)?;
            servers.insert(
                "second".to_owned(),
                serde_json::json!({ "command": "second" }),
            );
            Ok((true, ()))
        })
    );
    first.unwrap();
    second.unwrap();

    let document: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(document["$schema"], "https://example.test/mcp.schema.json");
    assert_eq!(document["metadata"]["owner"], "test");
    assert_eq!(document["mcpServers"]["existing"]["unknown"], true);
    assert_eq!(document["mcpServers"]["first"]["command"], "first");
    assert_eq!(document["mcpServers"]["second"]["command"], "second");

    std::fs::remove_dir_all(test_dir).unwrap();
}
