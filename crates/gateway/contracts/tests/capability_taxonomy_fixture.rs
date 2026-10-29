//! Golden cases for the capability taxonomy (Treg parity B1). The same case file
//! drives the TypeScript twin, so both implementations agree on every issue
//! code, alias resolution and comparison key.

use std::collections::BTreeSet;

use ryu_gw_contracts::capability_taxonomy::{
    builtin_taxonomy, validate_taxonomy, Taxonomy, TaxonomyIssue, TaxonomyStatus, TAXONOMY_VERSION,
};
use serde::Deserialize;
use serde_json::Value;

const CASES: &str = include_str!("../fixtures/capability-taxonomy-cases-v1.json");

/// Core's facade verb table, read as text so this suite runs without building
/// Core. The verb-to-capability check below fails when a verb is added there
/// without a taxonomy row here.
const CAPABILITY_TOOLS: &str =
    include_str!("../../../../apps/core/src/sidecar/mcp/capability_tools.rs");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cases {
    version: u32,
    description: String,
    validation: Vec<ValidationCase>,
    resolve: Vec<ResolveCase>,
    comparison: Vec<ComparisonCase>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationCase {
    name: String,
    taxonomy: Taxonomy,
    issues: Vec<TaxonomyIssue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveCase {
    name: String,
    id: String,
    expected: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ComparisonCase {
    name: String,
    platform: String,
    capability: String,
    model: Option<String>,
    expected: Value,
}

fn cases() -> Cases {
    let cases: Cases = serde_json::from_str(CASES).expect("case file decodes");
    assert_eq!(cases.version, TAXONOMY_VERSION);
    assert!(!cases.description.is_empty());
    cases
}

#[test]
fn every_validation_case_reports_exactly_its_issues() {
    for case in cases().validation {
        let actual: BTreeSet<_> = validate_taxonomy(&case.taxonomy).into_iter().collect();
        let expected: BTreeSet<_> = case.issues.into_iter().collect();
        assert_eq!(actual, expected, "{}", case.name);
    }
}

#[test]
fn every_resolve_case_finds_its_canonical_capability() {
    let taxonomy = builtin_taxonomy().expect("built-in taxonomy is valid");
    for case in cases().resolve {
        let actual = taxonomy
            .resolve(&case.id)
            .map(|capability| capability.id.clone());
        assert_eq!(actual, case.expected, "{}", case.name);
    }
}

#[test]
fn every_comparison_case_keys_or_refuses_as_expected() {
    let taxonomy = builtin_taxonomy().expect("built-in taxonomy is valid");
    for case in cases().comparison {
        let actual = match taxonomy.comparison_key(
            &case.platform,
            &case.capability,
            case.model.as_deref(),
        ) {
            Ok(key) => serde_json::json!({ "key": key }),
            Err(error) => serde_json::json!({ "error": error.code() }),
        };
        assert_eq!(actual, case.expected, "{}", case.name);
    }
}

/// `(id, capability constant)` for each `Verb { … }` literal inside `verbs()`.
fn shipped_verbs() -> Vec<(String, String)> {
    let start = CAPABILITY_TOOLS
        .find("pub fn verbs()")
        .expect("capability_tools.rs defines verbs()");
    let body = &CAPABILITY_TOOLS[start..];
    let end = body
        .find("\npub fn ")
        .map_or(body.len(), |offset| offset + 1);
    let body = &body[..end];
    let mut verbs = Vec::new();
    for block in body.split("Verb {").skip(1) {
        let field = |name: &str| -> String {
            let line = block
                .lines()
                .map(str::trim)
                .find(|line| line.starts_with(&format!("{name}:")))
                .unwrap_or_else(|| panic!("verb literal without `{name}`: {block}"));
            line[name.len() + 1..]
                .trim()
                .trim_end_matches(',')
                .trim_matches('"')
                .to_owned()
        };
        verbs.push((field("id"), field("capability")));
    }
    verbs
}

/// The value of `pub const <name>: &str = "<value>";` in capability_tools.rs.
fn capability_constant(name: &str) -> String {
    let needle = format!("pub const {name}: &str = \"");
    let start = CAPABILITY_TOOLS
        .find(&needle)
        .unwrap_or_else(|| panic!("no constant {name}"))
        + needle.len();
    let rest = &CAPABILITY_TOOLS[start..];
    rest[..rest.find('"').expect("closing quote")].to_owned()
}

#[test]
fn every_shipped_facade_verb_is_one_promoted_capability_on_its_layer() {
    let taxonomy = builtin_taxonomy().expect("built-in taxonomy is valid");
    let verbs = shipped_verbs();
    assert!(verbs.len() >= 30, "verb table parse found {}", verbs.len());
    let mut seen = BTreeSet::new();
    for (verb, constant) in &verbs {
        let capability = taxonomy
            .capability_for_verb(verb)
            .unwrap_or_else(|| panic!("facade verb {verb} has no taxonomy capability"));
        assert_eq!(capability.status, TaxonomyStatus::Promoted, "{verb}");
        assert_eq!(&capability.id, verb, "one capability per facade verb");
        assert_eq!(
            capability.layer.as_deref(),
            Some(capability_constant(constant).as_str()),
            "{verb}: layer must be the verb's binding capability"
        );
        seen.insert(verb.as_str());
    }
    for capability in &taxonomy.capabilities {
        for verb in &capability.verbs {
            assert!(
                seen.contains(verb.as_str()),
                "taxonomy names verb {verb}, which capability_tools.rs does not ship"
            );
        }
    }
}
