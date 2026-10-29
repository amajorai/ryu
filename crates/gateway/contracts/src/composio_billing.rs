//! Composio's usage rate card, verified against composio.dev/pricing on 2026-10-02.
//! Amounts are integer micro-USD. Free allowances belong to the upstream project,
//! not each Ryu organization, and must never be duplicated across tenants.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComposioAuthSource {
    OwnApp,
    #[default]
    ManagedApp,
    Instant,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComposioUsageKind {
    #[default]
    ToolCall,
    TriggerEvent,
    Meta,
}

/// Facts from the execution owner, never model arguments or browser input.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposioUsage {
    pub kind: ComposioUsageKind,
    pub auth_source: ComposioAuthSource,
    #[serde(default)]
    pub direct_execution: bool,
    #[serde(default)]
    pub proxy_execution: bool,
    #[serde(default)]
    pub shared_connection: bool,
    #[serde(default)]
    pub sandbox_execution: bool,
    /// Exact Instant charge already includes Composio's 5% provider fee.
    /// None is different from a reported zero. Never add another 5%.
    #[serde(default)]
    pub premium_charge_micro_usd: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposioBillingPolicy {
    /// Global Composio ZDR rollout flag. Off until the shared project has ZDR
    /// enabled upstream. Applies the same surcharge to every organization.
    #[serde(default)]
    pub zero_data_retention: bool,
    #[serde(default)]
    pub baa: bool,
    #[serde(default)]
    pub ip_allowlist: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposioCharge {
    pub base_micro_usd: u64,
    pub addons_micro_usd: u64,
    pub premium_micro_usd: u64,
    pub total_micro_usd: u64,
}

pub fn price_composio_usage(
    usage: &ComposioUsage,
    policy: &ComposioBillingPolicy,
    units: u64,
) -> Result<ComposioCharge, &'static str> {
    if units == 0 {
        return Err("Composio usage units must be positive");
    }
    let managed = usage.auth_source == ComposioAuthSource::ManagedApp;
    let base = match usage.kind {
        ComposioUsageKind::Meta => 0_u64,
        ComposioUsageKind::ToolCall if managed => 500,
        ComposioUsageKind::ToolCall => 300,
        ComposioUsageKind::TriggerEvent if managed => 5_000,
        ComposioUsageKind::TriggerEvent => 3_000,
    };
    if usage.kind != ComposioUsageKind::ToolCall
        && (usage.direct_execution
            || usage.proxy_execution
            || usage.shared_connection
            || usage.sandbox_execution
            || usage.premium_charge_micro_usd.is_some())
    {
        return Err("Tool-call add-ons cannot be applied to triggers or meta tools");
    }
    let addons = if usage.kind == ComposioUsageKind::ToolCall {
        u64::from(usage.direct_execution) * 100
            + u64::from(usage.proxy_execution) * 200
            + u64::from(usage.shared_connection) * 300
            + u64::from(usage.sandbox_execution) * 100
            + u64::from(policy.zero_data_retention) * 100
            + u64::from(policy.baa) * 300
            + u64::from(policy.ip_allowlist) * 100
    } else {
        0
    };
    let base_micro_usd = base.checked_mul(units).ok_or("Composio charge overflow")?;
    let addons_micro_usd = addons
        .checked_mul(units)
        .ok_or("Composio charge overflow")?;
    // This is the reported charge for the transaction, not a per-unit estimate.
    let premium_micro_usd = usage.premium_charge_micro_usd.unwrap_or(0);
    let total_micro_usd = base_micro_usd
        .checked_add(addons_micro_usd)
        .and_then(|value| value.checked_add(premium_micro_usd))
        .ok_or("Composio charge overflow")?;
    Ok(ComposioCharge {
        base_micro_usd,
        addons_micro_usd,
        premium_micro_usd,
        total_micro_usd,
    })
}

