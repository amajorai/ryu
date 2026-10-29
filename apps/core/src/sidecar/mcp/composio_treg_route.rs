//! Treg routing for agents' Composio actions (flagged: `RYU_TREG_AGENT_TOOLS`).
//!
//! Some Composio actions read public data that a Treg endpoint also serves.
//! Nothing here compares the two prices, and no ceiling is enforced: the call is
//! debited at Treg's price, which may be higher or lower than Composio's.
//! `composio_treg_equivalents.json` is the
//! reviewed list of such pairs: a Composio action slug, the Treg endpoint that
//! does the same job, and how each argument is renamed. When an agent invokes a
//! listed action, the flag is on, the call is not bound to a connected account
//! and the brand is not pinned to Composio, Core runs the Treg endpoint through
//! Gateway instead (`POST /v1/providers/call`, provider `treg`,
//! `requireServable`), where it is priced and debited from the org wallet.
//!
//! Anything the table cannot express exactly stays on Composio: an unlisted
//! slug, an argument the entry does not map, a value outside its declared type
//! or bounds, or a Treg endpoint Gateway says it cannot serve on the fleet
//! token. Only public-data toolkits that need no user connection may appear in
//! the table; account actions, connection management and triggers never reach
//! this module.
//!
//! Clean-room rule (`docs/treg-parity.md`): the table holds Ryu's own review of
//! public facts only, never Treg's descriptions, prices, schemas or examples.
//! Argument names on the Treg side are the upstream vendor's documented names,
//! cited per entry.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::provider_pins::{ProviderPin, ProviderPins};

/// Marks a dispatch result that Treg answered, so the Composio charge path
/// records nothing (Gateway already debited the Treg call).
pub const ROUTED_PROVIDER_KEY: &str = "__ryu_routed_provider";

/// Composio toolkits whose actions need no user connection and read only
/// public data. A table entry outside this list is never used.
pub(crate) const PUBLIC_DATA_TOOLKITS: &[&str] = &["composio_search"];

const TABLE_JSON: &str = include_str!("composio_treg_equivalents.json");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Table {
    version: u32,
    entries: Vec<Equivalent>,
}

/// One reviewed Composio action → Treg endpoint pair.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Equivalent {
    pub composio_slug: String,
    pub composio_toolkit: String,
    /// The Integrations Store brand the user pins.
    pub brand: String,
    pub treg_endpoint_id: String,
    pub method: HttpMethod,
    pub args: Vec<ArgMap>,
    /// Constant parameters the vendor's API requires for this job, from its
    /// documentation. The model cannot set or override them.
    #[serde(default)]
    pub fixed: Vec<FixedArg>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub provenance: Provenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) enum HttpMethod {
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "POST")]
    Post,
}

impl HttpMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ArgLocation {
    Query,
    Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArgType {
    String,
    Integer,
    Boolean,
    StringEnum,
}

/// How one Composio argument becomes one Treg argument: renamed only, with
/// its value checked against the declared type and bounds.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ArgMap {
    pub composio: String,
    pub treg: String,
    #[serde(rename = "in")]
    pub location: ArgLocation,
    #[serde(rename = "type")]
    pub kind: ArgType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub max_bytes: Option<usize>,
    #[serde(default)]
    pub min: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
    #[serde(default)]
    pub values: Vec<String>,
    /// A pattern the value must match in full (a vendor id format, say).
    #[serde(default)]
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct FixedArg {
    #[serde(rename = "in")]
    pub location: ArgLocation,
    pub name: String,
    pub value: String,
}

/// Where an entry was checked. Read by the drift test only; kept in the type
/// so the table still parses strictly.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct Provenance {
    pub composio_docs: String,
    pub vendor_docs: String,
    pub verified_on: String,
}

fn parse_table(raw: &str) -> Result<BTreeMap<String, Equivalent>, String> {
    let table: Table = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if table.version != 1 {
        return Err(format!("unsupported table version {}", table.version));
    }
    let mut entries = BTreeMap::new();
    for entry in table.entries {
        if let Some(previous) = entries.insert(entry.composio_slug.clone(), entry) {
            return Err(format!("duplicate slug {}", previous.composio_slug));
        }
    }
    Ok(entries)
}

