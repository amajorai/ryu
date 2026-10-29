//! Upstream abuse signals in provider error bodies (managed guardrails spec
//! 03.5.1).
//!
//! A provider can refuse a request for a safety reason: it blocked the end
//! user the request was sent for, it refused the content, or it warned or
//! suspended the account the request spent. Those refusals are not provider
//! faults and must never be retried on another vendor (decision D16), so they
//! are told apart from ordinary rejections here, once, from the error body.
//!
//! Classification is a static table keyed by `(provider, status, error.code or
//! error.type)` and a few structural markers, never by message text, which a
//! vendor rewords freely and which can echo the request. Every row names the
//! fixture under `tests/fixtures/safety/` that backs it and the public source
//! the fixture follows. An error that matches no row keeps today's
//! classification.
//!
//! This module only states what a body says. Whether the signal counts is the
//! gateway's decision: only an attempt that spent a Ryu-held credential may
//! raise one, so a tenant's own key or endpoint can never inject a safety
//! signal against another subject.

use serde_json::Value;

/// What an upstream safety refusal is about (spec 03.5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyScope {
    /// The provider blocked the end user the request was sent for.
    Identifier,
    /// The provider refused this request's content.
    Content,
    /// The provider warned or suspended the account the request spent.
    Account,
}

impl SafetyScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Identifier => "identifier",
            Self::Content => "content",
            Self::Account => "account",
        }
    }
}

/// The part of an error body a row is keyed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalKey {
    /// `error.code`, as a string or a number.
    Code(&'static str),
    /// `error.type`.
    Type(&'static str),
    /// `error.metadata.provider_code`: the code of the vendor an aggregator
    /// forwarded the request to.
    ProviderCode(&'static str),
    /// An `error.metadata` object carrying a `reasons` array, the shape an
    /// aggregator's own moderation refusal takes.
    ModerationMetadata,
}

/// One classification row.
#[derive(Debug, Clone, Copy)]
pub struct SignalRow {
    /// Stable row id, also the violation event's detector id.
    pub id: &'static str,
    /// Provider registry ids the row applies to.
    pub providers: &'static [&'static str],
    pub status: u16,
    pub key: SignalKey,
    pub scope: SafetyScope,
    /// The fixture file under `tests/fixtures/safety/` that backs the row.
    pub fixture: &'static str,
}

/// The shipped rows. A row ships only with a fixture; a vendor that marks a
/// safety refusal only in its message text gets no row.
///
/// Not covered yet, for want of a documented code: OpenAI's identifier block
/// and organization warning (its safety-checks guide names the error but not
/// its code), and any Anthropic error (its envelope has no `code`, and the
/// only 403 type, `permission_error`, also means a key without access to a
/// model). Anthropic content refusals arrive as `stop_reason: "refusal"` on a
/// successful response instead, see [`is_soft_refusal`].
pub const SIGNAL_ROWS: &[SignalRow] = &[
    SignalRow {
        id: "openai.invalid_prompt",
        providers: OPENAI_IDS,
        status: 400,
        key: SignalKey::Code("invalid_prompt"),
        scope: SafetyScope::Content,
        fixture: "openai_invalid_prompt.json",
    },
    SignalRow {
        id: "openai.content_policy_violation",
        providers: OPENAI_IDS,
        status: 400,
        key: SignalKey::Code("content_policy_violation"),
        scope: SafetyScope::Content,
        fixture: "openai_content_policy_violation.json",
    },
    SignalRow {
        id: "openrouter.moderation",
        providers: OPENROUTER_IDS,
        status: 403,
        key: SignalKey::ModerationMetadata,
        scope: SafetyScope::Content,
        fixture: "openrouter_moderation.json",
    },
    SignalRow {
        id: "openrouter.provider_invalid_prompt",
        providers: OPENROUTER_IDS,
        status: 400,
        key: SignalKey::ProviderCode("invalid_prompt"),
        scope: SafetyScope::Content,
        fixture: "openrouter_provider_invalid_prompt.json",
    },
];

const OPENAI_IDS: &[&str] = &["openai", "openai-credits"];
const OPENROUTER_IDS: &[&str] = &["openrouter"];

/// A matched row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafetySignal {
    /// The row id ([`SignalRow::id`]).
    pub row: &'static str,
    pub scope: SafetyScope,
    /// The vendor's own code or type the row matched, when it had one.
    pub code: Option<String>,
}

/// The fields of an error body the table reads. Parsed once per error.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedError {
    pub code: Option<String>,
    pub kind: Option<String>,
    pub provider_code: Option<String>,
    pub moderation: bool,
}

