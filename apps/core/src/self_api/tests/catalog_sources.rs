//! Catalog source writes (add, remove, select, reorder) are not CoreApi tools.

use super::*;
// Module-private items, reached through the module that owns them.
use crate::self_api::denylist::{is_credential_write, DENIED_CREDENTIAL_WRITE_PREFIXES};

/// The four writes the OpenAPI document has under `/api/catalog/sources`.
const SOURCE_WRITES: &[(&str, &str)] = &[
    ("post", "/api/catalog/sources"),
    ("delete", "/api/catalog/sources"),
    ("post", "/api/catalog/sources/select"),
    ("post", "/api/catalog/sources/reorder"),
];

/// The tool ids those writes had while the catalog offered them.
const SOURCE_WRITE_TOOLS: &[&str] = &[
    "ryu_api.post_api_catalog_sources",
    "ryu_api.delete_api_catalog_sources",
    "ryu_api.post_api_catalog_sources_select",
    "ryu_api.post_api_catalog_sources_reorder",
];

/// A catalog source is where installs and updates come from, so every write on
/// or below the path is denied, whatever the verb. Listing the sources is a
/// read and stays allowed.
#[test]
fn catalog_source_writes_are_denied_and_the_list_is_not() {
    assert!(DENIED_CREDENTIAL_WRITE_PREFIXES.contains(&"/api/catalog/sources"));
    for &(method, path) in SOURCE_WRITES {
        assert!(is_denied(path, method), "{method} {path}");
        assert!(is_credential_write(path, method), "{method} {path}");
    }
    // Every write verb, and a path below the prefix, so a write added later is
    // denied without a new entry.
    for path in [
        "/api/catalog/sources",
        "/api/catalog/sources/select",
        "/api/catalog/sources/reorder",
        "/api/catalog/sources/{id}",
    ] {
        for method in ["post", "put", "patch", "delete"] {
            assert!(is_denied(path, method), "{path} {method}");
        }
        assert!(!is_denied(path, "get"), "{path} get");
    }
    // A route stores its method in uppercase, and the sender checks that form.
    assert!(is_denied("/api/catalog/sources", "POST"));
    assert!(is_denied("/api/catalog/sources", "DELETE"));
    assert!(!is_denied("/api/catalog/sources", "GET"));
    // The prefix ends at a path segment, so a near miss keeps its own rules.
    assert!(!is_denied("/api/catalog/sources-mirror", "post"));
    assert!(!is_denied("/api/catalog", "get"));
}

/// All four writes are in the OpenAPI document, so only the denylist keeps them
/// out of the catalog an agent searches, describes and calls.
#[test]
fn catalog_source_write_tools_are_absent_from_the_catalog() {
    let spec = serde_json::to_value(crate::server::openapi::api_doc()).unwrap();
    for &(method, path) in SOURCE_WRITES {
        assert!(
            spec["paths"][path][method].is_object(),
            "{method} {path} is not in the spec"
        );
    }
    for &id in SOURCE_WRITE_TOOLS {
        assert!(route_for(id).is_none(), "{id} is in the catalog");
        assert!(describe(id).is_none(), "{id} can be described");
    }
    assert!(
        !routes()
            .iter()
            .any(|r| r.method != "GET" && r.path_template.starts_with("/api/catalog/sources")),
        "a catalog source write is in the catalog"
    );
    assert!(
        !descriptors()
            .iter()
            .any(|d| SOURCE_WRITE_TOOLS.contains(&d.id.as_str())),
        "a catalog source write is in the search list"
    );
    // Listing the sources is still offered.
    let list = route_for("ryu_api.get_api_catalog_sources")
        .expect("the source list is not in the catalog");
    assert_eq!(list.method, "GET");
    assert_eq!(list.path_template, "/api/catalog/sources");
    assert!(describe("ryu_api.get_api_catalog_sources").is_some());
}

/// A catalog source write handed to the sender directly is refused before any
/// request is made.
#[tokio::test]
async fn send_request_refuses_a_catalog_source_write() {
    for &(method, path) in SOURCE_WRITES {
        let write = route(&method.to_uppercase(), path);
        let error = send_request(
            &reqwest::Client::new(),
            "http://127.0.0.1:9",
            None,
            &write,
            &json!({}),
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("resolved to a denied path"),
            "{method} {path}: {error}"
        );
    }
}
