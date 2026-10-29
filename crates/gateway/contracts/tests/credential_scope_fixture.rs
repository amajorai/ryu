//! Golden cases for the scoped-credential contract. The same fixture is the
//! source of truth for the TypeScript twin, so both the decoded outcome and
//! the exact JSON wire shape of every resolution are asserted.

use ryu_gw_contracts::credential_scope::{
    resolve_credential, CredentialCandidate, CredentialScope, CredentialSlot, GateDecision,
    Resolution, SourcePolicy, CONTRACT_VERSION,
};
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/credential-scope-v1.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    version: u32,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    slot: CredentialSlot,
    scope: CredentialScope,
    candidates: Vec<CredentialCandidate>,
    gate: GateDecision,
    policy: SourcePolicy,
    expected: Value,
}

#[test]
fn every_golden_case_resolves_to_its_expected_outcome_and_trace() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture decodes");
    assert_eq!(fixture.version, CONTRACT_VERSION);
    assert!(!fixture.cases.is_empty());
    let mut names = std::collections::BTreeSet::new();
    for case in &fixture.cases {
        assert!(
            names.insert(case.name.as_str()),
            "duplicate case {}",
            case.name
        );
        let expected: Resolution = serde_json::from_value(case.expected.clone())
            .unwrap_or_else(|error| panic!("{}: expected does not decode: {error}", case.name));
        let actual = resolve_credential(
            &case.slot,
            &case.scope,
            &case.candidates,
            &case.gate,
            &case.policy,
        );
        assert_eq!(actual, expected, "{}", case.name);
        assert_eq!(
            serde_json::to_value(&actual).unwrap(),
            case.expected,
            "{}: wire shape",
            case.name
        );
    }
}

#[test]
fn golden_fixture_covers_the_planned_cases() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture decodes");
    // (a)-(n) are the planned cases; q_ pins that a lower layer's `user`
    // entry needs the org-only opt-in, and r_ that each shared level accepts
    // only its own evidence kind.
    for prefix in [
        "a_", "b_", "c_", "d_", "e_", "f_", "g_", "h_", "i_", "j_", "k_", "k2_", "l_", "l2_", "m_",
        "n_", "n2_", "q_", "q2_", "q3_", "q4_", "q5_", "r_", "r2_", "r3_", "r4_", "r5_", "r6_",
    ] {
        assert!(
            fixture
                .cases
                .iter()
                .any(|case| case.name.starts_with(prefix)),
            "missing case {prefix}"
        );
    }
}