impl ParsedError {
    /// Read `error.code` (string or number), `error.type`,
    /// `error.metadata.provider_code` and whether `error.metadata.reasons`
    /// is an array. A body that is not JSON yields an empty parse.
    pub fn from_body(body: &str) -> Self {
        let Ok(json) = serde_json::from_str::<Value>(body) else {
            return Self::default();
        };
        let error = &json["error"];
        let text = |value: &Value| match value {
            Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        };
        let metadata = &error["metadata"];
        Self {
            code: text(&error["code"]),
            kind: text(&error["type"]),
            provider_code: text(&metadata["provider_code"]),
            moderation: metadata["reasons"].is_array(),
        }
    }

    fn matched(&self, key: SignalKey) -> Option<Option<String>> {
        match key {
            SignalKey::Code(code) => {
                (self.code.as_deref() == Some(code)).then(|| Some(code.into()))
            }
            SignalKey::Type(kind) => {
                (self.kind.as_deref() == Some(kind)).then(|| Some(kind.into()))
            }
            SignalKey::ProviderCode(code) => {
                (self.provider_code.as_deref() == Some(code)).then(|| Some(code.into()))
            }
            SignalKey::ModerationMetadata => self.moderation.then(|| self.code.clone()),
        }
    }
}

/// Classify an error body against `rows`.
pub fn classify_with(
    rows: &[SignalRow],
    provider: &str,
    status: u16,
    body: &str,
) -> Option<SafetySignal> {
    let relevant = rows
        .iter()
        .filter(|row| row.status == status && row.providers.contains(&provider));
    let mut relevant = relevant.peekable();
    relevant.peek()?;
    let parsed = ParsedError::from_body(body);
    relevant.find_map(|row| {
        parsed.matched(row.key).map(|code| SafetySignal {
            row: row.id,
            scope: row.scope,
            code,
        })
    })
}

/// Classify an error body against the shipped rows.
pub fn classify(provider: &str, status: u16, body: &str) -> Option<SafetySignal> {
    classify_with(SIGNAL_ROWS, provider, status, body)
}

