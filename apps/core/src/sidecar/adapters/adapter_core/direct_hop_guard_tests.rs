//! The rule itself: which request counts as keyed, and that the Gateway hop is
//! never refused. The requests on the wire are in `direct_hop_guard_turn_tests.rs`.
use super::*;

#[test]
fn a_keyless_endpoint_is_never_refused_whatever_its_host() {
    // The rule reads the Gateway address, so the test holds the crate's lock for it.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    for base_url in [
        "http://127.0.0.1:8080",
        "http://127.0.0.1:8080/",
        "http://localhost:11434/v1",
        "https://models.example.test",
        "http://127.0.0.1:8080/?",
        // No scheme: no host is read, and the text holds no credential mark.
        "localhost:11434/v1",
    ] {
        assert!(!hop_carries_credential(base_url, None), "{base_url}");
        assert!(!hop_carries_credential(base_url, Some("")), "{base_url}");
        assert_eq!(keyed_direct_hop_refusal(base_url, None), None, "{base_url}");
    }
}

#[test]
fn a_key_makes_the_hop_keyed_on_any_host() {
    // The rule reads the Gateway address, so the test holds the crate's lock for it.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    for base_url in ["http://127.0.0.1:8080", "https://models.example.test"] {
        assert!(hop_carries_credential(base_url, Some("sk-test")));
        assert_eq!(
            keyed_direct_hop_refusal(base_url, Some("sk-test")),
            Some(KEYED_DIRECT_HOP_REFUSAL),
            "{base_url}"
        );
    }
}

#[test]
fn credentials_in_the_address_count_as_a_key() {
    // The rule reads the Gateway address, so the test holds the crate's lock for it.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    for base_url in [
        "https://user:secret@models.example.test",
        "https://token@models.example.test/v1",
        "https://:secret@models.example.test",
        "https://models.example.test?api_key=secret",
        "https://models.example.test/v1?key=secret",
        "https://models.example.test/?anything=1",
        "http://user:secret@127.0.0.1:8080",
        // An address in which no host is read is judged by its text.
        "models.example.test?api_key=secret",
        "user:secret@models.example.test",
        "user:secret@",
    ] {
        assert!(hop_carries_credential(base_url, None), "{base_url}");
        assert_eq!(
            keyed_direct_hop_refusal(base_url, None),
            Some(KEYED_DIRECT_HOP_REFUSAL),
            "{base_url}"
        );
    }
}

#[test]
fn the_gateway_hop_is_never_refused() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let previous = std::env::var_os("RYU_GATEWAY_URL");
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:47981");
    let gateway = crate::sidecar::gateway::gateway_url();
    let gateway_is_a_gateway_hop = is_gateway_hop(&gateway);
    let refused_for_the_gateway = keyed_direct_hop_refusal(&gateway, Some("gateway-token"));
    let refused_with_a_slash = keyed_direct_hop_refusal(&format!("{gateway}/"), Some("token"));
    let another_port_is_a_gateway_hop = is_gateway_hop("http://127.0.0.1:47982");
    let refused_elsewhere = keyed_direct_hop_refusal("http://127.0.0.1:47982", Some("token"));
    match previous {
        Some(value) => std::env::set_var("RYU_GATEWAY_URL", value),
        None => std::env::remove_var("RYU_GATEWAY_URL"),
    }
    assert!(gateway_is_a_gateway_hop, "{gateway}");
    assert_eq!(refused_for_the_gateway, None);
    assert_eq!(refused_with_a_slash, None);
    assert!(!another_port_is_a_gateway_hop);
    assert_eq!(refused_elsewhere, Some(KEYED_DIRECT_HOP_REFUSAL));
}

#[test]
fn the_refusal_names_the_slow_gateway_and_the_retry() {
    // Security's condition: nobody may read it as a configuration error.
    assert!(KEYED_DIRECT_HOP_REFUSAL.contains("The Gateway did not answer in time"));
    assert!(KEYED_DIRECT_HOP_REFUSAL.contains("Trying again may work"));
    assert!(!KEYED_DIRECT_HOP_REFUSAL.to_lowercase().contains("configur"));
}