static TABLE: LazyLock<BTreeMap<String, Equivalent>> =
    LazyLock::new(|| match parse_table(TABLE_JSON) {
        Ok(table) => table,
        Err(error) => {
            // The drift test keeps this from shipping; at runtime an
            // unreadable table only means nothing is rerouted.
            tracing::error!("composio→treg equivalents table is invalid: {error}");
            BTreeMap::new()
        }
    });

/// The reviewed Treg equivalent of a Composio action slug (exact match).
pub(crate) fn lookup(slug: &str) -> Option<&'static Equivalent> {
    TABLE.get(slug)
}

/// The Treg call an entry produces from an agent's arguments.
#[derive(Debug, PartialEq)]
pub(crate) struct MappedArgs {
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
}

/// Why arguments could not be mapped. Names the argument, never its value.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MapRefusal {
    NotObject,
    Unmapped(String),
    Missing(String),
    WrongType(String),
    OutOfRange(String),
    NoMatch(String),
}

fn string_arg(arg: &ArgMap, value: &Value) -> Result<String, MapRefusal> {
    let text = value
        .as_str()
        .ok_or_else(|| MapRefusal::WrongType(arg.composio.clone()))?;
    if text.trim().is_empty() || arg.max_bytes.is_some_and(|max| text.len() > max) {
        return Err(MapRefusal::OutOfRange(arg.composio.clone()));
    }
    if let Some(pattern) = &arg.pattern {
        let matches = regex::Regex::new(&format!("^(?:{pattern})$"))
            .map(|regex| regex.is_match(text))
            .unwrap_or(false);
        if !matches {
            return Err(MapRefusal::NoMatch(arg.composio.clone()));
        }
    }
    if arg.kind == ArgType::StringEnum && !arg.values.iter().any(|allowed| allowed == text) {
        return Err(MapRefusal::NoMatch(arg.composio.clone()));
    }
    Ok(text.to_owned())
}

fn checked_value(arg: &ArgMap, value: &Value) -> Result<Value, MapRefusal> {
    match arg.kind {
        ArgType::String | ArgType::StringEnum => string_arg(arg, value).map(Value::String),
        ArgType::Integer => {
            let number = value
                .as_i64()
                .ok_or_else(|| MapRefusal::WrongType(arg.composio.clone()))?;
            if arg.min.is_some_and(|min| number < min) || arg.max.is_some_and(|max| number > max) {
                return Err(MapRefusal::OutOfRange(arg.composio.clone()));
            }
            Ok(Value::from(number))
        }
        ArgType::Boolean => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| MapRefusal::WrongType(arg.composio.clone())),
    }
}

fn query_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Map an agent's Composio arguments onto the entry's Treg call. Closed world:
/// every argument the agent sent must be one the entry maps, or nothing is
/// rerouted. A `null` argument counts as absent.
pub(crate) fn map_arguments(
    entry: &Equivalent,
    arguments: &Value,
) -> Result<MappedArgs, MapRefusal> {
    let empty = Map::new();
    let object = match arguments {
        Value::Object(object) => object,
        Value::Null => &empty,
        _ => return Err(MapRefusal::NotObject),
    };
    for (key, value) in object {
        if !value.is_null() && !entry.args.iter().any(|arg| &arg.composio == key) {
            return Err(MapRefusal::Unmapped(key.clone()));
        }
    }
    let mut query = Vec::new();
    let mut body = Map::new();
    for arg in &entry.args {
        let Some(value) = object.get(&arg.composio).filter(|value| !value.is_null()) else {
            if arg.required {
                return Err(MapRefusal::Missing(arg.composio.clone()));
            }
            continue;
        };
        let value = checked_value(arg, value)?;
        match arg.location {
            ArgLocation::Query => query.push((arg.treg.clone(), query_text(&value))),
            ArgLocation::Body => {
                body.insert(arg.treg.clone(), value);
            }
        }
    }
    for fixed in &entry.fixed {
        match fixed.location {
            ArgLocation::Query => query.push((fixed.name.clone(), fixed.value.clone())),
            ArgLocation::Body => {
                body.insert(fixed.name.clone(), Value::String(fixed.value.clone()));
            }
        }
    }
    let body = (entry.method != HttpMethod::Get && !body.is_empty()).then_some(Value::Object(body));
    Ok(MappedArgs { query, body })
}

