use super::discovery::subnet_prefix;
use super::*;

/// Discovery must cover EVERY profile's port. Sweeping only our own meant a
/// stable desktop (:7980) could not see a canary node (:9980) even on this
/// machine, so "stable app against a canary node" could not be set up without
/// hand-entering a URL.
#[test]
fn every_profile_port_is_swept() {
    let ports: Vec<u16> = crate::profile::PROFILE_PORT_OFFSETS
        .iter()
        .map(|(_, off)| crate::profile::CORE_BASE_PORT.saturating_add(*off))
        .collect();
    assert!(ports.contains(&7980), "release");
    assert!(ports.contains(&8980), "dev");
    assert!(ports.contains(&9980), "canary");
    assert!(ports.contains(&10_980), "nightly");
    assert!(ports.contains(&11_980), "beta");
    // Distinct, or two profiles would be reported as one node.
    let mut sorted = ports.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ports.len());
}

/// The profile is derived from the PORT, never from anything the node claims,
/// so a discovered entry can always be labelled.
#[test]
fn a_port_maps_back_to_exactly_one_profile() {
    for (profile, offset) in crate::profile::PROFILE_PORT_OFFSETS {
        let port = crate::profile::CORE_BASE_PORT.saturating_add(*offset);
        let matches: Vec<&str> = crate::profile::PROFILE_PORT_OFFSETS
            .iter()
            .filter(|(_, o)| crate::profile::CORE_BASE_PORT.saturating_add(*o) == port)
            .map(|(n, _)| *n)
            .collect();
        assert_eq!(matches, vec![*profile], "port {port} must name one profile");
    }
}

#[test]
fn subnet_prefix_extracts_24() {
    assert_eq!(subnet_prefix("192.168.1.42"), Some("192.168.1".to_owned()));
    assert_eq!(subnet_prefix("10.0.0.5"), Some("10.0.0".to_owned()));
}

#[test]
fn subnet_prefix_rejects_malformed() {
    assert_eq!(subnet_prefix("192.168.1"), None);
    assert_eq!(subnet_prefix("not-an-ip"), None);
    assert_eq!(subnet_prefix("1.2.3.4.5"), None);
}

// ── local node auth token ────────────────────────────────────────────────

#[test]
fn local_node_urls_match_regardless_of_trailing_slash_or_case() {
    let base = crate::profile::core_base_url();
    assert!(is_local_node_url(&base));
    assert!(is_local_node_url(&format!("{base}/")));
    assert!(is_local_node_url(&base.to_uppercase()));
    // A different host is NOT this machine's Core, so its token file must
    // never be attached to it.
    assert!(!is_local_node_url("http://192.168.1.50:7980"));
    assert!(!is_local_node_url("https://node.example.com"));
}

#[test]
fn fill_local_token_never_overrides_an_explicit_token() {
    // An operator who pinned a token by hand (or a peer's own token) must win
    // over the on-disk mint, or a hand-configured node silently breaks.
    let mut config = NodesConfig {
        default: "local".into(),
        nodes: vec![
            Node {
                name: "local".into(),
                url: crate::profile::core_base_url(),
                token: Some("pinned-by-hand".into()),
                unopened_token: None,
            },
            Node {
                name: "remote".into(),
                url: "http://192.168.1.50:7980".into(),
                token: None,
                unopened_token: None,
            },
        ],
    };
    fill_local_token(&mut config);
    assert_eq!(config.nodes[0].token.as_deref(), Some("pinned-by-hand"));
    // A REMOTE node never receives this machine's token: it would be a secret
    // sent to a third party, and that peer would reject it anyway.
    assert_eq!(config.nodes[1].token, None);
}

// ── sealed node tokens ───────────────────────────────────────────────────

const REMOTE_TOKEN: &str = "remote-node-bearer-0123456789";

fn remote(token: Option<&str>) -> Node {
    Node {
        name: "remote".into(),
        url: "https://node.example".into(),
        token: token.map(str::to_owned),
        unopened_token: None,
    }
}

