use ryu_gw_contracts::composio_billing::{
    price_composio_usage, usd_string_to_micro_usd, ComposioAuthSource, ComposioBillingPolicy,
    ComposioUsage, ComposioUsageKind,
};

#[test]
fn receipt_consumers_can_import_the_public_billing_contract() {
    let usage = ComposioUsage {
        kind: ComposioUsageKind::ToolCall,
        auth_source: ComposioAuthSource::ManagedApp,
        direct_execution: true,
        premium_charge_micro_usd: Some(usd_string_to_micro_usd("0.008").unwrap()),
        ..Default::default()
    };
    let policy = ComposioBillingPolicy::default();
    assert_eq!(
        price_composio_usage(&usage, &policy, 1)
            .unwrap()
            .total_micro_usd,
        8_600
    );
}