/// Why a call stays on Composio.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Skip {
    FlagOff,
    AccountScoped,
    NotMapped,
    ToolkitNotPublic,
    PinsUnreadable,
    PinnedComposio,
    Args(MapRefusal),
    /// Gateway refused before running anything (not servable on the fleet
    /// token, pinned, unpriced, or not hosted).
    Refused,
    /// Treg ran the call and it failed upstream (`ok` was not true), and
    /// nothing was charged for it, so Composio can still answer.
    UpstreamFailed,
}

/// Decide, without any I/O, whether a Composio action goes to Treg.
pub(crate) fn plan(
    flag_on: bool,
    slug: &str,
    arguments: &Value,
    account_scoped: bool,
    pins: &anyhow::Result<ProviderPins>,
) -> Result<(&'static Equivalent, MappedArgs, Option<ProviderPin>), Skip> {
    plan_with(flag_on, lookup(slug), arguments, account_scoped, pins)
}

fn plan_with(
    flag_on: bool,
    entry: Option<&'static Equivalent>,
    arguments: &Value,
    account_scoped: bool,
    pins: &anyhow::Result<ProviderPins>,
) -> Result<(&'static Equivalent, MappedArgs, Option<ProviderPin>), Skip> {
    if !flag_on {
        return Err(Skip::FlagOff);
    }
    if account_scoped {
        return Err(Skip::AccountScoped);
    }
    let entry = entry.ok_or(Skip::NotMapped)?;
    if !PUBLIC_DATA_TOOLKITS.contains(&entry.composio_toolkit.as_str()) {
        return Err(Skip::ToolkitNotPublic);
    }
    let pins = pins.as_ref().map_err(|_| Skip::PinsUnreadable)?;
    // The Treg platform's store brand, and the Composio toolkit's own brand:
    // a Composio pin on either keeps the action on Composio.
    let toolkit_brands = crate::provider_pins::composio_brand_candidates(&entry.composio_slug);
    let pin = pins.strongest(
        std::iter::once(entry.brand.as_str()).chain(toolkit_brands.iter().map(String::as_str)),
    );
    if pin == Some(ProviderPin::Composio) {
        return Err(Skip::PinnedComposio);
    }
    let mapped = map_arguments(entry, arguments).map_err(Skip::Args)?;
    Ok((entry, mapped, pin))
}

/// Gateway refusals that happen before anything runs or is charged, so the
/// call can safely go to Composio instead. Anything else (a credit refusal,
/// an upstream failure, an uncertain delivery) is the call's answer.
pub(crate) fn falls_back(error: &ryu_app_events::ProviderRouterError) -> bool {
    match error {
        ryu_app_events::ProviderRouterError::NotHosted => true,
        ryu_app_events::ProviderRouterError::Rejected { status, body } => {
            let code = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|body| {
                    body.pointer("/error/code")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            // A 401 is Gateway refusing the forwarded identity before anything
            // ran (a hosted Gateway reads an agent id only with a route proof,
            // which this call does not carry), so Composio can still answer.
            *status == 401
                || matches!(
                    (*status, code.as_str()),
                    // `tool_not_servable` is a 403 from this Gateway; a 409 is what an
                    // earlier Gateway sent for the same refusal.
                    (403 | 409, "tool_not_servable") | (403, "policy_violation" | "tool_unpriced")
                )
        }
        _ => false,
    }
}

/// Run a Composio action on its Treg equivalent when [`plan`] allows it.
///
/// `Ok(envelope)`: Treg answered; the envelope carries [`ROUTED_PROVIDER_KEY`]
/// and Gateway's response under `output`. `Err(Ok(skip))`: run it on Composio.
/// `Err(Err(error))`: Treg was tried and this is the call's answer; it is not
/// retried on Composio, so a call never runs (or is paid for) twice.
/// Who an agent tool call runs for, passed on so Gateway attributes the
/// Treg debit to the same agent, user and session a Composio charge would be.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CallIdentity<'a> {
    pub agent_id: Option<&'a str>,
    pub user_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

/// Gateway's answer to a Treg call that ran. A call the upstream vendor failed
/// (`ok` is not true) is not a result: when nothing was charged for it (a null
/// or zero `chargedMicroUsd`) Composio still answers, and when it was charged
/// the failure is the call's answer and is never retried, so it is not paid
/// for twice.
fn served_envelope(slug: &str, response: Value) -> Result<Value, Result<Skip, anyhow::Error>> {
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(serde_json::json!({ ROUTED_PROVIDER_KEY: "treg", "output": response }));
    }
    let charged = response
        .get("chargedMicroUsd")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if charged == 0 {
        tracing::debug!(
            slug,
            "treg equivalent failed upstream, uncharged; using composio"
        );
        return Err(Ok(Skip::UpstreamFailed));
    }
    let status = response
        .get("status")
        .and_then(Value::as_u64)
        .map_or_else(|| "unknown".to_owned(), |status| status.to_string());
    Err(Err(anyhow::anyhow!(
        "{slug} via Treg failed upstream (status {status}); it was charged and is not retried"
    )))
}

