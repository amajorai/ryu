//! Tests for connect-time target screening.

use std::net::SocketAddr;

use super::{
    must_screen, resolve_screened, resolve_screened_with, screen_host_literal, TargetAuthority,
};

fn addr(value: &str) -> SocketAddr {
    value.parse().expect("valid socket address")
}

#[test]
fn delegates_are_always_screened_and_operators_never() {
    for multi_user in [false, true] {
        assert!(must_screen(TargetAuthority::Delegate, multi_user));
        assert!(!must_screen(TargetAuthority::Operator, multi_user));
    }
}

#[test]
fn unrecorded_targets_are_screened_only_where_delegation_exists() {
    assert!(!must_screen(TargetAuthority::Unrecorded, false));
    assert!(must_screen(TargetAuthority::Unrecorded, true));
}

#[test]
fn labels_round_trip_and_unknown_labels_are_unrecorded() {
    for authority in [TargetAuthority::Operator, TargetAuthority::Delegate] {
        assert_eq!(TargetAuthority::from_label(authority.label()), authority);
    }
    assert_eq!(TargetAuthority::Unrecorded.label(), None);
    assert_eq!(
        TargetAuthority::from_label(Some("root")),
        TargetAuthority::Unrecorded
    );
    assert_eq!(
        TargetAuthority::from_label(None),
        TargetAuthority::Unrecorded
    );
}

#[test]
fn internal_literals_and_socket_paths_are_refused() {
    for host in [
        "127.0.0.1",
        "[::1]",
        "::1",
        "10.1.2.3",
        "172.16.0.5",
        "192.168.1.10",
        "100.64.0.1",
        "169.254.169.254",
        "0.0.0.0",
        "224.0.0.1",
        "fd00::5",
        "fe80::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "64:ff9b::a00:1",
        "localhost",
        "db.localhost",
        "cache.local",
        "db.internal",
        "metadata.google.internal",
        "/tmp",
        "/var/run/postgresql",
        "@abstract",
        "",
    ] {
        assert!(screen_host_literal(host).is_err(), "{host} must be refused");
    }
    for host in [
        "db.example.com",
        "203.0.113.9",
        "8.8.8.8",
        "2606:4700::1111",
    ] {
        assert!(screen_host_literal(host).is_ok(), "{host} must be allowed");
    }
}

#[test]
fn a_public_name_that_resolves_internally_is_refused() {
    for internal in [
        "127.0.0.1:5432",
        "10.0.0.7:5432",
        "[::1]:5432",
        "[::ffff:192.168.0.1]:5432",
    ] {
        let refused =
            resolve_screened_with("db.example.com", 5432, |_, _| Ok(vec![addr(internal)]));
        assert!(refused.is_err(), "{internal} must be refused");
    }
}

#[test]
fn a_mixed_public_and_internal_answer_is_refused() {
    let refused = resolve_screened_with("db.example.com", 5432, |_, _| {
        Ok(vec![addr("8.8.8.8:5432"), addr("127.0.0.1:5432")])
    });
    assert!(refused.is_err());
}

/// DNS rebinding: the answer screened is the answer returned for the connect.
/// A later lookup (which a hostname-based connect would perform) that turns
/// internal is refused on its own, and never replaces the pinned address.
#[test]
fn the_screened_answer_is_the_one_returned_and_a_rebound_answer_is_refused() {
    let lookups = std::cell::Cell::new(0);
    let rebinding = |_: &str, port: u16| {
        lookups.set(lookups.get() + 1);
        Ok(vec![if lookups.get() == 1 {
            SocketAddr::from(([8, 8, 8, 8], port))
        } else {
            SocketAddr::from(([127, 0, 0, 1], port))
        }])
    };
    let pinned = resolve_screened_with("rebind.example.com", 6379, rebinding).unwrap();
    assert_eq!(pinned, vec![addr("8.8.8.8:6379")]);
    assert!(resolve_screened_with("rebind.example.com", 6379, rebinding).is_err());
}

#[test]
fn literal_hosts_are_refused_before_any_lookup() {
    let refused = resolve_screened_with("127.0.0.1", 5432, |_, _| {
        panic!("a refused literal must not be resolved")
    });
    assert!(refused.is_err());
}

#[tokio::test]
async fn system_resolution_refuses_loopback_and_private_literals() {
    assert!(resolve_screened("127.0.0.1", 5432).await.is_err());
    assert!(resolve_screened("192.168.0.1", 6379).await.is_err());
    assert_eq!(
        resolve_screened("8.8.8.8", 443).await.unwrap(),
        vec![addr("8.8.8.8:443")]
    );
}