fn config_with(nodes: Vec<Node>) -> NodesConfig {
    NodesConfig {
        default: "remote".into(),
        nodes,
    }
}

#[test]
fn saved_tokens_stay_readable_by_the_cli_with_owner_only_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let path = state.join("nodes.json");
    save_at(&path, &config_with(vec![remote(Some(REMOTE_TOKEN))]), None).unwrap();
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    // The Bun CLI reads this field directly, so it must not be an envelope.
    assert_eq!(raw["nodes"][0]["token"], REMOTE_TOKEN);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&state), 0o700);
    }
    let loaded = load_at(&path, None);
    assert_eq!(loaded.nodes[0].token.as_deref(), Some(REMOTE_TOKEN));
}

#[test]
fn a_plaintext_token_is_never_rewritten_sealed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nodes.json");
    let pinned = format!(
        r#"{{"default":"remote","nodes":[{{"name":"remote","url":"https://node.example","token":"{REMOTE_TOKEN}"}}]}}"#
    );
    std::fs::write(&path, &pinned).unwrap();
    let loaded = load_at(&path, None);
    assert_eq!(loaded.nodes[0].token.as_deref(), Some(REMOTE_TOKEN));
    // Untouched: no rewrite, and above all no envelope the CLI cannot open.
    assert_eq!(std::fs::read_to_string(&path).unwrap(), pinned);
}

#[test]
fn a_token_sealed_by_an_earlier_build_is_opened_and_written_back_readable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nodes.json");
    let sealed = crate::desktop_seal::seal(REMOTE_TOKEN).unwrap();
    std::fs::write(
        &path,
        format!(
            r#"{{"default":"remote","nodes":[{{"name":"remote","url":"https://node.example","token":"{sealed}"}}]}}"#
        ),
    )
    .unwrap();
    let loaded = load_at(&path, None);
    assert_eq!(loaded.nodes[0].token.as_deref(), Some(REMOTE_TOKEN));
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw["nodes"][0]["token"], REMOTE_TOKEN);
}

#[test]
fn an_unopenable_token_is_never_used_and_survives_a_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nodes.json");
    let foreign = ryu_crypto::FieldCipher::new(&[9; 32])
        .seal(REMOTE_TOKEN)
        .unwrap();
    std::fs::write(
        &path,
        format!(
            r#"{{"default":"remote","nodes":[{{"name":"remote","url":"https://node.example","token":"{foreign}"}}]}}"#
        ),
    )
    .unwrap();
    let loaded = load_at(&path, None);
    assert_eq!(loaded.nodes[0].token, None);
    // Not sent to the webview either.
    assert!(!serde_json::to_string(&loaded).unwrap().contains("enc:v1:"));
    save_at(&path, &loaded, None).unwrap();
    assert!(std::fs::read_to_string(&path).unwrap().contains(&foreign));
}

#[test]
fn the_local_minted_token_is_still_stripped_before_saving() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nodes.json");
    let local = Node {
        name: "local".into(),
        url: crate::profile::core_base_url(),
        token: Some("minted-local".into()),
        unopened_token: None,
    };
    save_at(&path, &config_with(vec![local]), Some("minted-local")).unwrap();
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(raw["nodes"][0]["token"].is_null());
}

/// Both rejections that need no disk access come back coded, never as an
/// English sentence the dialogs would print.
#[test]
fn add_and_remove_reject_with_codes_before_touching_nodes_json() {
    let invalid = add_node("My Laptop".into(), "http://10.0.0.2:7980".into(), None)
        .expect_err("a name with a space is rejected");
    assert_eq!(invalid.code, NodeCommandErrorCode::InvalidName);
    assert_eq!(invalid.values.name, "My Laptop");
    assert_eq!(
        serde_json::to_value(&invalid).unwrap(),
        serde_json::json!({ "code": "invalid_name", "values": { "name": "My Laptop" } })
    );
    let local = remove_node("local".into()).expect_err("the local node stays");
    assert_eq!(local.code, NodeCommandErrorCode::LocalNode);
}
