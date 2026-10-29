//! Shared cases for the tool credential ladder (Treg parity B5). The same file
//! is asserted by the TypeScript twin (`packages/protocol/src/tool-credential-ladder.test.ts`),
//! so both the decoded outcome and the exact JSON wire shape are checked.

use ryu_gw_contracts::tool_credential_ladder::{
    resolve_tool_ladder, LadderInput, LadderResolution, LADDER_CONTRACT_VERSION,
};
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/tool-credential-ladder-cases-v1.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    version: u32,
    #[allow(dead_code)]
    description: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    input: LadderInput,
    expected: Value,
}

#[test]
fn every_shared_case_resolves_to_its_expected_rung_and_trace() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture decodes");
    assert_eq!(fixture.version, LADDER_CONTRACT_VERSION);
    assert!(fixture.cases.len() >= 15);
    let mut names = std::collections::BTreeSet::new();
    for case in &fixture.cases {
        assert!(names.insert(case.name.as_str()), "duplicate {}", case.name);
        let expected: LadderResolution = serde_json::from_value(case.expected.clone())
            .unwrap_or_else(|error| panic!("{}: expected does not decode: {error}", case.name));
        let actual = resolve_tool_ladder(&case.input);
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
fn a_tenant_rung_is_never_metered_in_any_case() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture decodes");
    for case in &fixture.cases {
        let resolution = resolve_tool_ladder(&case.input);
        if let ryu_gw_contracts::tool_credential_ladder::LadderOutcome::Selected {
            rung,
            metered,
            ..
        } = resolution.outcome
        {
            let tenant = matches!(
                rung,
                ryu_gw_contracts::tool_credential_ladder::Rung::Team
                    | ryu_gw_contracts::tool_credential_ladder::Rung::Org
            );
            assert_eq!(metered, !tenant, "{}", case.name);
        }
    }
}
