//! Golden cases for the tool price contract (Treg parity B2), shared with the
//! TypeScript twin, plus checks that Ryu's own catalog agrees with the other
//! rate sources already in this crate.

use std::collections::BTreeMap;

use ryu_gw_contracts::composio_billing::{
    price_composio_usage, ComposioAuthSource, ComposioBillingPolicy, ComposioUsage,
    ComposioUsageKind,
};
use ryu_gw_contracts::tool_price::{
    builtin_price_catalog, paid_routing_allowed, quote_price, select_price, validate_price_record,
    PriceConfidence, PricePrecedence, PriceProvenance, PriceRecord, PriceRule, PriceUsage, UsdRate,
    TOOL_PRICE_VERSION,
};
use serde::Deserialize;
use serde_json::Value;

const CASES: &str = include_str!("../fixtures/tool-price-cases-v1.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cases {
    version: u32,
    description: String,
    usd_rates: Vec<UsdRate>,
    validation: Vec<ValidationCase>,
    quote: Vec<QuoteCase>,
    records: BTreeMap<String, PriceRecord>,
    select: Vec<SelectCase>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationCase {
    name: String,
    record: PriceRecord,
    issues: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuoteCase {
    name: String,
    record: PriceRecord,
    usage: PriceUsage,
    expected: Value,
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

fn cases() -> Cases {
    let cases: Cases = serde_json::from_str(CASES).expect("case file decodes");
    assert_eq!(cases.version, TOOL_PRICE_VERSION);
    assert!(!cases.description.is_empty());
    cases
}

#[test]
fn every_validation_case_reports_exactly_its_codes() {
    for case in cases().validation {
        let mut expected = case.issues.clone();
        expected.sort();
        assert_eq!(
            validate_price_record(&case.record),
            expected,
            "{}",
            case.name
        );
    }
}

#[test]
fn every_quote_case_prices_or_refuses_as_expected() {
    let cases = cases();
    for case in &cases.quote {
        let actual = match quote_price(&case.record, &case.usage, &cases.usd_rates) {
            Ok(quote) => serde_json::to_value(quote).unwrap(),
            Err(error) => serde_json::json!({ "error": error.code() }),
        };
        assert_eq!(actual, case.expected, "{}", case.name);
    }
}

#[test]
fn every_select_case_picks_the_expected_source() {
    let cases = cases();
    let record = |name: &Option<String>| {
        name.as_ref()
            .map(|name| cases.records.get(name).expect("named record exists"))
    };
    for case in &cases.select {
        let selected = select_price(record(&case.ryu), record(&case.treg), case.precedence);
        let label = selected.map(|record| {
            serde_json::to_value(record.source)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        });
        assert_eq!(label, case.expected, "{}", case.name);
    }
}

#[test]
fn the_default_precedence_is_ryu_verified_first() {
    assert_eq!(
        PricePrecedence::default(),
        PricePrecedence::RyuVerifiedFirst
    );
}

#[test]
fn every_catalog_row_is_verified_and_cites_its_vendor() {
    let catalog = builtin_price_catalog().expect("built-in catalog is valid");
    assert!(catalog.rows.len() >= 10);
    // Rows whose cited page no longer shows the price are unverified (low
    // confidence) and never route a paid call. Adding one is deliberate.
    let dropped = ["exa.search.fast"];
    for row in &catalog.rows {
        let is_dropped = dropped.contains(&row.endpoint.as_str());
        assert_eq!(paid_routing_allowed(row), !is_dropped, "{}", row.endpoint);
        if is_dropped {
            assert_eq!(
                row.provenance,
                PriceProvenance::Unverified,
                "{}",
                row.endpoint
            );
            assert_eq!(row.confidence, PriceConfidence::Low, "{}", row.endpoint);
            let one = PriceUsage {
                calls: 1,
                ..PriceUsage::default()
            };
            assert!(
                quote_price(row, &one, &catalog.usd_rates).is_err(),
                "{}",
                row.endpoint
            );
        }
        assert!(row.checked_on.is_some(), "{}", row.endpoint);
        assert!(row.source_url.is_some(), "{}", row.endpoint);
    }
    for rate in &catalog.usd_rates {
        assert!(rate.checked_on.is_some(), "{}", rate.unit);
    }
}

#[test]
fn composio_rows_agree_with_the_composio_rate_card() {
    let catalog = builtin_price_catalog().expect("built-in catalog is valid");
    let one = PriceUsage {
        calls: 1,
        ..PriceUsage::default()
    };
    let cases = [
        (
            "composio.tool_call.managed_app",
            ComposioUsageKind::ToolCall,
            ComposioAuthSource::ManagedApp,
        ),
        (
            "composio.tool_call.own_app",
            ComposioUsageKind::ToolCall,
            ComposioAuthSource::OwnApp,
        ),
        (
            "composio.trigger_event.managed_app",
            ComposioUsageKind::TriggerEvent,
            ComposioAuthSource::ManagedApp,
        ),
        (
            "composio.trigger_event.own_app",
            ComposioUsageKind::TriggerEvent,
            ComposioAuthSource::OwnApp,
        ),
    ];
    for (endpoint, kind, auth_source) in cases {
        let charged = price_composio_usage(
            &ComposioUsage {
                kind,
                auth_source,
                ..ComposioUsage::default()
            },
            &ComposioBillingPolicy::default(),
            1,
        )
        .unwrap()
        .total_micro_usd;
        let quoted = catalog.quote(endpoint, &one).unwrap().unwrap().micro_usd;
        assert_eq!(quoted, charged, "{endpoint}");
    }
}

#[test]
fn free_rows_are_free_and_metered_rows_are_not() {
    let catalog = builtin_price_catalog().expect("built-in catalog is valid");
    let one = PriceUsage {
        calls: 1,
        ..PriceUsage::default()
    };
    for row in catalog.rows.iter().filter(|row| paid_routing_allowed(row)) {
        let quote = quote_price(row, &one, &catalog.usd_rates).unwrap();
        match row.price {
            PriceRule::Free => assert!(quote.free && quote.micro_usd == 0, "{}", row.endpoint),
            PriceRule::Metered { .. } => assert!(!quote.free, "{}", row.endpoint),
        }
    }
}
