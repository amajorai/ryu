use super::tests::{context, spec};
use super::*;

#[test]
fn denied_member_retries_do_not_drain_the_org_rate_buckets() {
    let rate = crate::rate_limit::ScopedRateLimiter::default();
    let mut org = spec(1_000_000, LimitAction::Stop);
    org.rpm = Some(5);
    org.tpm = Some(1_000);
    let mut member = spec(1_000_000, LimitAction::Stop);
    member.rpm = Some(1);
    member.tpm = Some(100);
    let ctx = context(
        OrgLimits {
            org: Some(org),
            member_default: Some(member),
            ..OrgLimits::default()
        },
        &[],
    );

    assert!(admit_request(&rate, &ctx, Some("u1")));
    for _ in 0..20 {
        assert!(
            !admit_request(&rate, &ctx, Some("u1")),
            "member at its rpm cap"
        );
    }
    // The org bucket paid only for the one admitted request: 4 left.
    for other in ["u2", "u3", "u4", "u5"] {
        assert!(admit_request(&rate, &ctx, Some(other)), "{other} admitted");
    }
    assert!(!admit_request(&rate, &ctx, Some("u6")), "org rpm exhausted");

    assert!(admit_tokens(&rate, &ctx, Some("u1"), 100));
    for _ in 0..20 {
        assert!(!admit_tokens(&rate, &ctx, Some("u1"), 100));
    }
    // 900 org tokens remain despite 2_000 rejected tokens of retries.
    assert!(admit_tokens(&rate, &ctx, None, 900));
    assert!(!admit_tokens(&rate, &ctx, None, 50));
}

#[test]
fn an_oversized_prompt_is_admitted_once_then_throttled_by_its_debt() {
    // The plan's default ceiling (60k tpm) split across two gateways is a
    // 30k share; a 100k-token prompt estimate must still get through once.
    let rate = crate::rate_limit::ScopedRateLimiter::default();
    let mut org = spec(1_000_000, LimitAction::Stop);
    org.tpm = Some(60_000);
    let mut ctx = context(
        OrgLimits {
            org: Some(org),
            ..OrgLimits::default()
        },
        &[],
    );
    ctx.active_gateways = Some(2);
    assert!(admit_tokens(&rate, &ctx, None, 100_000), "admitted once");
    assert!(
        !admit_tokens(&rate, &ctx, None, 1_000),
        "the excess is debt that throttles what follows"
    );
}

#[test]
fn a_plan_rate_ceiling_narrows_the_org_cap_and_never_raises_it() {
    let ceiling = RateCeiling {
        rpm: Some(30),
        tpm: Some(60_000),
    };
    // No org-wide cap: one carrying only the ceiling, with no budget.
    let narrowed = OrgLimits::default().with_rate_ceiling(ceiling);
    let org = narrowed.org.as_ref().expect("org cap");
    assert_eq!((org.rpm, org.tpm), (Some(30), Some(60_000)));
    assert_eq!(org.budget_micro_usd, None);

    // An authored cap keeps its budget; the smaller rate wins each way.
    let mut authored = spec(5_000, LimitAction::Stop);
    authored.rpm = Some(500);
    authored.tpm = Some(10_000);
    let limits = OrgLimits {
        org: Some(authored),
        ..OrgLimits::default()
    };
    let narrowed = limits.with_rate_ceiling(ceiling);
    let org = narrowed.org.as_ref().expect("org cap");
    assert_eq!((org.rpm, org.tpm), (Some(30), Some(10_000)));
    assert_eq!(org.budget_micro_usd, Some(5_000));
    assert_eq!(limits.org.as_ref().and_then(|org| org.rpm), Some(500));

    // An empty ceiling changes nothing.
    assert!(OrgLimits::default()
        .with_rate_ceiling(RateCeiling::default())
        .is_empty());
}

#[test]
fn rate_share_divides_by_active_gateways_with_a_floor_of_one() {
    assert_eq!(rate_share(60, None), 60, "older plane: full ceiling");
    assert_eq!(rate_share(60, Some(0)), 60);
    assert_eq!(rate_share(60, Some(1)), 60);
    assert_eq!(rate_share(60, Some(3)), 20);
    assert_eq!(rate_share(61, Some(4)), 15, "floored");
    assert_eq!(rate_share(2, Some(5)), 1, "never below one");
}

#[test]
fn a_fleet_of_rate_limited_gateways_admits_at_most_the_configured_limit() {
    const GATEWAYS: u64 = 3;
    let mut org = spec(1_000_000, LimitAction::Stop);
    org.rpm = Some(60);
    org.tpm = Some(9_000);
    let mut member = spec(1_000_000, LimitAction::Stop);
    member.rpm = Some(10);
    let limits = OrgLimits {
        org: Some(org),
        member_default: Some(member),
        ..OrgLimits::default()
    };
    // Each gateway has its own in-process buckets.
    let fleet: Vec<_> = (0..GATEWAYS)
        .map(|_| crate::rate_limit::ScopedRateLimiter::default())
        .collect();
    let mut ctx = context(limits.clone(), &[]);
    ctx.active_gateways = Some(GATEWAYS);

    let mut org_admitted = 0;
    for (index, rate) in fleet.iter().enumerate() {
        for request in 0..100 {
            let user = format!("u{index}-{request}");
            if admit_request(rate, &ctx, Some(&user)) {
                org_admitted += 1;
            }
        }
    }
    assert_eq!(org_admitted, 60, "60 rpm across the fleet, not per gateway");

    // A member spread over every gateway: 10 rpm shares to 3 per gateway.
    let fresh: Vec<_> = (0..GATEWAYS)
        .map(|_| crate::rate_limit::ScopedRateLimiter::default())
        .collect();
    let mut member_admitted = 0;
    for rate in &fresh {
        for _ in 0..100 {
            if admit_request(rate, &ctx, Some("same-member")) {
                member_admitted += 1;
            }
        }
    }
    assert_eq!(member_admitted, 9, "at most the member's 10 rpm fleet-wide");

    let mut tokens_admitted = 0;
    for rate in &fleet {
        while admit_tokens(rate, &ctx, None, 1_000) {
            tokens_admitted += 1_000;
        }
    }
    assert_eq!(tokens_admitted, 9_000, "9_000 tpm across the fleet");

    // Without a count (older control plane) each gateway keeps the full
    // ceiling, as before.
    let legacy = context(limits, &[]);
    let rate = crate::rate_limit::ScopedRateLimiter::default();
    let admitted = (0..100)
        .filter(|request| admit_request(&rate, &legacy, Some(&format!("v{request}"))))
        .count();
    assert_eq!(admitted, 60);
}
