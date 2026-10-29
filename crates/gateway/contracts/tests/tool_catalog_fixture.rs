//! Golden cases for the curated tool catalog contract (Treg parity B3), shared
//! with the TypeScript twin, plus checks that the seed agrees with the price
//! catalog and the taxonomy already in this crate.

use std::collections::BTreeMap;

use ryu_gw_contracts::capability_taxonomy::builtin_taxonomy;
use ryu_gw_contracts::tool_catalog::{
    apply_verification_result, builtin_generated_tool_catalog, builtin_tool_catalog,
    catalog_free_route_allowed, catalog_paid_routing_allowed, generated_entries_beside,
    select_catalog_entry, validate_catalog_entry, validate_generated_catalog,
    validate_tool_catalog, CatalogEntry, CatalogIssue, CatalogProbe, CatalogTier, ToolCatalog,
    Verification, VerificationResult, VerificationState, TOOL_CATALOG_VERSION,
    VERIFIER_CREDENTIAL_HOSTS,
};
use ryu_gw_contracts::tool_price::{builtin_price_catalog, PricePrecedence, PriceSource};
use serde::Deserialize;

const CASES: &str = include_str!("../fixtures/tool-catalog-cases-v1.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cases {
    version: u32,
    description: String,
    validation: Vec<ValidationCase>,
    transitions: Vec<TransitionCase>,
    entries: BTreeMap<String, CatalogEntry>,
    select: Vec<SelectCase>,
    paid_routing: Vec<PaidCase>,
    free_route: Vec<PaidCase>,
    catalog_checks: Vec<CatalogCheckCase>,
    beside: Vec<BesideCase>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogCheckCase {
    name: String,
    entries: Vec<String>,
    issues: Vec<CatalogIssue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BesideCase {
    name: String,
    curated: Vec<String>,
    generated: Vec<String>,
    expected: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationCase {
    name: String,
    entry: CatalogEntry,
    issues: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransitionCase {
    name: String,
    current: Verification,
    result: VerificationResult,
    expected: Verification,
    changed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectCase {
    name: String,
    precedence: PricePrecedence,
    ryu: Option<String>,
    treg: Option<String>,
    expected: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PaidCase {
    name: String,
    entry: String,
    price: Option<String>,
    allowed: bool,
}

fn cases() -> Cases {
    let cases: Cases = serde_json::from_str(CASES).expect("case file decodes");
    assert_eq!(cases.version, TOOL_CATALOG_VERSION);
    assert!(!cases.description.is_empty());
    cases
}

#[test]
fn validation_cases() {
    for case in cases().validation {
        assert_eq!(
            validate_catalog_entry(&case.entry),
            case.issues,
            "validation: {}",
            case.name
        );
    }
}

#[test]
fn transition_cases() {
    for case in cases().transitions {
        let (next, changed) = apply_verification_result(&case.current, &case.result);
        assert_eq!(next, case.expected, "transition: {}", case.name);
        assert_eq!(changed, case.changed, "transition changed: {}", case.name);
    }
}

#[test]
fn select_cases() {
    let cases = cases();
    let named = |name: &Option<String>| name.as_ref().map(|name| &cases.entries[name]);
    for case in &cases.select {
        let chosen = select_catalog_entry(named(&case.ryu), named(&case.treg), case.precedence);
        assert_eq!(chosen, named(&case.expected), "select: {}", case.name);
    }
}

#[test]
fn paid_routing_cases() {
    let cases = cases();
    let prices = builtin_price_catalog().unwrap();
    for case in &cases.paid_routing {
        let entry = &cases.entries[&case.entry];
        let price = case
            .price
            .as_deref()
            .and_then(|endpoint| prices.row(endpoint));
        assert_eq!(
            catalog_paid_routing_allowed(entry, price),
            case.allowed,
            "paid routing: {}",
            case.name
        );
    }
}

#[test]
fn free_route_cases() {
    let cases = cases();
    let prices = builtin_price_catalog().unwrap();
    for case in &cases.free_route {
        let entry = &cases.entries[&case.entry];
        let price = case
            .price
            .as_deref()
            .and_then(|endpoint| prices.row(endpoint));
        assert_eq!(
            catalog_free_route_allowed(entry, price),
            case.allowed,
            "free route: {}",
            case.name
        );
    }
}

#[test]
fn catalog_check_cases() {
    let cases = cases();
    for case in &cases.catalog_checks {
        let catalog = ToolCatalog {
            version: TOOL_CATALOG_VERSION,
            description: String::new(),
            entries: case
                .entries
                .iter()
                .map(|name| cases.entries[name].clone())
                .collect(),
        };
        let issues = validate_tool_catalog(
            &catalog,
            builtin_taxonomy().unwrap(),
            builtin_price_catalog().unwrap(),
        );
        assert_eq!(issues, case.issues, "catalog check: {}", case.name);
    }
}

#[test]
fn beside_cases() {
    let cases = cases();
    let pick = |names: &[String]| -> Vec<CatalogEntry> {
        names
            .iter()
            .map(|name| cases.entries[name].clone())
            .collect()
    };
    for case in &cases.beside {
        let curated = pick(&case.curated);
        let generated = pick(&case.generated);
        let kept: Vec<&str> = generated_entries_beside(&curated, &generated)
            .into_iter()
            .map(|entry| entry.endpoint.as_str())
            .collect();
        assert_eq!(kept, case.expected, "beside: {}", case.name);
    }
}

#[test]
fn the_generated_tier_validates_beside_the_seed() {
    let generated = builtin_generated_tool_catalog().unwrap();
    let curated = builtin_tool_catalog().unwrap();
    let issues = validate_generated_catalog(
        generated,
        curated,
        builtin_taxonomy().unwrap(),
        builtin_price_catalog().unwrap(),
    );
    assert!(issues.is_empty(), "{issues:?}");
    let prices = builtin_price_catalog().unwrap();
    for entry in &generated.entries {
        assert_eq!(entry.tier, CatalogTier::Generated, "{}", entry.endpoint);
        assert_eq!(entry.source, PriceSource::Ryu, "{}", entry.endpoint);
        assert_eq!(entry.verification.state, VerificationState::Unverified);
        let spec = entry.spec.as_ref().expect("spec");
        assert!(spec.url.starts_with("https://"), "{}", spec.url);
        assert_eq!(entry.docs_url, spec.url, "{}", entry.endpoint);
        // Without a reviewed price a generated row never routes a paid call.
        assert!(!catalog_paid_routing_allowed(
            entry,
            prices.row(&entry.endpoint)
        ));
    }
    assert_eq!(
        generated_entries_beside(&curated.entries, &generated.entries).len(),
        generated.entries.len(),
        "curated rows win: the generated file holds no collision"
    );
}

#[test]
fn the_seed_validates_against_taxonomy_and_prices() {
    let catalog = builtin_tool_catalog().unwrap();
    let issues = validate_tool_catalog(
        catalog,
        builtin_taxonomy().unwrap(),
        builtin_price_catalog().unwrap(),
    );
    assert!(issues.is_empty(), "{issues:?}");
}

#[test]
fn the_seed_holds_only_native_github_and_vendor_priced_rows() {
    let catalog = builtin_tool_catalog().unwrap();
    let prices = builtin_price_catalog().unwrap();
    for entry in &catalog.entries {
        assert_eq!(entry.source, PriceSource::Ryu, "{}", entry.endpoint);
        assert!(
            matches!(
                entry.provider.as_str(),
                "github" | "exa" | "tavily" | "brave"
            ),
            "{}",
            entry.endpoint
        );
        // Every entry joins a price row checked on the vendor's own page.
        let price = prices.row(&entry.endpoint).expect("priced");
        assert!(price
            .source_url
            .as_deref()
            .is_some_and(|url| url.starts_with("https://")));
        // A drifted entry never routes a paid call, whatever its price says.
        if entry.verification.state != VerificationState::Verified {
            assert!(!catalog_paid_routing_allowed(entry, Some(price)));
        }
    }
    let github: Vec<_> = catalog
        .entries
        .iter()
        .filter(|entry| entry.toolkit.as_deref() == Some("github"))
        .collect();
    assert_eq!(github.len(), 8);
}

#[test]
fn seed_credentials_name_only_allowlisted_hosts() {
    let catalog = builtin_tool_catalog().unwrap();
    for entry in &catalog.entries {
        for probe in &entry.probes {
            if let CatalogProbe::Http {
                credential: Some(credential),
                url,
                ..
            } = probe
            {
                let host = VERIFIER_CREDENTIAL_HOSTS
                    .iter()
                    .find(|(env, _)| *env == credential.env)
                    .map(|(_, host)| *host)
                    .expect("allowlisted credential");
                assert!(url.starts_with(&format!("https://{host}/")), "{url}");
            }
        }
    }
}