pub(crate) async fn try_route(
    http: &reqwest::Client,
    slug: &str,
    arguments: &Value,
    account_scoped: bool,
    identity: CallIdentity<'_>,
) -> Result<Value, Result<Skip, anyhow::Error>> {
    let flag_on = super::treg_tool::enabled();
    // Cheap exits first: no preferences read for the common case.
    if !flag_on {
        return Err(Ok(Skip::FlagOff));
    }
    if account_scoped {
        return Err(Ok(Skip::AccountScoped));
    }
    if lookup(slug).is_none() {
        return Err(Ok(Skip::NotMapped));
    }
    let pins = ProviderPins::load_default().await;
    let (entry, mapped, pin) = plan(flag_on, slug, arguments, account_scoped, &pins).map_err(Ok)?;
    let org_id = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let facts = crate::sidecar::gateway::CoreCallFacts {
        org_id: org_id.as_deref(),
        caller_id: super::treg_tool::CALLER_ID,
        provider_pin: pin,
        require_servable: true,
        agent_id: identity.agent_id,
        user_id: identity.user_id,
        session_id: identity.session_id,
    };
    let call = ryu_app_events::ManagedProviderCall {
        // Named: an agent call either runs on Treg or comes back here, so
        // Core, not Gateway, decides the Composio fallback.
        provider: "treg".to_owned(),
        tool_id: entry.treg_endpoint_id.clone(),
        operation: None,
        account_id: None,
        method: entry.method.as_str().to_owned(),
        query: mapped.query,
        body: mapped.body,
        idempotency_key: None,
        request_id: format!(
            "core-agent-composio-equiv:{}",
            uuid::Uuid::new_v4().simple()
        ),
        fallback_cost_micro_usd: None,
        task_label: Some(format!("composio {slug} via treg")),
        timeout_ms: None,
        max_cost_micro_usd: None,
    };
    match crate::sidecar::gateway::call_managed_provider_with(http, &facts, call).await {
        Ok(response) => {
            let routed = served_envelope(slug, response)?;
            tracing::debug!(slug, endpoint = %entry.treg_endpoint_id, "composio action served by its treg equivalent");
            Ok(routed)
        }
        Err(error) if falls_back(&error) => {
            tracing::debug!(
                slug,
                "treg equivalent refused before running; using composio: {error}"
            );
            Err(Ok(Skip::Refused))
        }
        Err(error) => Err(Err(anyhow::anyhow!("{slug} via Treg failed: {error}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A fixture entry with placeholder ids, exercising every argument kind.
    fn fixture() -> &'static Equivalent {
        static ENTRY: LazyLock<Equivalent> = LazyLock::new(|| {
            serde_json::from_value(json!({
                "composioSlug": "COMPOSIO_SEARCH_EXAMPLE",
                "composioToolkit": "composio_search",
                "brand": "example",
                "tregEndpointId": "vendor.example.search",
                "method": "GET",
                "args": [
                    { "composio": "query", "treg": "q", "in": "query", "type": "string", "required": true, "maxBytes": 64 },
                    { "composio": "count", "treg": "num", "in": "query", "type": "integer", "min": 1, "max": 20 },
                    { "composio": "safe", "treg": "safe", "in": "query", "type": "boolean" },
                    { "composio": "sort", "treg": "sort", "in": "query", "type": "stringEnum", "values": ["new", "top"] },
                    { "composio": "id", "treg": "id", "in": "query", "type": "string", "pattern": "[A-Za-z0-9_-]{4}" }
                ],
                "fixed": [{ "in": "query", "name": "engine", "value": "example" }],
                "provenance": {
                    "composioDocs": "https://docs.composio.dev/toolkits/composio_search",
                    "vendorDocs": "https://vendor.example/docs",
                    "verifiedOn": "2026-10-22"
                }
            }))
            .expect("fixture entry")
        });
        &ENTRY
    }

    fn post_fixture() -> Equivalent {
        let mut entry = fixture().clone();
        entry.method = HttpMethod::Post;
        entry.args[0].location = ArgLocation::Body;
        entry
    }

    fn no_pins() -> anyhow::Result<ProviderPins> {
        Ok(ProviderPins::default())
    }

    #[test]
    fn a_mapped_action_goes_to_treg_with_renamed_arguments() {
        let (entry, mapped, pin) = plan_with(
            true,
            Some(fixture()),
            &json!({ "query": "rust", "count": 5, "safe": true, "sort": "top" }),
            false,
            &no_pins(),
        )
        .expect("routed");
        assert_eq!(entry.treg_endpoint_id, "vendor.example.search");
        assert_eq!(pin, None);
        assert_eq!(
            mapped,
            MappedArgs {
                query: vec![
                    ("q".to_owned(), "rust".to_owned()),
                    ("num".to_owned(), "5".to_owned()),
                    ("safe".to_owned(), "true".to_owned()),
                    ("sort".to_owned(), "top".to_owned()),
                    ("engine".to_owned(), "example".to_owned()),
                ],
                body: None,
            }
        );
    }

    #[test]
    fn a_post_entry_puts_body_arguments_in_the_body() {
        let entry = post_fixture();
        let mapped = map_arguments(&entry, &json!({ "query": "rust" })).expect("mapped");
        assert_eq!(mapped.body, Some(json!({ "q": "rust" })));
        assert_eq!(
            mapped.query,
            vec![("engine".to_owned(), "example".to_owned())]
        );
    }

    #[test]
    fn unmapped_own_account_and_pinned_calls_stay_on_composio() {
        let arguments = json!({ "query": "rust" });
        assert_eq!(
            plan_with(false, Some(fixture()), &arguments, false, &no_pins()).err(),
            Some(Skip::FlagOff)
        );
        assert_eq!(
            plan_with(true, None, &arguments, false, &no_pins()).err(),
            Some(Skip::NotMapped)
        );
        assert_eq!(
            plan_with(true, Some(fixture()), &arguments, true, &no_pins()).err(),
            Some(Skip::AccountScoped)
        );
        for brand in ["example", "composiosearch"] {
            let pinned = Ok(ProviderPins::from_pairs(&[(brand, "composio")]));
            assert_eq!(
                plan_with(true, Some(fixture()), &arguments, false, &pinned).err(),
                Some(Skip::PinnedComposio),
                "{brand}"
            );
        }
        let unreadable = Err(anyhow::anyhow!("database is locked"));
        assert_eq!(
            plan_with(true, Some(fixture()), &arguments, false, &unreadable).err(),
            Some(Skip::PinsUnreadable)
        );
        // A Treg pin (or another brand's Composio pin) keeps the reroute.
        let treg = Ok(ProviderPins::from_pairs(&[
            ("example", "treg"),
            ("gmail", "composio"),
        ]));
        let (_, _, pin) =
            plan_with(true, Some(fixture()), &arguments, false, &treg).expect("routed");
        assert_eq!(pin, Some(ProviderPin::Treg));
        // Gmail and other account actions have no entry at all.
        assert!(lookup("GMAIL_SEND_EMAIL").is_none());
        assert!(lookup("GMAIL_FETCH_EMAILS").is_none());
    }

    #[test]
    fn an_entry_outside_the_public_toolkits_is_never_used() {
        let mut entry = fixture().clone();
        entry.composio_toolkit = "gmail".to_owned();
        let entry: &'static Equivalent = Box::leak(Box::new(entry));
        assert_eq!(
            plan_with(
                true,
                Some(entry),
                &json!({ "query": "x" }),
                false,
                &no_pins()
            )
            .err(),
            Some(Skip::ToolkitNotPublic)
        );
    }

    #[test]
    fn arguments_the_entry_cannot_express_keep_the_call_on_composio() {
        let entry = fixture();
        let cases = [
            (json!("rust"), MapRefusal::NotObject),
            (json!({}), MapRefusal::Missing("query".to_owned())),
            (
                json!({ "query": "rust", "connected_account_id": "ca_1" }),
                MapRefusal::Unmapped("connected_account_id".to_owned()),
            ),
            (
                json!({ "query": "rust", "user_id": "u" }),
                MapRefusal::Unmapped("user_id".to_owned()),
            ),
            (
                json!({ "query": 5 }),
                MapRefusal::WrongType("query".to_owned()),
            ),
            (
                json!({ "query": "  " }),
                MapRefusal::OutOfRange("query".to_owned()),
            ),
            (
                json!({ "query": "x".repeat(65) }),
                MapRefusal::OutOfRange("query".to_owned()),
            ),
            (
                json!({ "query": "rust", "count": 0 }),
                MapRefusal::OutOfRange("count".to_owned()),
            ),
            (
                json!({ "query": "rust", "count": 21 }),
                MapRefusal::OutOfRange("count".to_owned()),
            ),
            (
                json!({ "query": "rust", "count": "5" }),
                MapRefusal::WrongType("count".to_owned()),
            ),
            (
                json!({ "query": "rust", "count": 1.5 }),
                MapRefusal::WrongType("count".to_owned()),
            ),
            (
                json!({ "query": "rust", "safe": "yes" }),
                MapRefusal::WrongType("safe".to_owned()),
            ),
            (
                json!({ "query": "rust", "sort": "best" }),
                MapRefusal::NoMatch("sort".to_owned()),
            ),
            (
                json!({ "query": "rust", "id": "https://x" }),
                MapRefusal::NoMatch("id".to_owned()),
            ),
            // A fixed parameter cannot be set by the model.
            (
                json!({ "query": "rust", "engine": "other" }),
                MapRefusal::Unmapped("engine".to_owned()),
            ),
        ];
        for (arguments, refusal) in cases {
            assert_eq!(
                map_arguments(entry, &arguments),
                Err(refusal),
                "{arguments}"
            );
        }
        // Null means absent.
        assert!(map_arguments(entry, &json!({ "query": "rust", "count": null })).is_ok());
    }

    #[test]
    fn only_refusals_before_running_fall_back_to_composio() {
        use ryu_app_events::ProviderRouterError::{NotHosted, Rejected};
        let rejected = |status, code: &str| Rejected {
            status,
            body: json!({ "error": { "code": code } }).to_string(),
        };
        assert!(falls_back(&NotHosted));
        assert!(falls_back(&rejected(403, "tool_not_servable")));
        assert!(falls_back(&rejected(409, "tool_not_servable")));
        assert!(falls_back(&rejected(403, "policy_violation")));
        assert!(falls_back(&rejected(403, "tool_unpriced")));
        // Gateway refusing the forwarded agent identity (no route proof on a
        // hosted Gateway) ran nothing.
        assert!(falls_back(&rejected(401, "invalid_api_key")));
        // A wallet refusal is the answer; Composio must not run it unpaid.
        assert!(!falls_back(&rejected(402, "insufficient_credits")));
        assert!(!falls_back(&rejected(503, "credit_accounting_unavailable")));
        assert!(!falls_back(&rejected(502, "provider_error")));
        assert!(!falls_back(&rejected(403, "invalid_api_key")));
        assert!(!falls_back(&Rejected {
            status: 409,
            body: "not json".to_owned()
        }));
    }

    #[test]
    fn a_successful_treg_answer_is_wrapped_as_routed() {
        let response = json!({ "ok": true, "status": 200, "chargedMicroUsd": 1100 });
        assert_eq!(
            served_envelope("SLUG", response.clone()).unwrap(),
            json!({ ROUTED_PROVIDER_KEY: "treg", "output": response })
        );
    }

    #[test]
    fn an_uncharged_upstream_failure_falls_back_to_composio() {
        for charged in [json!(null), json!(0)] {
            let response = json!({ "ok": false, "status": 502, "chargedMicroUsd": charged });
            assert!(matches!(
                served_envelope("SLUG", response),
                Err(Ok(Skip::UpstreamFailed))
            ));
        }
        // No `chargedMicroUsd` at all means nothing was charged either.
        assert!(matches!(
            served_envelope("SLUG", json!({ "ok": false, "status": 500 })),
            Err(Ok(Skip::UpstreamFailed))
        ));
        // A response that is not an object never counts as a success.
        assert!(matches!(
            served_envelope("SLUG", json!("oops")),
            Err(Ok(Skip::UpstreamFailed))
        ));
    }

    #[test]
    fn a_charged_upstream_failure_is_a_tool_error_and_is_not_retried() {
        let response = json!({ "ok": false, "status": 502, "chargedMicroUsd": 1100 });
        let Err(Err(error)) = served_envelope("SLUG", response) else {
            panic!("a charged failure is the call's answer");
        };
        let message = error.to_string();
        assert!(
            message.contains("SLUG via Treg failed upstream"),
            "{message}"
        );
        assert!(message.contains("502"), "{message}");
    }

    #[test]
    fn lookup_is_exact() {
        for entry in TABLE.values() {
            assert!(lookup(&entry.composio_slug).is_some());
            assert!(lookup(&entry.composio_slug.to_ascii_lowercase()).is_none());
        }
    }

    fn is_https(url: &str) -> bool {
        url.starts_with("https://") && url.len() > "https://".len()
    }

    /// Offline drift test: the checked-in table parses strictly and every entry
    /// is well formed, public-data only, and free of Treg catalog content.
    #[test]
    fn equivalents_table_is_well_formed_and_public_data_only() {
        let table = parse_table(TABLE_JSON).expect("the checked-in table parses");
        assert_eq!(
            table.len(),
            TABLE.len(),
            "the runtime table loaded every entry"
        );
        let slug_shape = regex::Regex::new(r"^[A-Z0-9]+(_[A-Z0-9]+)+$").unwrap();
        let mut endpoints = std::collections::HashSet::new();
        for (slug, entry) in &table {
            assert!(
                slug_shape.is_match(slug),
                "{slug}: not a Composio action slug"
            );
            assert!(
                PUBLIC_DATA_TOOLKITS.contains(&entry.composio_toolkit.as_str()),
                "{slug}: toolkit {} is not a reviewed public-data toolkit",
                entry.composio_toolkit
            );
            let toolkit_prefix = format!("{}_", entry.composio_toolkit.to_ascii_uppercase());
            assert!(
                slug.starts_with(&toolkit_prefix),
                "{slug}: toolkit mismatch"
            );
            assert_eq!(
                crate::catalog_source::integration_brand_slug(&entry.brand),
                entry.brand,
                "{slug}: brand is not a store brand id"
            );
            let id = &entry.treg_endpoint_id;
            assert!(
                !id.is_empty()
                    && !id.contains('/')
                    && !id.contains('\\')
                    && !id.chars().any(char::is_control),
                "{slug}: bad Treg endpoint id"
            );
            assert!(
                endpoints.insert(id.clone()),
                "{slug}: Treg endpoint mapped twice"
            );
            let mut names = std::collections::HashSet::new();
            for arg in &entry.args {
                assert!(
                    names.insert((arg.location, arg.treg.clone())),
                    "{slug}: {} twice",
                    arg.treg
                );
                if entry.method == HttpMethod::Get {
                    assert_eq!(arg.location, ArgLocation::Query, "{slug}: GET has no body");
                }
                if arg.kind == ArgType::String {
                    assert!(
                        arg.max_bytes.is_some(),
                        "{slug}: {} needs maxBytes",
                        arg.composio
                    );
                }
                if arg.kind == ArgType::StringEnum {
                    assert!(
                        !arg.values.is_empty(),
                        "{slug}: {} has no values",
                        arg.composio
                    );
                }
                if let (Some(min), Some(max)) = (arg.min, arg.max) {
                    assert!(min <= max, "{slug}: {} min > max", arg.composio);
                }
                if let Some(pattern) = &arg.pattern {
                    assert!(regex::Regex::new(pattern).is_ok(), "{slug}: bad pattern");
                }
            }
            for fixed in &entry.fixed {
                assert!(
                    !entry.args.iter().any(|arg| arg.treg == fixed.name),
                    "{slug}: fixed {} is also mapped",
                    fixed.name
                );
            }
            let provenance = &entry.provenance;
            assert!(is_https(&provenance.composio_docs), "{slug}: composio docs");
            assert!(is_https(&provenance.vendor_docs), "{slug}: vendor docs");
            for url in [&provenance.composio_docs, &provenance.vendor_docs] {
                assert!(
                    !url.contains("treg"),
                    "{slug}: cite public sources, not Treg"
                );
            }
            assert!(
                ryu_channel_contracts::capability_taxonomy::is_valid_iso_date(
                    &provenance.verified_on
                ),
                "{slug}: verifiedOn"
            );
        }
        // Clean room: none of Treg's own catalog content is in the file.
        let raw: Value = serde_json::from_str(TABLE_JSON).unwrap();
        fn forbidden_keys(value: &Value, found: &mut Vec<String>) {
            match value {
                Value::Object(object) => {
                    for (key, value) in object {
                        if matches!(
                            key.as_str(),
                            "price"
                                | "cost"
                                | "description"
                                | "summary"
                                | "alias"
                                | "aliases"
                                | "example"
                                | "examples"
                                | "params"
                                | "schema"
                        ) {
                            found.push(key.clone());
                        }
                        forbidden_keys(value, found);
                    }
                }
                Value::Array(items) => items.iter().for_each(|item| forbidden_keys(item, found)),
                _ => {}
            }
        }
        let mut found = Vec::new();
        forbidden_keys(&raw, &mut found);
        assert!(found.is_empty(), "catalog content in the table: {found:?}");
    }

    /// Live drift test against both catalogs. Run by hand or on a schedule:
    /// `RYU_TREG_EQUIV_LIVE=1 cargo test -p ryu-core composio_treg_route -- --ignored`.
    /// Treg: every endpoint is listed, fleet-servable and on the entry's brand.
    /// Composio (with `COMPOSIO_API_KEY`): every slug exists, every mapped
    /// argument is in its input schema and every required one is mapped.
    #[tokio::test]
    #[ignore = "reads the live Treg and Composio catalogs"]
    async fn equivalents_table_matches_the_live_catalogs() {
        if std::env::var("RYU_TREG_EQUIV_LIVE").is_err() {
            return;
        }
        let http = reqwest::Client::new();
        let treg =
            std::env::var("RYU_TREG_CATALOG_URL").unwrap_or_else(|_| "https://treg.to".to_owned());
        let composio_key = std::env::var("COMPOSIO_API_KEY").ok();
        let mut drift = Vec::new();
        for (slug, entry) in TABLE.iter() {
            let url = format!(
                "{}/catalog/endpoints/{}",
                treg.trim_end_matches('/'),
                urlencoding::encode(&entry.treg_endpoint_id)
            );
            match http.get(&url).send().await {
                Ok(response) if response.status().is_success() => {
                    let detail: Value = response.json().await.unwrap_or_default();
                    let endpoint = detail.get("endpoint").unwrap_or(&detail);
                    if endpoint.get("platform_eligible").and_then(Value::as_bool) == Some(false) {
                        drift.push(format!("{slug}: Treg marks the endpoint platform-blocked"));
                    }
                    if endpoint.get("scope").and_then(Value::as_str) == Some("own_account") {
                        drift.push(format!(
                            "{slug}: Treg scopes the endpoint to the caller's account"
                        ));
                    }
                    if crate::provider_pins::endpoint_brand(&detail).as_deref()
                        != Some(entry.brand.as_str())
                    {
                        drift.push(format!("{slug}: the endpoint's store brand changed"));
                    }
                }
                Ok(response) => drift.push(format!("{slug}: Treg answered {}", response.status())),
                Err(error) => drift.push(format!("{slug}: Treg unreachable: {error}")),
            }
            let Some(key) = composio_key.as_deref() else {
                continue;
            };
            let response = http
                .get(format!("https://backend.composio.dev/api/v3/tools/{slug}"))
                .header("x-api-key", key)
                .send()
                .await;
            let Ok(response) = response else {
                drift.push(format!("{slug}: Composio unreachable"));
                continue;
            };
            if !response.status().is_success() {
                drift.push(format!("{slug}: Composio answered {}", response.status()));
                continue;
            }
            let tool: Value = response.json().await.unwrap_or_default();
            let params = &tool["input_parameters"];
            let properties = params["properties"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            for arg in &entry.args {
                if !properties.contains_key(&arg.composio) {
                    drift.push(format!("{slug}: Composio no longer takes {}", arg.composio));
                }
            }
            for required in params["required"].as_array().into_iter().flatten() {
                let name = required.as_str().unwrap_or_default();
                if !entry.args.iter().any(|arg| arg.composio == name) {
                    drift.push(format!("{slug}: Composio now requires unmapped {name}"));
                }
            }
        }
        assert!(
            drift.is_empty(),
            "equivalents drifted:\n{}",
            drift.join("\n")
        );
    }
}
