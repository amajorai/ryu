//! Host API table tests: the version, uniqueness, the capability→grant
//! bijection, and the join of the method parts.

use super::{grant_for, m, methods, HostApiMethod, HOST_API_METHODS, HOST_API_VERSION};

#[test]
fn host_api_version_is_valid_semver() {
    let v = semver::Version::parse(HOST_API_VERSION)
        .expect("HOST_API_VERSION must parse as strict semver");
    assert!(v.major >= 1, "host API starts at major 1");
}

#[test]
fn methods_are_unique() {
    let mut seen = std::collections::HashSet::new();
    for e in HOST_API_METHODS {
        assert!(seen.insert(e.method), "duplicate method '{}'", e.method);
    }
}

#[test]
fn capability_grant_relationship_is_consistent() {
    // Every capability maps to at most ONE grant (the bijection the TS
    // GRANT_CAPABILITY derivation relies on): all methods sharing a capability
    // must share the same grant.
    use std::collections::HashMap;
    let mut cap_grant: HashMap<&str, Option<&str>> = HashMap::new();
    for e in HOST_API_METHODS {
        let prev = cap_grant.entry(e.capability).or_insert(e.grant);
        assert_eq!(
            *prev, e.grant,
            "capability '{}' has two grants: {:?} and {:?}",
            e.capability, *prev, e.grant
        );
    }
}

#[test]
fn grant_for_reads_the_table() {
    assert_eq!(grant_for("model.complete"), Some("hook:side-model"));
    assert_eq!(grant_for("agent.run"), Some("hook:run-agent"));
    assert_eq!(grant_for("agent.runFanout"), Some("hook:run-agent"));
    assert_eq!(grant_for("storage.get"), Some("storage:kv"));
    assert_eq!(grant_for("crypto.seal"), Some("crypto:seal"));
    assert_eq!(grant_for("crypto.open"), Some("crypto:seal"));
    assert_eq!(grant_for("crypto.status"), Some("crypto:seal"));
    assert_eq!(grant_for("spaces.createDoc"), Some("spaces:docs"));
    assert_eq!(grant_for("spaces.queryDatabase"), Some("spaces:database"));
    assert_eq!(grant_for("spaces.deleteDatabase"), Some("spaces:database"));
    assert_eq!(grant_for("finetune.stream"), Some("finetune:runs"));
    assert_eq!(grant_for("view.action"), Some("views:actions"));
    assert_eq!(grant_for("subscriptions.list"), Some("subscriptions:read"));
    assert_eq!(grant_for("subscriptions.usage"), Some("subscriptions:read"));
    // Reserved name only: no method may require the pin grant yet.
    assert!(HOST_API_METHODS
        .iter()
        .all(|e| e.grant != Some("subscriptions:pin")));
    // Local host caps carry no Gateway grant.
    assert_eq!(grant_for("widget.setState"), None);
    assert_eq!(grant_for("ui.requestClose"), None);
    // Unknown method → None.
    assert_eq!(grant_for("nope"), None);
}

#[test]
fn view_action_is_rust_only() {
    let e = HOST_API_METHODS
        .iter()
        .find(|e| e.method == "view.action")
        .expect("view.action present");
    assert!(!e.ts_host, "view.action must be Rust-bridge-only");
}

#[test]
fn concat_keeps_every_row_in_order() {
    let parts = [
        methods::part_1::ROWS,
        methods::part_2::ROWS,
        methods::part_3::ROWS,
        methods::part_4::ROWS,
        methods::part_5::ROWS,
    ];
    let joined: Vec<HostApiMethod> = parts.iter().flat_map(|part| part.iter().copied()).collect();
    assert!(
        parts.iter().all(|part| !part.is_empty()),
        "no part is empty"
    );
    assert_eq!(
        HOST_API_METHODS.len(),
        joined.len(),
        "no row lost or duplicated"
    );
    assert_eq!(
        HOST_API_METHODS,
        joined.as_slice(),
        "rows keep their part order"
    );
    // The table's ends are fixed points of `schemas/host-api.json`.
    assert_eq!(
        HOST_API_METHODS.first().map(|e| e.method),
        Some("files.read")
    );
    assert_eq!(
        HOST_API_METHODS.last().map(|e| e.method),
        Some("view.action")
    );
}

#[test]
fn concat_joins_chunks_of_any_shape() {
    const A: &[HostApiMethod] = &[m("a", "cap.a", None, false, true)];
    const B: &[HostApiMethod] = &[];
    const C: &[HostApiMethod] = &[
        m("c1", "cap.c", Some("c:c"), true, true),
        m("c2", "cap.c", Some("c:c"), false, false),
    ];
    const JOINED: [HostApiMethod; 3] = methods::concat(&[A, B, C]);
    let names: Vec<&str> = JOINED.iter().map(|e| e.method).collect();
    assert_eq!(names, ["a", "c1", "c2"]);
    assert!(JOINED[1].streaming && !JOINED[2].ts_host);
}
