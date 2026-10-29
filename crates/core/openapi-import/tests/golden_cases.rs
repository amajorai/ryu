//! Golden cases for the OpenAPI parse rules, shared with the TypeScript port the
//! generated tool catalog tier uses (`tools/tool-catalog-generate/openapi-rules.ts`,
//! Treg parity C1). Both read `fixtures/openapi-import-cases-v1.json`; a rule
//! changed on one side fails the other side's test until the cases agree.
//!
//! Tools are compared in a canonical order (url, method, slug) because the order
//! of a spec's `paths` map depends on serde_json's `preserve_order` feature; what
//! the cap keeps is pinned by the cases where order cannot matter.

use ryu_openapi_import::{parse_spec, spec_to_api_with_base, ImportedApi};
use serde_json::{json, Value};

const CASES: &str = include_str!("../fixtures/openapi-import-cases-v1.json");

fn canonical(api: &ImportedApi) -> Value {
    let mut tools: Vec<Value> = api
        .tools
        .iter()
        .map(|tool| {
            json!({
                "slug": tool.slug,
                "name": tool.name,
                "description": tool.description,
                "method": tool.method,
                "url": tool.url,
                "headerParams": tool.header_params,
                "secretHeaders": tool.secret_headers,
                "inputSchema": tool.input_schema,
            })
        })
        .collect();
    tools.sort_by_key(|tool| {
        (
            tool["url"].as_str().unwrap_or_default().to_owned(),
            tool["method"].as_str().unwrap_or_default().to_owned(),
            tool["slug"].as_str().unwrap_or_default().to_owned(),
        )
    });
    json!({
        "title": api.title,
        "domain": api.domain,
        "baseUrl": api.base_url,
        "totalOperations": api.total_operations,
        "dropped": api.dropped,
        "tools": tools,
    })
}

fn run(case: &Value) -> Result<Value, String> {
    let spec = match (
        case.get("spec"),
        case.get("specText").and_then(Value::as_str),
    ) {
        (Some(spec), None) => spec.clone(),
        (None, Some(text)) => parse_spec(text.as_bytes())?,
        _ => panic!("case needs exactly one of spec or specText"),
    };
    let cap = usize::try_from(case["cap"].as_u64().expect("cap")).expect("cap fits");
    let base = case.get("baseUrl").and_then(Value::as_str);
    spec_to_api_with_base(&spec, cap, base).map(|api| canonical(&api))
}

#[test]
fn golden_cases_match() {
    let file: Value = serde_json::from_str(CASES).expect("case file decodes");
    assert_eq!(file["version"], 1);
    let cases = file["cases"].as_array().expect("cases");
    assert!(cases.len() >= 20, "the case file lost cases");
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let outcome = run(case);
        match (case.get("expected"), case.get("error")) {
            (Some(expected), None) => {
                assert_eq!(
                    outcome.as_ref().ok(),
                    Some(expected),
                    "case {name}: {outcome:?}"
                );
            }
            (None, Some(error)) => {
                assert_eq!(outcome.err().as_deref(), error.as_str(), "case {name}");
            }
            _ => panic!("case {name} needs exactly one of expected or error"),
        }
    }
}

#[test]
fn unparseable_text_is_an_error() {
    assert!(parse_spec(b"{ not: [json").is_err());
}
