use super::store::AllowlistStore;
use super::*;

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn patterns_are_normalized_sorted_and_deduplicated() {
    assert_eq!(
        normalize_patterns(&[
            " Example.COM. ",
            "*.Docs.Example.com",
            "example.com",
            "",
            "BÜCHER.de",
            "10.0.0.1",
            "[::1]",
        ])
        .unwrap(),
        strings(&[
            "*.docs.example.com",
            "10.0.0.1",
            "::1",
            "example.com",
            "xn--bcher-kva.de",
        ])
    );
    assert_eq!(
        normalize_patterns::<&str>(&[]).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn anything_but_a_plain_host_or_wildcard_domain_is_refused() {
    for bad in [
        "example.com:443",
        "https://example.com",
        "example.com/path",
        "user@example.com",
        "exa mple.com",
        "example%2ecom",
        "*",
        "*.com",
        "*.10.0.0.1",
        "**.example.com",
        "-bad.example.com",
        "bad-.example.com",
        "a..example.com",
        "0x7f.1",
        "fe80::1%eth0",
    ] {
        assert!(normalize_patterns(&[bad]).is_err(), "{bad} must be refused");
    }
}

#[test]
fn an_allowlist_is_bounded() {
    let many: Vec<String> = (0..=MAX_PATTERNS)
        .map(|index| format!("host{index}.example.com"))
        .collect();
    assert!(normalize_patterns(&many).is_err());
    assert_eq!(
        normalize_patterns(&many[..MAX_PATTERNS]).unwrap().len(),
        MAX_PATTERNS
    );
}

#[test]
fn the_header_value_is_comma_joined_and_empty_means_no_host() {
    assert_eq!(
        header_value(&strings(&["*.example.com", "example.org"])),
        "*.example.com,example.org"
    );
    assert_eq!(header_value(&[]), "");
}

#[test]
fn agent_ids_must_be_printable_and_bounded() {
    assert!(validate_agent_id("agent-1").is_ok());
    for bad in ["", "   ", "a\nb", &"a".repeat(257)] {
        assert!(validate_agent_id(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn the_store_round_trips_and_removes_per_agent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("allowlists.json");
    let store = AllowlistStore::at(path.clone());
    assert_eq!(store.get("agent-1").unwrap(), None, "no file is no policy");

    let stored = store
        .set(
            "agent-1",
            Some(strings(&["Example.com", "*.example.org"]).as_slice()),
        )
        .unwrap();
    assert_eq!(stored, Some(strings(&["*.example.org", "example.com"])));
    store.set("agent-2", Some(&[])).unwrap();

    // A fresh store reads what the first one wrote.
    let reread = AllowlistStore::at(path.clone());
    assert_eq!(
        reread.get("agent-1").unwrap(),
        Some(strings(&["*.example.org", "example.com"]))
    );
    assert_eq!(reread.get("agent-2").unwrap(), Some(Vec::new()));

    reread.set("agent-1", None).unwrap();
    assert_eq!(AllowlistStore::at(path).get("agent-1").unwrap(), None);
}

#[test]
fn a_refused_write_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = AllowlistStore::at(dir.path().join("allowlists.json"));
    store
        .set("agent-1", Some(strings(&["example.com"]).as_slice()))
        .unwrap();
    assert!(store
        .set("agent-1", Some(strings(&["example.com:80"]).as_slice()))
        .is_err());
    assert!(store
        .set("", Some(strings(&["example.com"]).as_slice()))
        .is_err());
    assert_eq!(
        store.get("agent-1").unwrap(),
        Some(strings(&["example.com"]))
    );
}

#[test]
fn an_unreadable_store_fails_closed_and_is_not_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("allowlists.json");
    for corrupt in [
        "{not json",
        r#"{"agents":{"agent-1":["EXAMPLE.com"]}}"#,
        r#"{"agents":{"agent-1":["example.com:80"]}}"#,
        r#"{"agents":{},"extra":true}"#,
    ] {
        std::fs::write(&path, corrupt).unwrap();
        let store = AllowlistStore::at(path.clone());
        assert!(
            store.get("agent-1").is_err(),
            "{corrupt} must not read as no policy"
        );
        assert!(store.set("agent-2", Some(&[])).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), corrupt);
    }
}

#[test]
fn a_deleted_agents_allowlist_is_forgotten_and_others_are_kept() {
    let directory = tempfile::tempdir().unwrap();
    let store = AllowlistStore::at(directory.path().join("allowlists.json"));
    store
        .set("gone", Some(strings(&["example.com"]).as_slice()))
        .unwrap();
    store
        .set("kept", Some(strings(&["example.org"]).as_slice()))
        .unwrap();

    assert!(forget_agent_in(&store, "gone").unwrap());
    assert_eq!(store.get("gone").unwrap(), None);
    assert_eq!(store.get("kept").unwrap(), Some(strings(&["example.org"])));
    // Persisted: a fresh store over the same file agrees.
    let reread = AllowlistStore::at(directory.path().join("allowlists.json"));
    assert_eq!(reread.get("gone").unwrap(), None);
    assert_eq!(reread.get("kept").unwrap(), Some(strings(&["example.org"])));

    // An agent with no list, or an id the store cannot hold, is a no-op.
    assert!(!forget_agent_in(&store, "gone").unwrap());
    assert!(!forget_agent_in(&store, "").unwrap());
}
