use super::*;

fn stored(input: ServiceInput) -> BrokerService {
    BrokerService {
        input: input.normalize().unwrap(),
        created_at: 0,
        updated_at: 0,
    }
}

fn name<'a>(outcome: MatchOutcome<'a>) -> &'a str {
    match outcome {
        MatchOutcome::Matched(service) => service.name(),
        other => panic!("expected a match, got {other:?}"),
    }
}

#[test]
fn host_patterns_are_validated() {
    for ok in ["api.openai.com", "*.example.com", "localhost", "10.0.0.1"] {
        assert!(is_valid_host_pattern(ok), "{ok}");
    }
    for bad in [
        "", "*", "*.com", "a.*.com", "API.com", "a..b", "-a.com", "a b.com", "*.*.x.y",
    ] {
        assert!(!is_valid_host_pattern(bad), "{bad}");
    }
}

#[test]
fn exact_beats_wildcard_beats_shorter_wildcard() {
    let services = vec![
        stored(test_service("wild", "*.example.com", None, "/")),
        stored(test_service("deep", "*.api.example.com", None, "/")),
        stored(test_service("exact", "v1.api.example.com", None, "/")),
    ];
    assert_eq!(
        name(match_request(&services, "v1.api.example.com", 443, "/")),
        "exact"
    );
    assert_eq!(
        name(match_request(&services, "v2.api.example.com", 443, "/")),
        "deep"
    );
    assert_eq!(
        name(match_request(&services, "x.example.com", 443, "/")),
        "wild"
    );
    assert_eq!(
        match_request(&services, "example.com", 443, "/"),
        MatchOutcome::Unmatched
    );
    assert_eq!(
        match_request(&services, "evilexample.com", 443, "/"),
        MatchOutcome::Unmatched
    );
}

#[test]
fn port_and_longest_path_prefix_break_ties() {
    let services = vec![
        stored(test_service("any", "api.example.com", None, "/")),
        stored(test_service("port", "api.example.com", Some(8443), "/")),
        stored(test_service("v2", "api.example.com", None, "/v2")),
    ];
    assert_eq!(
        name(match_request(&services, "api.example.com", 8443, "/v1")),
        "port"
    );
    assert_eq!(
        name(match_request(&services, "api.example.com", 443, "/v2/x")),
        "v2"
    );
    assert_eq!(
        name(match_request(&services, "api.example.com", 443, "/v2")),
        "v2"
    );
    assert_eq!(
        name(match_request(&services, "api.example.com", 443, "/v20")),
        "any"
    );
    assert_eq!(
        name(match_request(&services, "API.example.com.", 443, "/")),
        "any"
    );
}

#[test]
fn disabled_and_ambiguous_matches_are_reported() {
    let mut disabled = test_service("off", "api.example.com", None, "/");
    disabled.enabled = false;
    let services = vec![stored(disabled)];
    assert!(matches!(
        match_request(&services, "api.example.com", 443, "/"),
        MatchOutcome::Disabled(_)
    ));
    let mut b = test_service("b", "api.example.com", None, "/");
    b.environment = "default".into();
    let services = vec![
        stored(test_service("a", "api.example.com", None, "/")),
        stored(b),
    ];
    assert_eq!(
        match_request(&services, "api.example.com", 443, "/"),
        MatchOutcome::Ambiguous(vec!["a".into(), "b".into()])
    );
}

#[test]
fn dot_segments_are_detected_raw_and_encoded() {
    for bad in [
        "/repos/acme/../../user/keys",
        "/repos/acme/./x",
        "/repos/acme/%2e%2e/user",
        "/repos/acme/%2E%2e/user",
        "/repos/acme/.%2E/user",
        "/repos/acme/%2e/x",
        "/repos/acme/..",
        "/repos/acme\\..\\user",
        "/repos/acme%5c..%5cuser",
    ] {
        assert!(has_dot_segment(bad), "{bad}");
    }
    for ok in [
        "/",
        "/repos/acme",
        "/a/.well-known/x",
        "/a/..b/c",
        "/a/b..",
        "/v1/file.txt",
    ] {
        assert!(!has_dot_segment(ok), "{ok}");
    }
}

#[test]
fn connect_time_checks_ignore_the_path() {
    let services = vec![stored(test_service("v2", "api.example.com", None, "/v2"))];
    assert!(host_is_brokered(&services, "api.example.com", 443));
    assert!(!host_is_brokered(&services, "other.example.com", 443));
}

#[test]
fn inputs_validate_auth_and_substitutions() {
    let mut input = test_service("svc", "API.Example.com", None, "");
    input.substitutions = vec![Substitution {
        placeholder: "__KEY__".into(),
        reference: "secret:prod:/db/KEY".into(),
        surfaces: vec![Surface::Path, Surface::Header, Surface::Path],
    }];
    let normalized = input.clone().normalize().unwrap();
    assert_eq!(normalized.host, "api.example.com");
    assert_eq!(normalized.path_prefix, "/");
    assert_eq!(
        normalized.substitutions[0].surfaces,
        vec![Surface::Header, Surface::Path]
    );

    let mut bad = input.clone();
    bad.auth = ServiceAuth::Bearer {
        token: "OPENAI_KEY".into(),
    };
    assert!(bad.normalize().is_err());
    let mut bad = input.clone();
    bad.auth = ServiceAuth::ApiKey {
        header: "Host".into(),
        value: "secret:K".into(),
        prefix: String::new(),
    };
    assert!(bad.normalize().is_err());
    let mut bad = input.clone();
    bad.substitutions[0].placeholder = "KEY".into();
    assert!(bad.normalize().is_err());
    let mut bad = input;
    bad.name = "Bad Name".into();
    assert!(bad.normalize().is_err());
}

#[test]
fn refs_cover_auth_and_substitutions() {
    let mut input = test_service("svc", "api.example.com", None, "/");
    input.auth = ServiceAuth::Custom {
        headers: [("x-sig".to_owned(), "{{secret:A}}:{{secret:B}}".to_owned())].into(),
    };
    input.substitutions = vec![Substitution {
        placeholder: "__C__".into(),
        reference: "secret:C".into(),
        surfaces: vec![Surface::Query],
    }];
    let service = stored(input);
    assert_eq!(service.refs(), vec!["secret:A", "secret:B", "secret:C"]);
}

#[tokio::test]
async fn crud_round_trips_and_rejects_duplicates() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let input = test_service("svc", "api.example.com", None, "/")
        .normalize()
        .unwrap();
    insert(&conn, input.clone()).unwrap();
    let error = insert(&conn, input.clone()).unwrap_err();
    assert_eq!(
        error.downcast_ref::<VaultError>().unwrap().code(),
        "vault_conflict"
    );
    let mut same_route = test_service("other", "api.example.com", None, "/");
    same_route = same_route.normalize().unwrap();
    assert!(insert(&conn, same_route).is_err());
    let mut changed = input.clone();
    changed.enabled = false;
    update(&conn, changed).unwrap();
    assert!(!get(&conn, "svc").unwrap().unwrap().input.enabled);
    assert_eq!(usage(&conn, "secret:API_TOKEN").unwrap().len(), 1);
    assert_eq!(list(&conn, Some("prod")).unwrap().len(), 0);
    assert!(delete(&conn, "svc").unwrap());
    assert!(!delete(&conn, "svc").unwrap());
}
