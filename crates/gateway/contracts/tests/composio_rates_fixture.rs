//! `composio_billing.rs` and the shared rate fixture must price every usage the
//! same way. The control plane's TypeScript pricer reads the same fixture for
//! Connect settlement, so a rate changed on one side fails here until the other
//! follows.

use ryu_gw_contracts::composio_billing::{
    price_composio_usage, ComposioBillingPolicy, ComposioUsage,
};
use serde_json::{json, Map, Value};

const FIXTURE: &str = include_str!("../fixtures/composio-rates.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("composio-rates.json is valid JSON")
}

fn table<'a>(value: &'a Value, key: &str) -> &'a Map<String, Value> {
    value[key]
        .as_object()
        .unwrap_or_else(|| panic!("fixture `{key}` is an object"))
}

fn micro_usd(value: &Value) -> u64 {
    value.as_u64().expect("fixture rates are integer micro-USD")
}

fn usage(fields: Value) -> ComposioUsage {
    serde_json::from_value(fields).expect("fixture keys are the receipt's wire names")
}

fn total(usage: &ComposioUsage, policy: &ComposioBillingPolicy) -> u64 {
    price_composio_usage(usage, policy, 1)
        .expect("fixture usage is priceable")
        .total_micro_usd
}

fn keys(map: &Map<String, Value>) -> Vec<&str> {
    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys
}

#[test]
fn base_rates_match_for_every_kind_and_auth_source() {
    let rates = fixture();
    let base = table(&rates, "base");
    assert_eq!(keys(base), ["meta", "toolCall", "triggerEvent"]);
    for (kind, by_auth) in base {
        let by_auth = by_auth.as_object().expect("base rates are per auth source");
        assert_eq!(keys(by_auth), ["instant", "managedApp", "ownApp"]);
        for (auth_source, rate) in by_auth {
            let priced = total(
                &usage(json!({ "kind": kind, "authSource": auth_source })),
                &ComposioBillingPolicy::default(),
            );
            assert_eq!(priced, micro_usd(rate), "{kind} via {auth_source}");
        }
    }
}

#[test]
fn tool_call_addons_match_and_stack_on_the_base_rate() {
    let rates = fixture();
    let addons = table(&rates, "toolCallAddons");
    assert_eq!(
        keys(addons),
        [
            "directExecution",
            "proxyExecution",
            "sandboxExecution",
            "sharedConnection"
        ]
    );
    let base = micro_usd(&rates["base"]["toolCall"]["managedApp"]);
    let mut all = json!({ "kind": "toolCall", "authSource": "managedApp" });
    let mut expected_all = base;
    for (flag, rate) in addons {
        let priced = total(
            &usage(json!({ "kind": "toolCall", "authSource": "managedApp", flag: true })),
            &ComposioBillingPolicy::default(),
        );
        assert_eq!(priced, base + micro_usd(rate), "{flag}");
        all[flag] = Value::Bool(true);
        expected_all += micro_usd(rate);
    }
    assert_eq!(
        total(&usage(all), &ComposioBillingPolicy::default()),
        expected_all
    );
}

#[test]
fn policy_addons_apply_to_tool_calls_only() {
    let rates = fixture();
    let addons = table(&rates, "policyAddons");
    assert_eq!(keys(addons), ["baa", "ipAllowlist", "zeroDataRetention"]);
    for (flag, rate) in addons {
        let policy: ComposioBillingPolicy =
            serde_json::from_value(json!({ flag: true })).expect("policy wire name");
        let call = usage(json!({ "kind": "toolCall", "authSource": "ownApp" }));
        assert_eq!(
            total(&call, &policy),
            micro_usd(&rates["base"]["toolCall"]["ownApp"]) + micro_usd(rate),
            "{flag}"
        );
        let trigger = usage(json!({ "kind": "triggerEvent", "authSource": "ownApp" }));
        assert_eq!(
            total(&trigger, &policy),
            micro_usd(&rates["base"]["triggerEvent"]["ownApp"]),
            "{flag} on a trigger"
        );
    }
}

#[test]
fn premium_charge_is_added_exactly_once() {
    let rates = fixture();
    let priced = total(
        &usage(json!({
            "kind": "toolCall",
            "authSource": "instant",
            "directExecution": true,
            "premiumChargeMicroUsd": 8000
        })),
        &ComposioBillingPolicy::default(),
    );
    assert_eq!(
        priced,
        micro_usd(&rates["base"]["toolCall"]["instant"])
            + micro_usd(&rates["toolCallAddons"]["directExecution"])
            + 8000
    );
}
