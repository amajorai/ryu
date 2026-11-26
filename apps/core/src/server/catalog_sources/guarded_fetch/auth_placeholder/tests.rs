//! CE-19: a custom source's credential may not name one of Ryu's own
//! environment variables. The pure rule, and the add route that applies it.

use super::*;
use crate::catalog_source::{CatalogKind, CatalogSourceRegistry};
use crate::server::{catalog_sources_add, AddCatalogSourceBody};
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::json;

fn auth(bearer: Option<&str>, headers: &[(&str, &str)]) -> SourceAuth {
    SourceAuth {
        bearer: bearer.map(str::to_owned),
        headers: headers
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
    }
}

#[test]
fn a_placeholder_is_read_as_the_fetch_reads_it() {
    // Trimmed name between `${` and the next `}`, anywhere in the value.
    assert_eq!(own_variable_placeholders("${RYU_TOKEN}"), ["RYU_TOKEN"]);
    assert_eq!(
        own_variable_placeholders(" Bearer ${ RYU_TOKEN } "),
        ["RYU_TOKEN"]
    );
    assert_eq!(
        own_variable_placeholders("${ACME_TOKEN}:${RYU_GATEWAY_KEY}:${RYU_GATEWAY_TOKEN}"),
        ["RYU_GATEWAY_KEY", "RYU_GATEWAY_TOKEN"]
    );
    // No placeholder, an unterminated one, and a name that only mentions RYU_.
    assert!(own_variable_placeholders("RYU_TOKEN").is_empty());
    assert!(own_variable_placeholders("prefix ${RYU_TOKEN").is_empty());
    assert!(own_variable_placeholders("${MY_RYU_TOKEN}").is_empty());
    assert!(own_variable_placeholders("${}").is_empty());
}

#[test]
fn every_ryu_variable_is_refused_whatever_its_case() {
    for name in [
        "RYU_TOKEN",
        "RYU_GATEWAY_KEY",
        "RYU_GATEWAY_TOKEN",
        "RYU_MASTER_KEY",
        "RYU_ANYTHING_ELSE",
        "ryu_token",
        "Ryu_Token",
    ] {
        let value = format!("${{{name}}}");
        assert_eq!(own_variable_placeholders(&value), [name], "{name}");
    }
    for name in ["ACME_TOKEN", "RYU", "RYUTOKEN", "GITHUB_TOKEN", "RYUé_X"] {
        let value = format!("${{{name}}}");
        assert!(own_variable_placeholders(&value).is_empty(), "{name}");
    }
}

#[test]
fn a_credential_is_refused_in_the_bearer_and_in_any_header() {
    assert_eq!(source_auth_refusal(&auth(None, &[])), None);
    assert_eq!(
        source_auth_refusal(&auth(
            Some("${ACME_MARKETPLACE_TOKEN}"),
            &[("X-Org", "acme"), ("X-Key", "${ACME_KEY}")]
        )),
        None
    );
    let in_bearer = source_auth_refusal(&auth(Some("${RYU_TOKEN}"), &[])).expect("refused");
    assert!(in_bearer.contains("RYU_TOKEN"), "{in_bearer}");
    let in_header = source_auth_refusal(&auth(
        Some("${ACME_MARKETPLACE_TOKEN}"),
        &[
            ("X-Org", "acme"),
            ("X-Relay", "Bearer ${RYU_GATEWAY_TOKEN}"),
        ],
    ))
    .expect("refused");
    assert!(in_header.contains("RYU_GATEWAY_TOKEN"), "{in_header}");
}

#[test]
fn the_refusal_names_the_variable_and_never_its_value() {
    // The rule reads nothing from the environment, so it cannot print a value.
    // Checked against the real node token variable when this process has one.
    let refusal = source_auth_refusal(&auth(Some("${RYU_TOKEN}"), &[])).expect("refused");
    if let Ok(value) = std::env::var("RYU_TOKEN") {
        if value.len() >= 8 {
            assert!(!refusal.contains(&value), "the refusal printed the value");
        }
    }
    assert!(refusal.contains("'RYU_TOKEN'"), "{refusal}");
}

fn add_body(id: &str, bearer: &str) -> AddCatalogSourceBody {
    serde_json::from_value(json!({
        "kind": "plugin",
        "id": id,
        "display_name": "CE-19 probe",
        "auth": { "bearer": bearer }
    }))
    .expect("a valid add body")
}

/// The add route, as a person in Settings or any HTTP caller reaches it. Fails
/// before the fix: the route answered 200 and saved the source.
#[tokio::test]
async fn the_add_route_refuses_a_credential_that_names_a_ryu_variable() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("catalog-sources.json");
    let mut state = crate::server::isolated_plugin_hook_test_state(dir.path());
    // A registry on a temporary file, never the node's real sources file.
    state.catalog_sources = std::sync::Arc::new(CatalogSourceRegistry::with_file(file.clone()));

    let (status, Json(reply)) = catalog_sources_add(
        State(state.clone()),
        Json(add_body("ce19-probe", "${RYU_TOKEN}")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{reply}");
    let message = reply["error"].as_str().unwrap_or_default();
    assert!(message.contains("RYU_TOKEN"), "{reply}");
    assert!(
        state
            .catalog_sources
            .source_by_id(CatalogKind::Plugin, "ce19-probe")
            .is_none(),
        "a refused source was registered"
    );
    assert!(!file.exists(), "a refused source was written to disk");

    // Control: the operator's own variable is accepted, as before.
    let (status, Json(reply)) = catalog_sources_add(
        State(state.clone()),
        Json(add_body("ce19-own", "${ACME_MARKETPLACE_TOKEN}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert!(state
        .catalog_sources
        .source_by_id(CatalogKind::Plugin, "ce19-own")
        .is_some());
}