/// Whether a successful OpenAI-shaped completion was refused by the model's
/// own safety system: a choice that ended with `finish_reason:
/// "content_filter"`. The Anthropic adapter maps `stop_reason: "refusal"` to
/// that finish reason, so one check covers Anthropic, OpenAI and OpenRouter.
pub fn is_soft_refusal(response: &Value) -> bool {
    response["choices"].as_array().is_some_and(|choices| {
        choices
            .iter()
            .any(|choice| choice["finish_reason"].as_str() == Some("content_filter"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every fixture, by file name. A fixture records the provider, status,
    /// the public source its shape follows, and the body; message text is a
    /// neutral placeholder, never a real refused prompt.
    const FIXTURES: &[(&str, &str)] = &[
        (
            "openai_invalid_prompt.json",
            include_str!("../tests/fixtures/safety/openai_invalid_prompt.json"),
        ),
        (
            "openai_content_policy_violation.json",
            include_str!("../tests/fixtures/safety/openai_content_policy_violation.json"),
        ),
        (
            "openrouter_moderation.json",
            include_str!("../tests/fixtures/safety/openrouter_moderation.json"),
        ),
        (
            "openrouter_provider_invalid_prompt.json",
            include_str!("../tests/fixtures/safety/openrouter_provider_invalid_prompt.json"),
        ),
        (
            "openrouter_forbidden_key.json",
            include_str!("../tests/fixtures/safety/openrouter_forbidden_key.json"),
        ),
        (
            "anthropic_permission_error.json",
            include_str!("../tests/fixtures/safety/anthropic_permission_error.json"),
        ),
    ];

    struct Fixture {
        provider: String,
        status: u16,
        body: String,
        expect_row: Option<String>,
    }

    fn fixture(name: &str) -> Fixture {
        let raw = FIXTURES
            .iter()
            .find(|(file, _)| *file == name)
            .unwrap_or_else(|| panic!("no fixture named {name}"))
            .1;
        let json: Value = serde_json::from_str(raw).expect("fixture is JSON");
        assert!(
            json["source"]
                .as_str()
                .is_some_and(|s| s.starts_with("https://")),
            "{name} names its public source"
        );
        assert!(
            json["provenance"].as_str().is_some(),
            "{name} states its provenance"
        );
        Fixture {
            provider: json["provider"].as_str().expect("provider").to_owned(),
            status: u16::try_from(json["status"].as_u64().expect("status")).expect("u16"),
            body: json["body"].to_string(),
            expect_row: json["expectRow"].as_str().map(str::to_owned),
        }
    }

    #[test]
    fn every_row_ships_with_a_fixture_that_it_matches() {
        for row in SIGNAL_ROWS {
            let fixture = fixture(row.fixture);
            assert_eq!(fixture.expect_row.as_deref(), Some(row.id), "{}", row.id);
            assert!(
                row.providers.contains(&fixture.provider.as_str()),
                "{}",
                row.id
            );
            let signal = classify(&fixture.provider, fixture.status, &fixture.body)
                .unwrap_or_else(|| panic!("{} matches its own fixture", row.id));
            assert_eq!(signal.row, row.id);
            assert_eq!(signal.scope, row.scope);
        }
    }

    #[test]
    fn every_fixture_classifies_as_it_says() {
        for (name, _) in FIXTURES {
            let fixture = fixture(name);
            let signal = classify(&fixture.provider, fixture.status, &fixture.body);
            assert_eq!(
                signal.map(|signal| signal.row.to_owned()),
                fixture.expect_row,
                "{name}"
            );
        }
    }

    #[test]
    fn row_ids_are_unique_and_plain() {
        let mut seen = std::collections::HashSet::new();
        for row in SIGNAL_ROWS {
            assert!(seen.insert(row.id), "duplicate row {}", row.id);
            assert!(row
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b == b'.' || b == b'_'));
        }
    }

    #[test]
    fn a_row_applies_only_to_its_own_provider_and_status() {
        let body = fixture("openai_invalid_prompt.json").body;
        assert!(classify("openai", 400, &body).is_some());
        assert!(classify("openai-credits", 400, &body).is_some());
        // An OpenAI-compatible endpoint under another id is not OpenAI.
        assert_eq!(classify("fireworks", 400, &body), None);
        assert_eq!(classify("openai", 403, &body), None);
    }

    #[test]
    fn message_text_never_decides() {
        // The message names a refusal, but no keyed field does.
        let body = r#"{"error":{"message":"RYU_TEST_FIXTURE flagged usage policy identifier blocked","type":"invalid_request_error"}}"#;
        assert_eq!(classify("openai", 400, body), None);
        assert_eq!(classify("openrouter", 403, body), None);
    }

    #[test]
    fn non_json_and_empty_bodies_never_match() {
        for body in [
            "",
            "forbidden",
            "<html>403</html>",
            "{}",
            r#"{"error":null}"#,
        ] {
            for row in SIGNAL_ROWS {
                assert_eq!(classify(row.providers[0], row.status, body), None, "{body}");
            }
        }
    }

    #[test]
    fn numeric_codes_parse_as_text() {
        let parsed = ParsedError::from_body(r#"{"error":{"code":403,"metadata":{"reasons":[]}}}"#);
        assert_eq!(parsed.code.as_deref(), Some("403"));
        assert!(parsed.moderation);
    }

    #[test]
    fn a_test_table_can_carry_every_scope() {
        const TEST_ROWS: &[SignalRow] = &[
            SignalRow {
                id: "test.identifier",
                providers: &["openai"],
                status: 403,
                key: SignalKey::Code("ryu_test_identifier_blocked"),
                scope: SafetyScope::Identifier,
                fixture: "",
            },
            SignalRow {
                id: "test.account",
                providers: &["openai"],
                status: 403,
                key: SignalKey::Type("ryu_test_account_warning"),
                scope: SafetyScope::Account,
                fixture: "",
            },
        ];
        let identifier = classify_with(
            TEST_ROWS,
            "openai",
            403,
            r#"{"error":{"code":"ryu_test_identifier_blocked"}}"#,
        )
        .expect("identifier row");
        assert_eq!(identifier.scope, SafetyScope::Identifier);
        assert_eq!(
            identifier.code.as_deref(),
            Some("ryu_test_identifier_blocked")
        );
        let account = classify_with(
            TEST_ROWS,
            "openai",
            403,
            r#"{"error":{"type":"ryu_test_account_warning"}}"#,
        )
        .expect("account row");
        assert_eq!(account.scope, SafetyScope::Account);
    }

    #[test]
    fn soft_refusal_reads_any_choice() {
        let refused = serde_json::json!({ "choices": [
            { "finish_reason": "stop" },
            { "finish_reason": "content_filter" }
        ]});
        assert!(is_soft_refusal(&refused));
        assert!(!is_soft_refusal(
            &serde_json::json!({ "choices": [{ "finish_reason": "stop" }] })
        ));
        assert!(!is_soft_refusal(&serde_json::json!({})));
    }
}