/// Parse exact USD strings without binary floating point or truncating spend.
/// Fractions below a micro-dollar round up once at the transaction boundary.
pub fn usd_string_to_micro_usd(value: &str) -> Result<u64, &'static str> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || value.len() > 64
    {
        return Err("Invalid Composio USD amount");
    }
    let dollars = whole
        .parse::<u64>()
        .map_err(|_| "Composio charge overflow")?;
    let mut micros = dollars
        .checked_mul(1_000_000)
        .ok_or("Composio charge overflow")?;
    let digits = &fraction[..fraction.len().min(6)];
    let fractional = if digits.is_empty() {
        0
    } else {
        digits
            .parse::<u64>()
            .map_err(|_| "Invalid Composio USD amount")?
            * 10_u64.pow(6 - digits.len() as u32)
    };
    micros = micros
        .checked_add(fractional)
        .ok_or("Composio charge overflow")?;
    if fraction.bytes().skip(6).any(|byte| byte != b'0') {
        micros = micros.checked_add(1).ok_or("Composio charge overflow")?;
    }
    Ok(micros)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_calls_and_delivered_events_separately_for_both_auth_sources() {
        for (auth_source, call, trigger) in [
            (ComposioAuthSource::OwnApp, 300, 3_000),
            (ComposioAuthSource::ManagedApp, 500, 5_000),
            (ComposioAuthSource::Instant, 300, 3_000),
        ] {
            for (kind, rate) in [
                (ComposioUsageKind::ToolCall, call),
                (ComposioUsageKind::TriggerEvent, trigger),
            ] {
                let usage = ComposioUsage {
                    auth_source,
                    kind,
                    ..Default::default()
                };
                assert_eq!(
                    price_composio_usage(&usage, &ComposioBillingPolicy::default(), 2)
                        .unwrap()
                        .total_micro_usd,
                    rate * 2
                );
            }
        }
    }

    #[test]
    fn premium_is_exact_and_zdr_is_an_addon_without_an_enterprise_gate() {
        let usage = ComposioUsage {
            auth_source: ComposioAuthSource::Instant,
            direct_execution: true,
            premium_charge_micro_usd: Some(8_000),
            ..Default::default()
        };
        let policy = ComposioBillingPolicy {
            zero_data_retention: true,
            ..Default::default()
        };
        assert_eq!(
            price_composio_usage(&usage, &policy, 1).unwrap(),
            ComposioCharge {
                base_micro_usd: 300,
                addons_micro_usd: 200,
                premium_micro_usd: 8_000,
                total_micro_usd: 8_500
            }
        );
    }

    #[test]
    fn trigger_zdr_is_not_charged_as_a_tool_addon_and_meta_is_free() {
        let policy = ComposioBillingPolicy {
            zero_data_retention: true,
            baa: true,
            ip_allowlist: true,
        };
        for (kind, expected) in [
            (ComposioUsageKind::TriggerEvent, 5_000),
            (ComposioUsageKind::Meta, 0),
        ] {
            let usage = ComposioUsage {
                kind,
                ..Default::default()
            };
            assert_eq!(
                price_composio_usage(&usage, &policy, 1)
                    .unwrap()
                    .total_micro_usd,
                expected
            );
        }
    }

    #[test]
    fn invalid_or_overflowing_usage_is_rejected() {
        assert!(price_composio_usage(
            &ComposioUsage::default(),
            &ComposioBillingPolicy::default(),
            u64::MAX
        )
        .is_err());
        assert!(price_composio_usage(
            &ComposioUsage::default(),
            &ComposioBillingPolicy::default(),
            0
        )
        .is_err());
        let usage = ComposioUsage {
            kind: ComposioUsageKind::TriggerEvent,
            direct_execution: true,
            ..Default::default()
        };
        assert!(price_composio_usage(&usage, &ComposioBillingPolicy::default(), 1).is_err());
    }

    #[test]
    fn global_zdr_rollout_defaults_off_and_only_adds_tool_surcharge() {
        let disabled: ComposioBillingPolicy = serde_json::from_str("{}").unwrap();
        assert!(!disabled.zero_data_retention);
        let enabled = ComposioBillingPolicy {
            zero_data_retention: true,
            ..Default::default()
        };
        let direct_call = ComposioUsage {
            direct_execution: true,
            premium_charge_micro_usd: Some(8000),
            ..Default::default()
        };
        assert_eq!(
            price_composio_usage(&direct_call, &disabled, 1)
                .unwrap()
                .total_micro_usd,
            8600
        );
        assert_eq!(
            price_composio_usage(&direct_call, &enabled, 1)
                .unwrap()
                .total_micro_usd,
            8700
        );
        for policy in [&disabled, &enabled] {
            let trigger = ComposioUsage {
                kind: ComposioUsageKind::TriggerEvent,
                ..Default::default()
            };
            assert_eq!(
                price_composio_usage(&trigger, policy, 1)
                    .unwrap()
                    .total_micro_usd,
                5000
            );
        }
    }

    #[test]
    fn exact_decimal_amounts_preserve_provider_cost() {
        for (usd, micros) in [
            ("0", 0),
            ("0.008", 8_000),
            ("1.20", 1_200_000),
            ("0.0000001", 1),
            ("0.0000010", 1),
        ] {
            assert_eq!(usd_string_to_micro_usd(usd), Ok(micros));
        }
        for invalid in ["-1", "NaN", "1e3", ".1", "1.2.3", "18446744073709551615"] {
            assert!(usd_string_to_micro_usd(invalid).is_err());
        }
    }
}
